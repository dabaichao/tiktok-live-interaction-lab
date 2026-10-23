import { createHmac, randomUUID, randomBytes } from "node:crypto";
import type { AdminConfigService } from "../admin/AdminConfigService.js";
import type { NormalizedLiveEvent } from "../core/events.js";
import type { ConceptDictionary } from "../dictionary/ConceptDictionary.js";
import { SemanticEngine, type SemanticBucket } from "./SemanticEngine.js";
import type { SemanticGameGateway, SemanticGameMessage } from "./SemanticGameGateway.js";
import { HintWordClient, type HintContext } from "./HintWordClient.js";
import { guessCharacterCount } from "./GuessRules.js";
import type { InteractionPlan } from "./InteractionRules.js";

export interface ManagedGameOptions {
  presentation: () => {timedHints:boolean;directionHint:string;winnerPoints:number;secondPoints:number;thirdPoints:number;assistPoints:number};
  carryGiftWords?: boolean;
  useReviewedDefinitions?: boolean;
}
export interface InteractionProgress {
  status:"queued"|"running"|"completed"|"partial"|"cancelled"|"failed"|"display-only";
  completedWords:number;aiWords:number;localWords:number;appliedTimeMs:number;unlockedHints:number;message:string;
  carriedRounds?: number; remainingWords?: number; waitingForRound?: boolean; currentRoundNo?: number;
}

type RoundStatus = "RUNNING" | "ANSWERED" | "SETTLEMENT" | "WAITING";
type PlayerTier = "青铜" | "白银" | "黄金" | "铂金" | "钻石" | "王者";
type GuessTrigger = "chat" | "like" | "gift" | "follow" | "share";
type BonusWordSource = "llm" | "local-fallback";

interface PlayerView {
  playerId: string;
  nickname: string;
  uniqueId?: string;
  avatarUrl?: string;
  identityLimited?: boolean;
  nicknameMasked?: boolean;
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
  identityLimited?: boolean;
  nicknameMasked?: boolean;
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
  validGuesses: number;
  participants: Map<string, { count: number; best: GuessView }>;
  winner?: GuessView;
  lastBonusWord?: string;
}

export class SemanticGameService {
  private engine: SemanticEngine;
  private hintWordClient: HintWordClient;
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
  private lastSettlement?: SemanticGameMessage;
  private interval?: NodeJS.Timeout;
  private eventQueue: Promise<void> = Promise.resolve();
  private giftQueue: Promise<void> = Promise.resolve();
  private interactionQueue: Promise<void> = Promise.resolve();
  private modelInteractionQueue: Promise<void> = Promise.resolve();
  private pausedAt?: number;
  private generation = 0;
  private interactionEpoch = 0;
  private readonly roundWaiters = new Set<() => void>();
  private readonly activeInteractions = new Map<string,{queuedAt:number;startedAt?:number;stage:"queued"|"running"|"waiting-round";source:"llm"|"local";remainingWords:number}>();
  private readonly answerSecret = process.env.ANSWER_CODE_SECRET || randomBytes(32).toString("hex");

  constructor(private readonly gateway: SemanticGameGateway, private readonly adminConfig: AdminConfigService, dictionary?: ConceptDictionary, private readonly managed?: ManagedGameOptions) {
    const config = adminConfig.current;
    this.engine = new SemanticEngine({ dictionary, language: config.game.language, baseUrl: config.embedding.baseUrl, model: config.embedding.model, timeoutMs: config.embedding.timeoutMs, apiKey: process.env.EMBEDDING_API_KEY, useReviewedDefinitions: this.managed?.useReviewedDefinitions });
    this.hintWordClient = new HintWordClient({ baseUrl: config.llm.baseUrl, routingMode: config.llm.routingMode, preferredModel: config.llm.preferredModel, fallbackModels: config.llm.fallbackModels, fixedModel: config.llm.fixedModel, timeoutMs: config.llm.timeoutMs, apiKey: process.env.HINT_LLM_API_KEY, hy3LowReasoning: Boolean(this.managed), maxOutputTokens: this.managed ? 6000 : undefined });
    this.round = this.createRound();
  }

  start(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), this.adminConfig.current.game.tickIntervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.invalidateInteractions();
  }

  restartRound(): SemanticGameMessage {
    this.invalidateInteractions();
    this.pausedAt = undefined;
    this.startNextRound();
    return this.snapshot();
  }

  resetRoom(): void {
    this.generation++;
    this.players.clear();this.totalLikes=0;this.viewerCount=0;this.lastSettlement=undefined;this.lastActivity=undefined;this.roundNo=0;
    this.restartRound();this.gateway.broadcast(this.snapshot());
  }

  invalidateInteractions():void {
    this.generation++;this.interactionEpoch++;
    this.wakeRoundWaiters();
  }
  private wakeRoundWaiters():void {for(const wake of this.roundWaiters)wake();this.roundWaiters.clear();}
  interactionDiagnostics() {
    const jobs=[...this.activeInteractions.values()],now=Date.now();
    return {pendingJobs:jobs.length,queuedJobs:jobs.filter(j=>j.stage==="queued").length,runningJobs:jobs.filter(j=>j.stage==="running").length,waitingForRound:jobs.filter(j=>j.stage==="waiting-round").length,modelJobs:jobs.filter(j=>j.source==="llm").length,remainingWords:jobs.reduce((sum,j)=>sum+j.remainingWords,0),oldestPendingMs:jobs.reduce((max,j)=>Math.max(max,now-j.queuedAt),0),oldestQueuedMs:jobs.reduce((max,j)=>j.stage==="queued"?Math.max(max,now-j.queuedAt):max,0)};
  }

  reconfigure(dictionary?:ConceptDictionary):void {
    const config=this.adminConfig.current;
    this.engine=new SemanticEngine({dictionary,language:config.game.language,baseUrl:config.embedding.baseUrl,model:config.embedding.model,timeoutMs:config.embedding.timeoutMs,apiKey:process.env.EMBEDDING_API_KEY,useReviewedDefinitions:this.managed?.useReviewedDefinitions});
    this.hintWordClient=new HintWordClient({baseUrl:config.llm.baseUrl,routingMode:config.llm.routingMode,preferredModel:config.llm.preferredModel,fallbackModels:config.llm.fallbackModels,fixedModel:config.llm.fixedModel,timeoutMs:config.llm.timeoutMs,apiKey:process.env.HINT_LLM_API_KEY,hy3LowReasoning:Boolean(this.managed),maxOutputTokens:this.managed?6000:undefined});
    this.generation++;this.restartRound();this.start();this.gateway.broadcast(this.snapshot());
  }

  control(action:"start"|"pause"|"resume"|"next"):SemanticGameMessage {
    if(action==="start" || action==="next") this.restartRound();
    if(action==="pause" && this.pausedAt===undefined) {this.pausedAt=Date.now();this.invalidateInteractions();}
    if(action==="resume" && this.pausedAt!==undefined) {
      const delta=Date.now()-this.pausedAt;this.round.startedAt+=delta;this.round.endsAt+=delta;
      if(this.round.answeredAt)this.round.answeredAt+=delta;if(this.round.settleAt)this.round.settleAt+=delta;this.pausedAt=undefined;
    }
    const state=this.snapshot();this.gateway.broadcast(state);return state;
  }

  applyInteraction(event:NormalizedLiveEvent,plan:InteractionPlan,update:(progress:InteractionProgress)=>void):Promise<void> {
    const progress:InteractionProgress={status:"queued",completedWords:0,aiWords:0,localWords:0,appliedTimeMs:0,unlockedHints:0,message:plan.note};
    const roundId=this.round.roundId, generation=this.generation;
    const epoch=this.interactionEpoch;
    const carry=event.type==="gift" && this.managed?.carryGiftWords===true;
    const alive=()=>this.interactionEpoch===epoch && this.pausedAt===undefined;
    const valid=()=>alive() && this.generation===generation && this.round.roundId===roundId && this.round.status==="RUNNING";
    const playable=()=>alive() && this.round.status==="RUNNING";
    if(event.type==="gift") this.gateway.broadcast({type:"GIFT_RECEIVED",eventId:event.eventId,actor:this.actor(event),gift:{id:event.payload.giftId,name:event.payload.giftName,icon:event.payload.giftIcon,count:plan.quantity,diamondCount:event.payload.diamondCount,totalValue:plan.totalValue},roundId});
    if(event.type==="like") {const count=Math.max(1,Number(event.payload.count)||1);this.likesThisRound+=count;this.totalLikes+=count;this.gateway.broadcast({type:"ROOM_STATS",totalLikes:this.totalLikes,metrics:this.metrics()});}
    if(!valid() && !(carry && alive() && plan.randomWords>0)) {update({...progress,status:"cancelled",message:"游戏已暂停或不在猜词阶段，效果未执行。"});return Promise.resolve();}
    if(valid()) {
      if(plan.extraTimeMs) {this.round.endsAt+=plan.extraTimeMs;progress.appliedTimeMs=plan.extraTimeMs;this.broadcast({type:"GIFT_EFFECT",effect:"EXTRA_TIME",triggerType:event.type,seconds:plan.extraTimeMs/1000,actor:this.actor(event),round:this.roundView()});}
      for(let i=0;i<Math.min(4,plan.hints)&&this.hintsUnlocked<4;i++) {this.unlockHint(event.type,event);progress.unlockedHints++;}
    } else if(plan.extraTimeMs||plan.hints) progress.message="结算期间只保留礼物词次数；本局加时/提示未执行，不自动重复到下一局。";
    if(!plan.randomWords) {update({...progress,status:plan.extraTimeMs||plan.hints?"completed":"display-only"});return Promise.resolve();}
    const jobId=randomUUID();
    const jobState={queuedAt:Date.now(),startedAt:undefined as number|undefined,stage:"queued" as "queued"|"running"|"waiting-round",source:plan.wordSource,remainingWords:plan.randomWords};
    this.activeInteractions.set(jobId,jobState);
    let previousRound=roundId;
    progress.carriedRounds=0;
    const report=(status:InteractionProgress["status"],message=progress.message)=>{
      progress.remainingWords=plan.randomWords-progress.completedWords;
      jobState.remainingWords=progress.remainingWords;
      update({...progress,status,message,waitingForRound:status==="running" && jobState.stage==="waiting-round",currentRoundNo:this.round.roundNo});
    };
    report("queued");
    const waitForRound=async()=>{
      while(carry && alive() && !playable()) {
        jobState.stage="waiting-round";
        report("running","本局已结束，礼物剩余次数保留，等待下一局按新线索生成。");
        await new Promise<void>(resolve=>this.roundWaiters.add(resolve));
      }
      if(!(carry?playable():valid()))return false;
      if(this.round.roundId!==previousRound) {progress.carriedRounds!++;previousRound=this.round.roundId;}
      jobState.stage="running";
      report("running",progress.carriedRounds?"礼物剩余次数正在下一局按新线索继续执行。":progress.message);
      return true;
    };
    const execute=async()=>{
      jobState.startedAt=Date.now();
      let noProgress=0;
      while(progress.completedWords<plan.randomWords && await waitForRound()) {
        const activeRound=this.round.roundId;
        const batch=Math.min(this.adminConfig.current.llm.batchSize,plan.randomWords-progress.completedWords,100);
        const hints=this.llmHintContext();const phase=String(this.timelineView().phaseLabel??"");
        let words:string[]=[],fallbackWords:string[]=[];
        if(plan.wordSource==="llm") {
          words=await this.generateGiftWords(batch,hints,phase,activeRound);
          if(playable() && this.round.roundId===activeRound && words.length<batch && this.adminConfig.current.game.allowLocalGiftFallback) fallbackWords=this.localFallbackWords(batch-words.length,words);
        }
        if(!alive())break;
        // Never submit an old round's output against a new answer.
        if(this.round.roundId!==activeRound || !playable()) {if(carry)continue;break;}
        if(plan.wordSource==="llm" && !words.length && !fallbackWords.length) {progress.message=`${this.hintWordClient.status().lastError || "模型仅生成部分有效词或无有效词"}；剩余数量已记录，不伪造生成成功。`;break;}
        const before=progress.completedWords;
        const trigger:Exclude<GuessTrigger,"chat">=event.type==="gift"?"gift":event.type==="follow"?"follow":event.type==="share"?"share":"like";
        const delivered=(source:"ai"|"local")=>{
          if(source==="ai")progress.aiWords++;else progress.localWords++;
          progress.completedWords=progress.aiWords+progress.localWords;
          if(event.type==="gift")report("running");
        };
        if(plan.wordSource==="llm") {
          await this.submitRandomWords(event,words.length,trigger,words,activeRound,"llm",false,true,()=>delivered("ai"));
          if(alive() && playable() && this.round.roundId===activeRound && fallbackWords.length) await this.submitRandomWords(event,fallbackWords.length,trigger,fallbackWords,activeRound,"local-fallback",false,true,()=>delivered("local"));
        } else await this.submitRandomWords(event,batch,trigger,[],activeRound,"local-fallback",true,true,()=>delivered("local"));
        progress.completedWords=progress.aiWords+progress.localWords;
        report("running");
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(!alive())break;
        if(carry && (!playable()||this.round.roundId!==activeRound))continue;
        // Refill ACTUAL delivery deficits, including candidates consumed by likes.
        // Stop repeated no-progress output; do not loop paid requests forever.
        noProgress=progress.completedWords===before?noProgress+1:0;
        if(noProgress>=2){progress.message="连续补词仍无可投递词，未完成次数已记录；未使用本地词冒充AI。";break;}
      }
      const status=progress.completedWords===plan.randomWords?"completed":!(carry?alive():valid())?"cancelled":progress.completedWords?"partial":"failed";
      report(status,status==="cancelled"?"采集已停止、切房、手动切题或暂停，剩余词汇已取消。":status==="completed"?progress.localWords&&plan.wordSource==="llm"?"执行完成，包含已启用的本地补足":"执行完成":progress.message||"可用词不足，未完成次数已记录。");
    };
    // A slow remote model must not hold local likes behind a gift request.
    const queue=plan.wordSource==="llm"?this.modelInteractionQueue:this.interactionQueue;
    const job=queue.then(execute).catch(()=>report("failed","互动效果处理失败，未完成次数已记录，后续事件仍可继续执行。")).finally(()=>this.activeInteractions.delete(jobId));
    if(plan.wordSource==="llm")this.modelInteractionQueue=job;else this.interactionQueue=job;
    return job;
  }

  snapshot(): SemanticGameMessage {
    return { type: "ROOM_SNAPSHOT", room: this.roomView(), round: this.roundView(), timeline: this.timelineView(), topGuesses: this.topGuesses(), scoreboard: this.scoreboard(), hintsUnlocked: this.hintsUnlocked, lastSettlement: this.lastSettlement, activity: this.lastActivity, metrics: this.metrics(), embedding: this.engine.embeddingStatus(), hintModel: this.hintWordClient.status() };
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
    const generation=this.generation;
    // Immediate gift exposure must not wait behind embedding or word generation.
    if (event.type === "gift") {
      const count = Math.max(1, Number(event.payload.count) || 1);
      const diamondCount = Math.max(0, Number(event.payload.diamondCount) || 0);
      this.gateway.broadcast({ type: "GIFT_RECEIVED", eventId: event.eventId, actor: event.user ?? {}, gift: { id: event.payload.giftId, name: event.payload.giftName ?? "礼物", icon: event.payload.giftIcon, count, diamondCount, totalValue: diamondCount * count }, roundId: this.round.roundId });
    }
    this.eventQueue = this.eventQueue.then(() => generation===this.generation && this.pausedAt===undefined ? this.handleEventAsync(event) : undefined).catch(() => {
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
    const configuredAnswer = this.engine.normalize(this.adminConfig.current.game.answer);
    const answer = configuredAnswer && this.engine.answerPool.includes(configuredAnswer) ? configuredAnswer : this.engine.answerPool[(this.roundNo - 1) % this.engine.answerPool.length];
    const now = Date.now();
    if (!answer) throw new Error("当前题库在所选语言下没有可用题目，请选择包含题目的词库。");
    const roundId=randomUUID();
    return { roundId, roundNo: this.roundNo, status: "RUNNING", answer, answerCode: createHmac("sha256", this.answerSecret).update(`${roundId}:${answer}`).digest("hex").slice(0, 12), answerLength: guessCharacterCount(answer), startedAt: now, endsAt: now + this.adminConfig.current.game.roundDurationMs, guesses: [], validGuesses: 0, participants: new Map() };
  }

  private tick(): void {
    if(this.pausedAt!==undefined) {this.gateway.broadcast({type:"TIMER_TICK",roundId:this.round.roundId,status:"PAUSED",timeLeftMs:Math.max(0,this.round.endsAt-this.pausedAt),timeline:this.timelineView(this.pausedAt)});return;}
    const now = Date.now();
    if (this.round.status === "RUNNING") this.updateTimedHints(now);
    if (this.round.status === "RUNNING" && now >= this.round.endsAt) {
      this.round.status = "ANSWERED";
      this.round.answeredAt = now;
      this.round.settleAt = now + this.adminConfig.current.game.settlementDurationMs;
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
    if (this.round.status !== "RUNNING" || this.pausedAt!==undefined) {
      this.reject(event, "round_not_running");
      return undefined;
    }
    const now = Date.now();
    const validation = this.engine.validate(rawText, this.round.answerLength);
    if (!validation.ok) {
      this.reject(event, validation.reason ?? "not_word");
      return undefined;
    }
    if (!this.adminConfig.current.game.allowUnknownInputs) {
      const resolution = this.engine.resolve(validation.normalizedGuess);
      if (resolution.status !== "resolved") {
        this.reject(event, resolution.status === "ambiguous" ? "ambiguous_word" : "unknown_word");
        return undefined;
      }
    }
    const roundId = this.round.roundId, generation = this.generation;
    const result = await this.engine.evaluateWithEmbedding(this.round.answer, validation.normalizedGuess);
    if (this.generation !== generation || this.round.roundId !== roundId || this.round.status !== "RUNNING" || this.pausedAt!==undefined) {
      this.reject(event, "round_not_running");
      return undefined;
    }
    const player = this.ensurePlayer(event);
    player.guesses += 1;
    const guess: GuessView = { guessId: randomUUID(), playerId: player.playerId, nickname: player.nickname, uniqueId: player.uniqueId, avatarUrl: player.avatarUrl, identityLimited: player.identityLimited, nicknameMasked: player.nicknameMasked, word: validation.normalizedGuess, rank: result.rank, displayScore: result.displayScore, bucket: result.bucket, isCorrect: result.isCorrect, similarityMode: result.similarityMode, tier: player.tier, scoreDelta: 0, submittedAt: now, triggerType, previousWord, bonusSource };
    this.round.validGuesses++;
    const participant = this.round.participants.get(player.playerId);
    this.round.participants.set(player.playerId, {
      count: (participant?.count ?? 0) + 1,
      best: !participant || compareGuesses(guess, participant.best) < 0 ? guess : participant.best,
    });
    // Process every guess; only the on-screen ranking is deduplicated/bounded.
    // Repeated likes/chat must not retain an unlimited per-round history.
    if (!this.round.guesses.some(item => item.playerId === guess.playerId && item.word === guess.word)) {
      this.round.guesses.push(guess);
      this.round.guesses.sort(compareGuesses);
      this.round.guesses.length = Math.min(14, this.round.guesses.length);
    }
    this.broadcast({ type: "GUESS_ACCEPTED", auto: triggerType !== "chat", triggerType, previousWord, round: this.roundView(), guess, topGuesses: this.topGuesses(), scoreboard: this.scoreboard(), metrics: this.metrics() });
    if (result.isCorrect) {
      this.round.winner = guess;
      this.round.status = "ANSWERED";
      this.round.answeredAt = now;
      this.round.settleAt = now + this.adminConfig.current.game.settlementDurationMs;
      this.broadcast({ type: "ROUND_ANSWERED", round: this.roundView(), winner: { ...guess, pendingReward: this.managed?.presentation().winnerPoints ?? 150 }, topGuesses: this.topGuesses() });
    }
    return guess;
  }

  private async handleLike(event: NormalizedLiveEvent): Promise<void> {
    const count = Math.max(1, Number(event.payload.count ?? 1));
    this.likesThisRound += count;
    this.totalLikes = Math.max(this.totalLikes + count, Number(event.payload.totalLikes ?? 0));
    if (this.likesThisRound >= this.adminConfig.current.game.likesPerHint && this.hintsUnlocked < 3) this.unlockHint("likes", event);
    this.gateway.broadcast({ type: "ROOM_STATS", viewerCount: this.viewerCount, totalLikes: this.totalLikes, metrics: this.metrics(), hintsUnlocked: this.hintsUnlocked });
    await this.submitRandomWords(event, 1, "like", [], this.round.roundId);
  }

  private handleGift(event: NormalizedLiveEvent): void {
    if (this.hintsUnlocked < 4) this.unlockHint("gift", event);
    else {
      const extraTimeMs = this.adminConfig.current.game.giftExtraTimeMs;
      this.round.endsAt += extraTimeMs;
      this.broadcastActivity(`${this.actorName(event)} 送出礼物，全场加时 ${Math.floor(extraTimeMs / 1000)} 秒`, event);
      this.broadcast({ type: "GIFT_EFFECT", effect: "EXTRA_TIME", seconds: Math.floor(extraTimeMs / 1000), actor: this.actor(event), round: this.roundView() });
    }
    const rawValue = Number(event.payload.diamondCount ?? event.payload.count ?? 1);
    const giftValue = Number.isFinite(rawValue) ? Math.max(1, Math.floor(rawValue)) : 1;
    const wordCount = giftValue * this.adminConfig.current.game.giftWordsMultiplier;
    const expectedRoundId = this.round.roundId;
    const hints = this.llmHintContext();
    const phase = String(this.timelineView().phaseLabel ?? "探索期");
    this.broadcastActivity(`${this.actorName(event)} 送礼，正在让 AI 根据 ${hints.length} 条提示生成 ${wordCount} 个随机词`, event);
    this.giftQueue = this.giftQueue.then(async () => {
      if (this.round.roundId !== expectedRoundId || this.round.status !== "RUNNING") return;
      let modelWords = await this.generateGiftWords(wordCount, hints, phase, expectedRoundId);
      if (this.round.roundId !== expectedRoundId || this.round.status !== "RUNNING") return;
      let generatedSource: BonusWordSource = "llm";
      if (modelWords.length < wordCount && this.adminConfig.current.game.allowLocalGiftFallback) {
        const localWords = this.localFallbackWords(wordCount - modelWords.length, [...modelWords]);
        modelWords = [...modelWords, ...localWords];
        generatedSource = modelWords.length > 0 && localWords.length > 0 ? "local-fallback" : "llm";
      }
      if (this.round.roundId !== expectedRoundId || this.round.status !== "RUNNING") return;
      if (modelWords.length === 0) {
        this.gateway.broadcast({ type: "LLM_WORD_GENERATION_FAILED", code: "LLM_WORD_GENERATION_FAILED", message: "礼物已收到，但当前模型路由没有返回可用随机词；本次未使用本地词库补足", source: "llm", requestedCount: wordCount, generatedCount: 0 });
        this.broadcastActivity(`${this.actorName(event)} 送礼，但 AI 模型没有返回有效随机词，本次未使用本地词库补足`, event);
        return;
      }
      if (modelWords.length < wordCount) {
        this.gateway.broadcast({ type: "LLM_WORD_GENERATION_PARTIAL", code: "LLM_WORD_GENERATION_PARTIAL", message: `AI 模型只返回了 ${modelWords.length}/${wordCount} 个随机词，本次不使用本地词库补足`, source: "llm", requestedCount: wordCount, generatedCount: modelWords.length });
      }
      this.broadcastActivity(`${this.actorName(event)} 送礼，${generatedSource === "llm" ? "AI 模型" : "AI 模型 + 本地补足"} 已生成 ${modelWords.length}/${wordCount} 个随机词`, event);
      await this.submitRandomWords(event, modelWords.length, "gift", modelWords, expectedRoundId, generatedSource);
    }).catch(() => {
      // Keep later gifts alive if an unexpected integration error escapes the client.
    });
  }

  private async generateGiftWords(count: number, hints: HintContext[], phase: string, expectedRoundId: string): Promise<string[]> {
    const words: string[] = [];
    const generation = this.generation;
    const answerLength = this.round.answerLength;
    const maxBatches = 3;
    for (let batch = 0; batch < maxBatches && words.length < count; batch += 1) {
      if (this.generation !== generation || this.pausedAt!==undefined || this.round.roundId !== expectedRoundId || this.round.status !== "RUNNING") return [];
      const remaining = count - words.length;
      const generated = await this.hintWordClient.generateWords({
        count: remaining,
        language: this.engine.language,
        exactLength: answerLength,
        hints,
        phase,
        excludeWords: [...this.bonusWordsThisRound, ...words],
      });
      if (this.generation !== generation || this.pausedAt!==undefined || this.round.roundId !== expectedRoundId || this.round.status !== "RUNNING") return [];
      for (const rawWord of generated) {
        const word = this.engine.normalize(rawWord);
        if (!this.engine.validate(word, answerLength).ok || word === this.round.answer || this.bonusWordsThisRound.has(word) || words.includes(word)) continue;
        words.push(word);
        if (words.length >= count) break;
      }
      if (generated.length === 0) break;
    }
    return words;
  }

  private async submitRandomWords(event: NormalizedLiveEvent, count: number, triggerType: Exclude<GuessTrigger, "chat">, modelWords: string[] = [], expectedRoundId?: string, modelSource?: BonusWordSource, allowLocal = false, managedSource = false, onDelivered?:()=>void): Promise<number> {
    let completed=0;
    const generation = this.generation;
    for (let index = 0; index < count; index += 1) {
      if (this.generation !== generation || this.round.status !== "RUNNING" || this.pausedAt!==undefined || (expectedRoundId && this.round.roundId !== expectedRoundId)) return completed;
      const previousWord = this.round.lastBonusWord;
      // Bonus words enrich the ranking but never auto-reveal the answer; the
      // winner still needs to come from a real chat guess.
      const modelCandidate = modelWords[index];
      const normalizedModelCandidate = modelCandidate ? this.engine.normalize(modelCandidate) : "";
      let candidate = normalizedModelCandidate && normalizedModelCandidate !== this.round.answer && this.engine.validate(normalizedModelCandidate, this.round.answerLength).ok && !this.bonusWordsThisRound.has(normalizedModelCandidate)
        ? normalizedModelCandidate
        : "";
      let bonusSource: BonusWordSource = modelSource ?? "llm";
      if (!candidate && (allowLocal || (!managedSource && triggerType !== "gift"))) {
        bonusSource = "local-fallback";
        for (let attempt = 0; !candidate && attempt < 30; attempt += 1) {
          const localCandidate = this.engine.randomCandidate(this.round.answer, this.round.answerLength);
          if (!localCandidate) break;
          if (!this.bonusWordsThisRound.has(localCandidate)) candidate = localCandidate;
        }
        candidate ||= this.engine.randomCandidate(this.round.answer, this.round.answerLength);
      }
      if (!candidate) continue;
      this.bonusWordsThisRound.add(candidate);
      const guess = await this.submitGuess(event, candidate, triggerType, previousWord, bonusSource);
      if (!guess) continue;
      completed++;
      onDelivered?.();
      this.round.lastBonusWord = guess.word;
      const triggerLabel = ({gift:"礼物随机词",like:"点赞随机词",follow:"关注随机词",share:"分享随机词"})[triggerType];
      this.broadcastActivity(`${this.actorName(event)} 触发${triggerLabel}：${guess.word}${previousWord ? ` · 上一词：${previousWord}` : ""}`, event);
      if (guess.isCorrect) return completed;
    }
    return completed;
  }

  private localFallbackWords(count: number, excluded: string[]): string[] {
    const words: string[] = [];
    const excludedSet = new Set([...excluded, ...this.bonusWordsThisRound, this.round.answer]);
    for (let attempt = 0; attempt < count * 30 && words.length < count; attempt += 1) {
      const candidate = this.engine.randomCandidate(this.round.answer, this.round.answerLength);
      if (!candidate) break;
      if (excludedSet.has(candidate) || words.includes(candidate)) continue;
      words.push(candidate);
    }
    return words;
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
    this.invalidateInteractions();
    this.broadcastActivity(`${this.actorName(event)} 请求跳过本轮`, event);
    this.round.status = "ANSWERED";
    this.round.answeredAt = Date.now();
    this.round.settleAt = Date.now() + this.adminConfig.current.game.settlementDurationMs;
    this.broadcast({ type: "ROUND_SKIPPED", round: this.roundView() });
  }

  private settleRound(): void {
    if (this.round.status === "SETTLEMENT" && this.round.settleAt && Date.now() < this.round.settleAt) return;
    const winner = this.round.winner;
    const assistants = [...this.round.participants.values()].map(item => item.best)
      .filter(guess => !guess.isCorrect && guess.playerId !== winner?.playerId).sort(compareGuesses).slice(0, 2);
    const awards: Array<{ playerId: string; nickname: string; reason: string; delta: number }> = [];
    const rewards=this.managed?.presentation();
    if (winner) awards.push({ playerId: winner.playerId, nickname: winner.nickname, reason: "猜中答案", delta: rewards?.winnerPoints ?? 150 });
    assistants.forEach((guess, index) => awards.push({ playerId: guess.playerId, nickname: guess.nickname, reason: `相似度第 ${index + 2}`, delta: index === 0 ? rewards?.secondPoints ?? 100 : rewards?.thirdPoints ?? 50 }));
    const mostActivePlayerId = [...this.round.participants.entries()].sort(([, a], [, b]) => b.count - a.count)[0]?.[0];
    const mostActive = mostActivePlayerId ? this.players.get(mostActivePlayerId) : undefined;
    if (mostActive && !awards.some((award) => award.playerId === mostActive.playerId)) awards.push({ playerId: mostActive.playerId, nickname: mostActive.nickname, reason: "最佳助攻", delta: rewards?.assistPoints ?? 50 });
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
    this.round.settleAt = Date.now() + this.adminConfig.current.game.settlementDurationMs;
    this.lastSettlement = { type: "ROUND_SETTLED", round: this.roundView(), winner: winnerSummary, awards: awardViews, topGuesses: this.topGuesses(), scoreboard: this.scoreboard() };
    this.broadcast(this.lastSettlement);
  }

  private startNextRound(): void {
    this.generation++;
    this.pausedAt=undefined;
    this.round = this.createRound();
    this.likesThisRound = 0;
    this.hintsUnlocked = 0;
    this.unlockedHints.clear();
    this.bonusWordsThisRound.clear();
    this.timedHintStages.clear();
    this.broadcast({ type: "ROUND_STARTED", round: this.roundView(), hintsUnlocked: 0 });
    this.wakeRoundWaiters();
  }

  private ensurePlayer(event: NormalizedLiveEvent): PlayerView {
    const playerId = event.user?.id ?? event.user?.uniqueId ?? event.user?.nickname ?? "anonymous";
    const existing = this.players.get(playerId);
    if (existing) {
      // Keep a previously received full name for the SAME stable identity.
      // A later masked like must not erase a full nickname received in chat.
      if (!(event.user?.nicknameMasked && existing.nicknameMasked === false)) {
        existing.nickname = event.user?.nickname ?? existing.nickname;
        existing.nicknameMasked = event.user?.nicknameMasked ?? existing.nicknameMasked;
      }
      existing.uniqueId = event.user?.uniqueId ?? existing.uniqueId;
      existing.avatarUrl = event.user?.avatarUrl ?? existing.avatarUrl;
      existing.identityLimited = event.user?.identityLimited ?? existing.identityLimited;
      return existing;
    }
    const player: PlayerView = { playerId, nickname: event.user?.nickname ?? event.user?.uniqueId ?? "直播间玩家", uniqueId: event.user?.uniqueId, avatarUrl: event.user?.avatarUrl, identityLimited: event.user?.identityLimited, nicknameMasked: event.user?.nicknameMasked, score: 0, guesses: 0, tier: "青铜" };
    this.players.set(playerId, player);
    return player;
  }

  private reject(event: NormalizedLiveEvent, reason: string): void {
    const silent = event.type === "chat" && ["empty", "not_word", "length_mismatch"].includes(reason);
    this.gateway.broadcast({ type: "GUESS_REJECTED", reason, silent, expectedLength: this.round.answerLength, actor: this.actor(event) });
  }

  private broadcast(message: SemanticGameMessage): void {
    this.lastActivity = message;
    this.gateway.broadcast(message);
  }

  private broadcastActivity(text: string, event: NormalizedLiveEvent): void {
    this.broadcast({ type: "ACTIVITY", text, actor: this.actor(event), timestamp: Date.now() });
  }

  private actor(event: NormalizedLiveEvent): Record<string, unknown> {
    const known = this.players.get(event.user?.id ?? event.user?.uniqueId ?? "");
    const keepFullName = known?.nicknameMasked === false && event.user?.nicknameMasked === true;
    return { id: event.user?.id, uniqueId: event.user?.uniqueId, nickname: keepFullName ? known.nickname : event.user?.nickname ?? event.user?.uniqueId ?? "直播间玩家", avatarUrl: event.user?.avatarUrl, identityLimited: event.user?.identityLimited, nicknameMasked: keepFullName ? false : event.user?.nicknameMasked };
  }

  private actorName(event: NormalizedLiveEvent): string {
    return String(event.user?.nickname ?? event.user?.uniqueId ?? "直播间玩家");
  }

  private roomView(): Record<string, unknown> {
    return { roomId: "local-live-room", status: "RUNNING", language: this.engine.language, wordlistId: this.engine.dictionary.snapshot.wordlistId, dictionary: this.engine.dictionaryStatus(), viewerCount: this.viewerCount, totalLikes: this.totalLikes, giftWordsMultiplier: this.adminConfig.current.game.giftWordsMultiplier, giftExtraTimeMs: this.adminConfig.current.game.giftExtraTimeMs };
  }

  private roundView(): Record<string, unknown> {
    const concept = this.engine.resolve(this.round.answer);
    const partOfSpeech = concept.status === "resolved" ? concept.concept.partOfSpeech?.[this.engine.language] : undefined;
    return { roundId: this.round.roundId, roundNo: this.round.roundNo, status: this.pausedAt!==undefined?"PAUSED":this.round.status, pausedAt:this.pausedAt, partOfSpeech, answerCode: this.round.answerCode, answerLength: this.round.answerLength, startedAt: this.round.startedAt, endsAt: this.round.endsAt, answeredAt: this.round.answeredAt, settleAt: this.round.settleAt, revealedAnswer: this.round.status === "SETTLEMENT" ? this.round.answer : undefined };
  }

  private timelineView(now = Date.now()): Record<string, unknown> {
    now=this.pausedAt??now;
    const duration = Math.max(1, this.round.endsAt - this.round.startedAt);
    const progress = Math.max(0, Math.min(1, (now - this.round.startedAt) / duration));
    const phaseIndex = progress < 0.25 ? 0 : progress < 0.5 ? 1 : progress < 0.75 ? 2 : 3;
    const phases = [
      { label: "探索期", hint: "先积累猜词，观察关联方向" },
      { label: "线索期", hint: "25%：系统会提示词汇类型" },
      { label: "锁定期", hint: "50%：系统会提示首字母" },
      { label: "冲刺期", hint: "75%：系统会提示词语长度" },
    ];
    const nextStage = [1, 2, 3].find(stage => !this.timedHintStages.has(stage));
    return { progress, phaseIndex, phaseLabel: phases[phaseIndex].label, phaseHint: phases[phaseIndex].hint, unlockedHints: [...this.unlockedHints.values()], hintLimit: 4, nextHintAt: this.managed?.presentation().timedHints !== false && this.round.status === "RUNNING" && this.hintsUnlocked < 4 && nextStage ? this.round.startedAt + duration * nextStage / 4 : undefined, elapsedMs: Math.max(0, now - this.round.startedAt), remainingMs: Math.max(0, this.round.endsAt - now) };
  }

  private updateTimedHints(now: number): void {
    if(this.managed && !this.managed.presentation().timedHints) return;
    const progress = Number(this.timelineView(now).progress);
    const unlockedStages = progress >= 0.75 ? 3 : progress >= 0.5 ? 2 : progress >= 0.25 ? 1 : 0;
    for (let stage = 1; stage <= unlockedStages; stage += 1) {
      if (this.timedHintStages.has(stage)) continue;
      this.timedHintStages.add(stage);
      this.unlockHint("timer", undefined, this.timedHintView(stage));
    }
  }

  private timedHintView(stage: number): Record<string, unknown> {
    if (stage === 1) return { label: "方向提示", value: this.managed?.presentation().directionHint || this.engine.hintFor(this.round.answer) };
    if (stage === 2) return this.round.answerLength===1 ? {label:"字数提示",value:this.engine.language==="zh-Hans"?"答案仅 1 个汉字，继续观察关联度":"答案仅 1 个字符"} : { label: "开头提示", value: this.engine.language === "zh-Hans" ? Array.from(this.round.answer)[0] : Array.from(this.round.answer)[0].toUpperCase() };
    return { label: "长度提示", value: `${this.round.answerLength} ${this.engine.language === "zh-Hans" ? "个字" : "个字母"}` };
  }

  private topGuesses(): GuessView[] {
    return this.round.guesses.slice(0,14).map(guess=>{
      const player=this.players.get(guess.playerId);
      return player?{...guess,nickname:player.nickname,avatarUrl:player.avatarUrl,uniqueId:player.uniqueId,nicknameMasked:player.nicknameMasked,identityLimited:player.identityLimited,tier:tierForScore(player.score)}:guess;
    });
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
      this.timedHintView(1),
      this.timedHintView(2),
      this.timedHintView(3),
      { label: "相关范围", value: this.engine.language === "zh-Hans" ? "日常生活中可能遇到的词" : "a common everyday word" },
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
    const validGuesses = this.round.validGuesses;
    const uniqueGuessers = this.round.participants.size;
    return { validGuesses, uniqueGuessers, likesThisRound: this.likesThisRound, timeToAnswerMs: this.round.answeredAt ? this.round.answeredAt - this.round.startedAt : 0 };
  }
}

function compareGuesses(a: GuessView, b: GuessView): number {
  return b.displayScore - a.displayScore || a.submittedAt - b.submittedAt;
}

function tierForScore(score: number): PlayerTier {
  if (score >= 2000) return "王者";
  if (score >= 1000) return "钻石";
  if (score >= 600) return "铂金";
  if (score >= 300) return "黄金";
  if (score >= 100) return "白银";
  return "青铜";
}
