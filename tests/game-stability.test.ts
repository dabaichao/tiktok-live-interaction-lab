import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { AdminConfigService } from "../src/admin/AdminConfigService.js";
import { Normalizer } from "../src/core/Normalizer.js";
import { SemanticEngine } from "../src/game/SemanticEngine.js";
import { SemanticGameService } from "../src/game/SemanticGameService.js";
import type { SemanticGameGateway, SemanticGameMessage } from "../src/game/SemanticGameGateway.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const config = new AdminConfigService("unused-stability-tests").current;
  Object.assign(config.game, { language: "zh-Hans", answer: "苹果", tickIntervalMs: 100, settlementDurationMs: 100 });
  const messages: SemanticGameMessage[] = [];
  const game = new SemanticGameService({ broadcast: (m: SemanticGameMessage) => messages.push(m) } as SemanticGameGateway, { get current() { return config; } } as AdminConfigService);
  const evaluate = vi.spyOn(SemanticEngine.prototype, "evaluateWithEmbedding").mockImplementation(async function (answer, guess) { return this.evaluate(answer, guess); });
  const normalizer = new Normalizer(); let sequence = 0;
  const event = (id: string, word: string, extra = {}) => normalizer.normalize({ type: "chat", data: { text: word, user: { id, nickname: id, ...extra } } }, "douyin", "audit", ++sequence);
  const drain = () => (game as unknown as { eventQueue: Promise<void> }).eventQueue;
  const send = async (id: string, word: string, extra = {}) => { game.handleEvent(event(id, word, extra)); await drain(); };
  return { game, messages, evaluate, event, drain, send };
}
describe("game stability regressions", () => {
  it("does not expose a guessable default-key answer hash or reuse codes between rounds",()=>{
    const {game}=setup();
    const first=game.snapshot().round as {answerCode:string};
    expect(first.answerCode).not.toBe(createHmac("sha256","local-dev-answer-code").update("苹果").digest("hex").slice(0,12));
    game.control("next");
    expect((game.snapshot().round as {answerCode:string}).answerCode).not.toBe(first.answerCode);
  });
  it("never applies queued chats from an old round to the next round", async () => {
    const { game, evaluate, event, drain, messages } = setup();
    let release!: () => void;
    evaluate.mockImplementationOnce(function (answer, guess) { const result = this.evaluate(answer, guess); return new Promise(resolve => { release = () => resolve(result); }); });
    game.handleEvent(event("first", "香蕉")); await Promise.resolve();
    game.handleEvent(event("queued", "水果"));
    game.control("next"); release(); await drain();
    expect(messages.filter(m => m.type === "GUESS_ACCEPTED")).toEqual([]);
    expect(game.snapshot().metrics).toMatchObject({ validGuesses: 0, uniqueGuessers: 0 });
  });
  it("counts every repeated input while bounding/deduplicating the ranking", async () => {
    const { game, send } = setup();
    for (let i = 0; i < 1000; i++) await send("frequent", "香蕉");
    await send("another", "水果");
    expect(game.snapshot().metrics).toMatchObject({ validGuesses: 1001, uniqueGuessers: 2 });
    expect(game.snapshot().topGuesses).toHaveLength(2);
    expect(game.snapshot().scoreboard).toEqual(expect.arrayContaining([expect.objectContaining({ playerId: "frequent", guesses: 1000 })]));
  });
  it("awards winner, second and third to different viewers even if the winner submitted many words", async () => {
    vi.useFakeTimers();
    const { game, send, messages } = setup();
    await send("winner", "香蕉"); await send("winner", "水果");
    await send("second", "香蕉"); await send("third", "海洋"); await send("winner", "苹果");
    game.start(); await vi.advanceTimersByTimeAsync(200); game.stop();
    const awards = messages.find(m => m.type === "ROUND_SETTLED")?.awards as Array<{ playerId: string; delta: number }>;
    expect(awards[0].playerId).toBe("winner");
    expect(new Set(awards.map(a => a.playerId))).toEqual(new Set(["winner", "second", "third"]));
    expect(awards.map(a => a.delta)).toEqual([150, 100, 50]);
  });
  it("preserves a full name received for the same stable identity when later likes/chat are masked", async () => {
    const { game, send } = setup();
    await send("stable-id", "香蕉", { nickname: "完整测试昵称", nicknameMasked: false });
    await send("stable-id", "水果", { nickname: "完***", nicknameMasked: true });
    expect(game.snapshot().scoreboard).toEqual([expect.objectContaining({ nickname: "完整测试昵称", nicknameMasked: false })]);
    expect(game.snapshot().topGuesses).toEqual(expect.arrayContaining([expect.objectContaining({nickname:"完整测试昵称",nicknameMasked:false})]));
  });
  it("does not reveal an entire one-character answer as the first-character hint",()=>{
    const {game}=setup();
    (game as any).round.answer="山";(game as any).round.answerLength=1;
    const hint=(game as any).timedHintView(2);
    expect(hint.value).not.toContain("山");
    expect(new SemanticEngine({language:"zh-Hans"}).answerPool).not.toContain("足球");
  });
});
