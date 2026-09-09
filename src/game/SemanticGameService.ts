import { createHmac, randomUUID } from "node:crypto";
import type { NormalizedLiveEvent } from "../core/events.js";
import { SemanticEngine, type SemanticBucket } from "./SemanticEngine.js";
import type { SemanticGameGateway, SemanticGameMessage } from "./SemanticGameGateway.js";
import { HintWordClient, type HintContext } from "./HintWordClient.js";

type RoundStatus = "RUNNING" | "ANSWERED" | "SETTLEMENT" | "WAITING";
type PlayerTier = "青铜" | "白银" | "黄金" | "铂金" | "钻石" | "王者";
type GuessTrigger = "chat" | "like" | "gift";
type BonusWordSource = "hy3" | "local-fallback";

interface PlayerView {
  playerId: string;
  nickname: string;
  uniqueId?: string;
  avatarUrl?: string;
  score: number;
  guesses: number;
  tier: PlayerTier;
}

interface GuessView {
  guessId: string;
  playerId: string;
  nickname: string;
  uniqueId?: string;
  avatarUrl?: string;
  word: string;
  rank: number;
  displayScore: number;
  bucket: SemanticBucket;
  isCorrect: boolean;
  similarityMode: "exact" | "embedding" | "heuristic";
  tier: PlayerTier;
  scoreDelta: number;
  submittedAt: number;
  triggerType: GuessTrigger;
  previousWord?: string;
  bonusSource?: BonusWordSource;
}

interface RoundState {
  roundId: string;
  roundNo: number;
  status: RoundStatus;
  answer: string;
  answerCode: string;
  answerLength: number;
  startedAt: number;
  endsAt: number;
  answeredAt?: number;
  settleAt?: number;
  guesses: GuessView[];
  lastBonusWord?: string;
}

const ROUND_DURATION_MS = Number(process.env.SEMANTIC_ROUND_DURATION_MS ?? 240_000);
const SETTLEMENT_DURATION_MS = Number(process.env.SEMANTIC_SETTLEMENT_MS ?? 5_000);
const TICK_INTERVAL_MS = Number(process.env.SEMANTIC_TICK_INTERVAL_MS ?? 1_000);

export class SemanticGameService {
  private readonly engine = new SemanticEngine({ language: process.env.SEMANTIC_LANGUAGE ?? undefined });
  private readonly hintWordClient = new HintWordClient();
  private readonly players = new Map<string, PlayerView>();
  private readonly unlockedHints = new Map<number, Record<string, unknown>>();
  private round: RoundState;
  private roundNo = 0;
  private likesThisRound = 0;
  private totalLikes = 0;
  private viewerCount = 0;
  private hintsUnlocked = 0;
  private readonly timedHintStages = new Set<number>();
  private readonly bonusWordsThisRound = new Set<string>();
  private lastActivity?: SemanticGameMessage;
  private interval?: NodeJS.Timeout;
  private eventQueue: Promise<void> = Promise.resolve();
  private giftQueue: Promise<void> = Promise.resolve();

  constructor(private readonly gateway: SemanticGameGateway) {
    this.round = this.createRound();
  }

  start(): void {
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  snapshot(): SemanticGameMessage {
    return { type: "ROOM_SNAPSHOT", room: this.roomView(), round: this.roundView(), timeline: this.timelineView(), topGuesses: this.topGuesses(), scoreboard: this.scoreboard(), hintsUnlocked: this.hintsUnlocked, activity: this.lastActivity, metrics: this.metrics(), embedding: this.engine.embeddingStatus(), hintModel: this.hintWordClient.status() };
  }

  dictionaryStatus(): Record<string, unknown> {
    return { ...this.engine.dictionaryStatus(), hintModel: this.hintWordClient.status() };
  }

  resolveDictionaryWord(text: string, language?: string): Record<string, unknown> {
    const result = language ? this.engine.dictionary.resolve(text, language) : this.engine.resolve(text);
    if (result.status === "resolved") return { ...result, concept: { conceptId: result.concept.conceptId, category: result.concept.category, labels: result.concept.labels } };
    return result;
  }

  handleEvent(event: NormalizedLiveEvent): void {
    this.eventQueue = this.eventQueue.then(() => this.handleEventAsync(event)).catch(() => {
      this.gateway.broadcast({ type: "ROOM_ERROR", code: "EVENT_PROCESSING_FAILED", message: "互动事件处理失败，已跳过本条事件" });
    });
  }

  private async handleEventAsync(event: NormalizedLiveEvent): Promise<void> {
    switch (event.type) {
      case "chat": await this.handleChat(event); break;
      case "like": await this.handleLike(event); break;
      case "gift": this.handleGift(event); break;
      case "room_stats": this.handleRoomStats(event); break;
      case "join": case "follow": case "share": this.handleSocial(event); break;
      case "stream_end": this.broadcastActivity("直播结束，猜词房间等待下一次开播", event); break;
      default: break;
    }
  }

  private createRound(): RoundState {
    this.roundNo += 1;
    const configuredAnswer = this.engine.normalize(process.env.SEMANTIC_ANSWER ?? "");
    const answer = configuredAnswer && this.engine.answerPool.includes(configuredAnswer) ? configuredAnswer : this.engine.answerPool[(this.roundNo - 1) % this.engine.answerPool.length];
    const now = Date.now();
    const answerSecret = process.env.ANSWER_CODE_SECRET ?? "local-dev-answer-code";
    return { roundId: randomUUID(), roundNo: this.roundNo, status: "RUNNING", answer, answerCode: createHmac("sha256", answerSecret).update(answer).digest("hex").slice(0, 12), answerLength: answer.length, startedAt: now, endsAt: now + ROUND_DURATION_MS, guesses: [] };
  }

  private tick(): void {
    const now = Date.now();
    if (this.round.status === "RUNNING") this.updateTimedHints(now);
    if (this.round.status === "RUNNING" && now >= this.round.endsAt) {
      this.round.status = "ANSWERED";
      this.round.answeredAt = now;
      this.round.settleAt = now + SETTLEMENT_DURATION_MS;
      this.broadcast({ type: "ROUND_TIMEOUT", round: this.roundView(), topGuesses: this.topGuesses() });
    } else if (this.round.status === "ANSWERED" && this.round.settleAt && now >= this.round.settleAt) {
      this.settleRound();
    } else if (this.round.status === "SETTLEMENT" && this.round.settleAt && now >= this.round.settleAt) {
      this.startNextRound();
    }
    this.gateway.broadcast({ type: "TIMER_TICK", roundId: this.round.roundId, status: this.round.status, timeLeftMs: Math.max(0, this.round.endsAt - now), hintsUnlocked: this.hintsUnlocked, timeline: this.timelineView(now) });
  }

  private async handleChat(event: NormalizedLiveEvent): Promise<void> {
    if (this.round.status !== "RUNNING") return this.reject(event, "round_not_running");
    const rawText = typeof event.payload.text === "string" ? event.payload.text : typeof event.payload.content === "string" ? event.payload.content : typeof event.payload.commandText === "string" ? event.payload.commandText : "";
    const command = rawText.trim().toLowerCase();
    if (command === "!hint" || command === "/hint") return this.unlockHint("chat", event);
    if (command === "!skip" || command === "/skip") return this.skipRound(event);
    await this.submitGuess(event, rawText, "chat");
  }

  private async submitGuess(event: NormalizedLiveEvent, rawText: string, triggerType: GuessTrigger, previousWord?: string, bonusSource?: BonusWordSource): Promise<GuessView | undefined> {
    if (this.round.status !== "RUNNING") {
      this.reject(event, "round_not_running");
      return undefined;
    }
    const player = this.ensurePlayer(event);
    const now = Date.now();
    const validation = this.engine.validate(rawText);
    if (!validation.ok) {
      this.reject(event, validation.reason ?? "not_word");
      return undefined;
    }
    const roundId = this.round.roundId;
    const result = await this.engine.evaluateWithEmbedding(this.round.answer, validation.normalizedGuess);
    if (this.round.roundId !== roundId || this.round.status !== "RUNNING") {
      this.reject(event, "round_not_running");
      return undefined;
    }
    player.guesses += 1;
    const guess: GuessView = { guessId: randomUUID(), playerId: player.playerId, nickname: player.nickname, uniqueId: player.uniqueId, avatarUrl: player.avatarUrl, word: validation.normalizedGuess, rank: result.rank, displayScore: result.displayScore, bucket: result.bucket, isCorrect: result.isCorrect, similarityMode: result.similarityMode, tier: player.tier, scoreDelta: 0, submittedAt: now, triggerType, previousWord, bonusSource };
    this.round.guesses.push(guess);
    this.round.guesses.sort((a, b) => b.displayScore - a.displayScore || a.submittedAt - b.submittedAt);
    this.broadcast({ type: "GUESS_ACCEPTED", auto: triggerType !== "chat", triggerType, previousWord, round: this.roundView(), guess, topGuesses: this.topGuesses(), scoreboard: this.scoreboard(), metrics: this.metrics() });
    if (result.isCorrect) {
      this.round.status = "ANSWERED";
      this.round.answeredAt = now;
      this.round.settleAt = now + SETTLEMENT_DURATION_MS;
      this.broadcast({ type: "ROUND_ANSWERED", round: this.roundView(), winner: guess, topGuesses: this.topGuesses() });
    }
    return guess;
  }

  private async handleLike(event: NormalizedLiveEvent): Promise<void> {
    const count = Math.max(1, Number(event.payload.count ?? 1));
    this.likesThisRound += count;
    this.totalLikes = Math.max(this.totalLikes + count, Number(event.payload.totalLikes ?? 0));
    if (this.likesThisRound >= 1000 && this.hintsUnlocked < 3) this.unlockHint("likes", event);
    this.gateway.broadcast({ type: "ROOM_STATS", viewerCount: this.viewerCount, totalLikes: this.totalLikes, metrics: this.metrics(), hintsUnlocked: this.hintsUnlocked });
    await this.submitRandomWords(event, 1, "like", [], this.round.roundId);
  }

  private handleGift(event: NormalizedLiveEvent): void {
    if (this.hintsUnlocked < 4) this.unlockHint("gift", event);
    else {
      this.round.endsAt += 30_000;
      this.broadcastActivity(`${this.actorName(event)} 送出礼物，全场加时 30 秒`, event);
      this.broadcast({ type: "GIFT_EFFECT", effect: "EXTRA_TIME", seconds: 30, actor: this.actor(event), round: this.roundView() });
    }
    const rawValue = Number(event.payload.diamondCount ?? event.payload.count ?? 1);
    const giftValue = Number.isFinite(rawValue) ? Math.max(1, Math.floor(rawValue)) : 1;
    const wordCount = giftValue * 10;
    const expectedRoundId = this.round.roundId;
    const hints = this.llmHintContext();
    const phase = String(this.timelineView().phaseLabel ?? "探索期");
    this.broadcastActivity(`${this.actorName(event)} 送礼，正在让 hy3 根据 ${hints.length} 条提示生成 ${wordCount} 个随机词`, event);
    this.giftQueue = this.giftQueue.then(async () => {
      const modelWords = await this.generateGiftWords(wordCount, hints, phase);
      if (this.round.roundId !== expectedRoundId || this.round.status !== "RUNNING") return;
      if (modelWords.length === 0) {
        this.gateway.broadcast({ type: "ROOM_ERROR", code: "HY3_HINT_GENERATION_FAILED", message: "礼物已收到，但 hy3 没有返回可用随机词；本次未使用本地词库补足", source: "hy3", requestedCount: wordCount, generatedCount: 0 });
        this.broadcastActivity(`${this.actorName(event)} 送礼，但 hy3 未返回有效随机词，本次未使用本地词库补足`, event);
        return;
      }
      if (modelWords.length < wordCount) {
        this.gateway.broadcast({ type: "ROOM_ERROR", code: "HY3_HINT_GENERATION_PARTIAL", message: `hy3 只返回了 ${modelWords.length}/${wordCount} 个随机词，本次不使用本地词库补足`, source: "hy3", requestedCount: wordCount, generatedCount: modelWords.length });
      }
      this.broadcastActivity(`${this.actorName(event)} 送礼，hy3 已生成 ${modelWords.length}/${wordCount} 个随机词`, event);
      await this.submitRandomWords(event, modelWords.length, "gift", modelWords, expectedRoundId);
    }).catch(() => {
      // Keep later gifts alive if an unexpected integration error escapes the client.
    });
  }

  private async generateGiftWords(count: number, hints: HintContext[], phase: string): Promise<string[]> {
    const words: string[] = [];
    const maxBatches = 3;
    for (let batch = 0; batch < maxBatches && words.length < count; batch += 1) {
      const remaining = count - words.length;
      const generated = await this.hintWordClient.generateWords({
        count: remaining,
        language: this.engine.language,
        hints,
        phase,
        excludeWords: [...this.bonusWordsThisRound, ...words],
      });
      for (const rawWord of generated) {
        const word = this.engine.normalize(rawWord);
        if (!this.engine.validate(word).ok || word === this.round.answer || this.bonusWordsThisRound.has(word) || words.includes(word)) continue;
        words.push(word);
        if (words.length >= count) break;
      }
      if (generated.length === 0) break;
    }
    return words;
  }

  private async submitRandomWords(event: NormalizedLiveEvent, count: number, triggerType: Exclude<GuessTrigger, "chat">, modelWords: string[] = [], expectedRoundId?: string): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      if (this.round.status !== "RUNNING" || (expectedRoundId && this.round.roundId !== expectedRoundId)) return;
      const previousWord = this.round.lastBonusWord;
      // Bonus words enrich the ranking but never auto-reveal the answer; the
      // winner still needs to come from a real chat guess.
      const modelCandidate = modelWords[index];
      const normalizedModelCandidate = modelCandidate ? this.engine.normalize(modelCandidate) : "";
      let candidate = normalizedModelCandidate && normalizedModelCandidate !== this.round.answer && this.engine.validate(normalizedModelCandidate).ok && !this.bonusWordsThisRound.has(normalizedModelCandidate)
        ? normalizedModelCandidate
        : "";
      let bonusSource: BonusWordSource = "hy3";
      if (!candidate && triggerType !== "gift") {
        bonusSource = "local-fallback";
        for (let attempt = 0; !candidate && attempt < 30; attempt += 1) {
          const localCandidate = this.engine.randomCandidate(this.round.answer);
          if (!this.bonusWordsThisRound.has(localCandidate)) candidate = localCandidate;
        }
        candidate ||= this.engine.randomCandidate(this.round.answer);
      }
      if (!candidate) continue;
      this.bonusWordsThisRound.add(candidate);
      const guess = await this.submitGuess(event, candidate, triggerType, previousWord, bonusSource);
      if (!guess) continue;
      this.round.lastBonusWord = guess.word;
      const triggerLabel = triggerType === "gift" ? "礼物随机词" : "点赞随机词";
      this.broadcastActivity(`${this.actorName(event)} 触发${triggerLabel}：${guess.word}${previousWord ? ` · 上一词：${previousWord}` : ""}`, event);
      if (guess.isCorrect) return;
    }
  }

  private handleRoomStats(event: NormalizedLiveEvent): void {
    if (typeof event.payload.viewerCount === "number") this.viewerCount = event.payload.viewerCount;
    if (typeof event.payload.totalLikes === "number") this.totalLikes = event.payload.totalLikes;
    this.gateway.broadcast({ type: "ROOM_STATS", viewerCount: this.viewerCount, totalLikes: this.totalLikes });
  }

  private handleSocial(event: NormalizedLiveEvent): void {
    const label = event.type === "join" ? "进入直播间" : event.type === "follow" ? "关注了直播间" : "分享了直播间";
    this.broadcastActivity(`${this.actorName(event)} ${label}`, event);
  }

  private unlockHint(triggerType: string, event?: NormalizedLiveEvent, customHint?: Record<string, unknown>): void {
    if (this.hintsUnlocked >= 4) return;
    this.hintsUnlocked += 1;
    const hint = customHint ?? this.hintView();
    this.unlockedHints.set(this.hintsUnlocked, hint);
    this.broadcast({ type: "HINT_UNLOCKED", level: this.hintsUnlocked, triggerType, hint, actor: event ? this.actor(event) : { id: "system", nickname: "系统提示" }, round: this.roundView(), timeline: this.timelineView() });
  }

  private skipRound(event: NormalizedLiveEvent): void {
    this.broadcastActivity(`${this.actorName(event)} 请求跳过本轮`, event);
    this.round.status = "ANSWERED";
    this.round.answeredAt = Date.now();
    this.round.settleAt = Date.now() + SETTLEMENT_DURATION_MS;
    this.broadcast({ type: "ROUND_SKIPPED", round: this.roundView() });
  }

  private settleRound(): void {
    if (this.round.status === "SETTLEMENT" && this.round.settleAt && Date.now() < this.round.settleAt) return;
    const winner = this.round.guesses.find((guess) => guess.isCorrect);
    const assistants = this.round.guesses.filter((guess) => !guess.isCorrect).slice(0, 2);
    const awards: Array<{ playerId: string; nickname: string; reason: string; delta: number }> = [];
    if (winner) awards.push({ playerId: winner.playerId, nickname: winner.nickname, reason: "猜中答案", delta: 150 });
    assistants.forEach((guess, index) => awards.push({ playerId: guess.playerId, nickname: guess.nickname, reason: `相似度第 ${index + 2}`, delta: index === 0 ? 100 : 50 }));
    const roundActivity = new Map<string, number>();
    for (const guess of this.round.guesses) roundActivity.set(guess.playerId, (roundActivity.get(guess.playerId) ?? 0) + 1);
    const mostActivePlayerId = [...roundActivity.entries()].sort(([, countA], [, countB]) => countB - countA)[0]?.[0];
    const mostActive = mostActivePlayerId ? this.players.get(mostActivePlayerId) : undefined;
    if (mostActive && !awards.some((award) => award.playerId === mostActive.playerId)) awards.push({ playerId: mostActive.playerId, nickname: mostActive.nickname, reason: "最佳助攻", delta: 50 });
    for (const award of awards) {
      const player = this.players.get(award.playerId);
      if (player) player.score += award.delta;
      const guess = this.round.guesses.find((item) => item.playerId === award.playerId);
      if (guess) guess.scoreDelta += award.delta;
    }
    const awardViews = awards.map((award) => {
      const player = this.players.get(award.playerId);
      const context = this.rankContext(award.playerId);
      return { ...award, avatarUrl: player?.avatarUrl, uniqueId: player?.uniqueId, tier: player ? tierForScore(player.score) : "青铜", currentScore: context.currentScore, currentRank: context.currentRank, pointsToSurpass: context.pointsToSurpass };
    });
    const winnerAward = winner ? awards.find((award) => award.playerId === winner.playerId) : undefined;
    const winnerContext = winner ? this.rankContext(winner.playerId) : undefined;
    const winnerSummary = winner && winnerContext ? { ...winner, scoreDelta: winnerAward?.delta ?? winner.scoreDelta, currentScore: winnerContext.currentScore, currentRank: winnerContext.currentRank, pointsToSurpass: winnerContext.pointsToSurpass, tier: tierForScore(winnerContext.currentScore) } : undefined;
    this.round.status = "SETTLEMENT";
    this.round.settleAt = Date.now() + SETTLEMENT_DURATION_MS;
    this.broadcast({ type: "ROUND_SETTLED", round: this.roundView(), winner: winnerSummary, awards: awardViews, topGuesses: this.topGuesses(), scoreboard: this.scoreboard() });
  }

  private startNextRound(): void {
    this.round = this.createRound();
    this.likesThisRound = 0;
    this.hintsUnlocked = 0;
    this.unlockedHints.clear();
    this.bonusWordsThisRound.clear();
    this.timedHintStages.clear();
    this.broadcast({ type: "ROUND_STARTED", round: this.roundView(), hintsUnlocked: 0 });
  }

  private ensurePlayer(event: NormalizedLiveEvent): PlayerView {
    const playerId = event.user?.id ?? event.user?.uniqueId ?? event.user?.nickname ?? "anonymous";
    const existing = this.players.get(playerId);
    if (existing) return existing;
    const player: PlayerView = { playerId, nickname: event.user?.nickname ?? event.user?.uniqueId ?? "直播间玩家", uniqueId: event.user?.uniqueId, avatarUrl: event.user?.avatarUrl, score: 0, guesses: 0, tier: "青铜" };
    this.players.set(playerId, player);
    return player;
  }

  private reject(event: NormalizedLiveEvent, reason: string): void {
    this.gateway.broadcast({ type: "GUESS_REJECTED", reason, actor: this.actor(event) });
  }

  private broadcast(message: SemanticGameMessage): void {
    this.lastActivity = message;
    this.gateway.broadcast(message);
  }

  private broadcastActivity(text: string, event: NormalizedLiveEvent): void {
    this.broadcast({ type: "ACTIVITY", text, actor: this.actor(event), timestamp: Date.now() });
  }

  private actor(event: NormalizedLiveEvent): Record<string, unknown> {
    return { id: event.user?.id, uniqueId: event.user?.uniqueId, nickname: event.user?.nickname ?? event.user?.uniqueId ?? "直播间玩家", avatarUrl: event.user?.avatarUrl };
  }

  private actorName(event: NormalizedLiveEvent): string {
    return String(event.user?.nickname ?? event.user?.uniqueId ?? "直播间玩家");
  }

  private roomView(): Record<string, unknown> {
    return { roomId: "local-live-room", status: "RUNNING", language: this.engine.language, wordlistId: this.engine.dictionary.snapshot.wordlistId, dictionary: this.engine.dictionaryStatus(), viewerCount: this.viewerCount, totalLikes: this.totalLikes };
  }

  private roundView(): Record<string, unknown> {
    return { roundId: this.round.roundId, roundNo: this.round.roundNo, status: this.round.status, answerCode: this.round.answerCode, answerLength: this.round.answerLength, startedAt: this.round.startedAt, endsAt: this.round.endsAt, answeredAt: this.round.answeredAt, settleAt: this.round.settleAt };
  }

  private timelineView(now = Date.now()): Record<string, unknown> {
    const duration = Math.max(1, this.round.endsAt - this.round.startedAt);
    const progress = Math.max(0, Math.min(1, (now - this.round.startedAt) / duration));
    const phaseIndex = progress < 0.25 ? 0 : progress < 0.5 ? 1 : progress < 0.75 ? 2 : 3;
    const phases = [
      { label: "探索期", hint: "先积累猜词，观察关联方向" },
      { label: "线索期", hint: "25%：系统会提示词汇类型" },
      { label: "锁定期", hint: "50%：系统会提示首字母" },
      { label: "冲刺期", hint: "75%：系统会提示词语长度" },
    ];
    return { progress, phaseIndex, phaseLabel: phases[phaseIndex].label, phaseHint: phases[phaseIndex].hint, elapsedMs: Math.max(0, now - this.round.startedAt), remainingMs: Math.max(0, this.round.endsAt - now) };
  }

  private updateTimedHints(now: number): void {
    const progress = Number(this.timelineView(now).progress);
    const unlockedStages = progress >= 0.75 ? 3 : progress >= 0.5 ? 2 : progress >= 0.25 ? 1 : 0;
    for (let stage = 1; stage <= unlockedStages; stage += 1) {
      if (this.timedHintStages.has(stage)) continue;
      this.timedHintStages.add(stage);
      this.unlockHint("timer", undefined, this.timedHintView(stage));
    }
  }

  private timedHintView(stage: number): Record<string, unknown> {
    if (stage === 1) return { label: "词汇类型", value: this.engine.themeFor(this.round.answer) };
    if (stage === 2) return { label: "首字母", value: this.round.answer[0].toUpperCase() };
    return { label: "词语长度", value: `${this.round.answerLength} 个字母` };
  }

  private topGuesses(): GuessView[] {
    return this.round.guesses.slice(0, 14);
  }

  private scoreboard(): PlayerView[] {
    return this.rankedPlayers().slice(0, 20);
  }

  private rankedPlayers(): PlayerView[] {
    return [...this.players.values()].sort((a, b) => b.score - a.score || b.guesses - a.guesses).map((player) => ({ ...player, tier: tierForScore(player.score) }));
  }

  private rankContext(playerId: string): { currentScore: number; currentRank: number; pointsToSurpass: number } {
    const ranked = this.rankedPlayers();
    const index = ranked.findIndex((player) => player.playerId === playerId);
    const currentScore = this.players.get(playerId)?.score ?? 0;
    const previous = index > 0 ? ranked[index - 1] : undefined;
    return { currentScore, currentRank: index >= 0 ? index + 1 : ranked.length + 1, pointsToSurpass: previous ? Math.max(0, previous.score - currentScore + 1) : 0 };
  }

  private hintView(): Record<string, unknown> {
    const hints = [
      { label: "词性", value: "常见英文名词或动词" },
      { label: "首字母", value: this.round.answer[0].toUpperCase() },
      { label: "主题", value: this.round.answer.length <= 5 ? "日常高频词" : "直播常见主题" },
      { label: "长度", value: `${this.round.answerLength} 个字母` },
    ];
    return hints[this.hintsUnlocked - 1] ?? hints[0];
  }

  private llmHintContext(): HintContext[] {
    return [...this.unlockedHints.values()].map((hint) => ({
      label: String(hint.label ?? "系统提示"),
      value: String(hint.value ?? ""),
    })).filter((hint) => hint.value.length > 0);
  }

  private metrics(): Record<string, number> {
    const validGuesses = this.round.guesses.length;
    const uniqueGuessers = new Set(this.round.guesses.map((guess) => guess.playerId)).size;
    return { validGuesses, uniqueGuessers, likesThisRound: this.likesThisRound, timeToAnswerMs: this.round.answeredAt ? this.round.answeredAt - this.round.startedAt : 0 };
  }
}

function tierForScore(score: number): PlayerTier {
  if (score >= 2000) return "王者";
  if (score >= 1000) return "钻石";
  if (score >= 600) return "铂金";
  if (score >= 300) return "黄金";
  if (score >= 100) return "白银";
  return "青铜";
}
