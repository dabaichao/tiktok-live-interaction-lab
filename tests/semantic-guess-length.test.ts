import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConfigService } from "../src/admin/AdminConfigService.js";
import { Normalizer } from "../src/core/Normalizer.js";
import { SemanticEngine } from "../src/game/SemanticEngine.js";
import { HintWordClient } from "../src/game/HintWordClient.js";
import { SemanticGameService } from "../src/game/SemanticGameService.js";
import type { SemanticGameGateway, SemanticGameMessage } from "../src/game/SemanticGameGateway.js";

describe("round-length guess admission", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const config = new AdminConfigService("unused-guess-length-test").current;
    Object.assign(config.game, { language: "zh-Hans", answer: "苹果", allowUnknownInputs: true, allowLocalGiftFallback: false });
    const messages: SemanticGameMessage[] = [];
    const game = new SemanticGameService({ broadcast: (m: SemanticGameMessage) => messages.push(m) } as unknown as SemanticGameGateway, { get current() { return config; } } as AdminConfigService);
    const evaluation = vi.spyOn(SemanticEngine.prototype, "evaluateWithEmbedding").mockImplementation(async function (answer, guess) {
      return this.evaluate(answer, guess);
    });
    let sequence = 0;
    async function send(type: string, data: Record<string, unknown>, source: "douyin" | "tiktok" = "douyin") {
      const event = new Normalizer().normalize({ type, data: { user: { id: "u1", nickname: "测试观众" }, ...data } }, source, "isolated", ++sequence);
      game.handleEvent(event);
      await (game as unknown as { eventQueue: Promise<void> }).eventQueue;
      return event;
    }
    const drainGifts = () => (game as unknown as { giftQueue: Promise<void> }).giftQueue;
    return { config, game, messages, send, evaluation, drainGifts };
  }

  it("preserves long chat text but does not calculate, register a player or show rejection popups", async () => {
    const { game, send, messages, evaluation } = setup();
    const text = "我进来的时候还剩下1000多个 果断加了2000多个";
    const event = await send("chat", { text });
    expect(event.payload.text).toBe(text);
    expect(evaluation).not.toHaveBeenCalled();
    expect(game.snapshot()).toMatchObject({ topGuesses: [], scoreboard: [], metrics: { validGuesses: 0, uniqueGuessers: 0 } });
    expect(messages).toContainEqual(expect.objectContaining({ type: "GUESS_REJECTED", reason: "length_mismatch", silent: true, expectedLength: 2 }));
  });

  it.each(["douyin", "tiktok"] as const)("accepts repeated two-character guesses without cooldown on %s", async (source) => {
    const { game, send, evaluation } = setup();
    for (let i = 0; i < 3; i += 1) await send("chat", { text: " 香蕉 " }, source);
    expect(evaluation).toHaveBeenCalledTimes(3);
    expect(game.snapshot()).toMatchObject({ metrics: { validGuesses: 3, uniqueGuessers: 1 } });
    expect(game.snapshot().topGuesses).toHaveLength(1);
  });

  it("rejects punctuation, digits, emoji and multi-word chat, and still lets the answer win", async () => {
    const { game, send, messages, evaluation } = setup();
    for (const text of ["苹", "我猜苹果", "苹果！", "苹 果", "苹1", "A果", "苹!", "🍎果", "12", "ok"]) await send("chat", { text });
    expect(evaluation).not.toHaveBeenCalled();
    expect(game.snapshot().scoreboard).toEqual([]);
    await send("chat", { text: "苹果" });
    expect(messages).toContainEqual(expect.objectContaining({ type: "ROUND_ANSWERED", winner: expect.objectContaining({ word: "苹果", isCorrect: true }) }));
  });

  it("changes the required length with each answer instead of hardcoding two characters", async () => {
    const { game, config, send, evaluation } = setup();
    config.game.answer = "洗发水";
    game.restartRound();
    expect(game.snapshot().round).toMatchObject({ answerLength: 3 });
    await send("chat", { text: "香蕉" });
    expect(evaluation).not.toHaveBeenCalled();
    await send("chat", { text: "护发素" });
    expect(evaluation).toHaveBeenCalledTimes(1);
    config.game.answer = "应用商店";
    game.restartRound();
    expect(game.snapshot().round).toMatchObject({ answerLength: 4 });
    await send("chat", { text: "护发素" });
    expect(evaluation).toHaveBeenCalledTimes(1);
    await send("chat", { text: "春夏秋冬" });
    expect(evaluation).toHaveBeenCalledTimes(2);
  });

  it("keeps commands independent of the length restriction", async () => {
    const { send, messages, evaluation } = setup();
    await send("chat", { text: "!hint" });
    expect(messages.some(m => m.type === "HINT_UNLOCKED")).toBe(true);
    await send("chat", { text: "!skip" });
    expect(messages.some(m => m.type === "ROUND_SKIPPED")).toBe(true);
    expect(evaluation).not.toHaveBeenCalled();
  });

  it("uses matching-length words for likes and independently filters generated gift words", async () => {
    const { send, messages, drainGifts } = setup();
    const generate = vi.spyOn(HintWordClient.prototype, "generateWords").mockResolvedValue(["香蕉", "水果", "我猜苹果", "护发素", "A果"]);
    await send("gift", { giftId: "g1", giftName: "测试礼物", diamondCount: 1, count: 1 });
    await drainGifts();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ exactLength: 2, language: "zh-Hans" }));
    const gifts = messages.filter(m => m.type === "GUESS_ACCEPTED" && m.triggerType === "gift");
    expect(gifts.map(m => (m.guess as { word: string }).word)).toEqual(["香蕉", "水果"]);
    for (let i = 0; i < 10; i += 1) await send("like", { count: 1 });
    const likes = messages.filter(m => m.type === "GUESS_ACCEPTED" && m.triggerType === "like");
    expect(likes).toHaveLength(10);
    for (const m of [...gifts, ...likes]) expect((m.guess as { word: string }).word).toMatch(/^\p{Script=Han}{2}$/u);
  });

  it("does not use pending two-character gift results after changing to a three-character round", async () => {
    const { config, game, send, messages, drainGifts } = setup();
    let finish!: (words: string[]) => void;
    vi.spyOn(HintWordClient.prototype, "generateWords").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await send("gift", { giftId: "g1", diamondCount: 1, count: 1 });
    config.game.answer = "洗发水";
    game.restartRound();
    finish(["香蕉"]);
    await drainGifts();
    expect(messages.filter(m => m.type === "GUESS_ACCEPTED")).toEqual([]);
  });
});
