import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConfigService } from "../src/admin/AdminConfigService.js";
import { SemanticGameService } from "../src/game/SemanticGameService.js";
import type { SemanticGameGateway, SemanticGameMessage } from "../src/game/SemanticGameGateway.js";

describe("live round presentation", () => {
  let game: SemanticGameService;
  afterEach(() => { game?.stop(); vi.useRealTimers(); });

  function setup() {
    vi.useFakeTimers();
    const config = new AdminConfigService("unused-presentation-tests").current;
    Object.assign(config.game, { language: "zh-Hans", answer: "苹果", roundDurationMs: 40000, settlementDurationMs: 1000, tickIntervalMs: 100 });
    const messages: SemanticGameMessage[] = [];
    game = new SemanticGameService({ broadcast: (message: SemanticGameMessage) => messages.push(message) } as unknown as SemanticGameGateway, { get current() { return config; } } as AdminConfigService);
    game.start();
    return messages;
  }

  it("keeps the answer private and restores actual unlocked clues in snapshots", async () => {
    setup();
    const initial = game.snapshot();
    expect(initial.round).toMatchObject({ partOfSpeech: "名词", answerLength: 2 });
    expect(JSON.stringify(initial)).not.toContain('"revealedAnswer"');
    expect(initial.timeline).toMatchObject({ unlockedHints: [] });
    await vi.advanceTimersByTimeAsync(10100);
    const hinted = game.snapshot();
    expect(hinted.timeline).toMatchObject({ unlockedHints: [{ label: "方向提示", value: "水果的一种" }] });
    expect((hinted.round as Record<string, unknown>).revealedAnswer).toBeUndefined();
  });

  it("reveals a timeout answer only at settlement and retains the previous result across rounds", async () => {
    const messages = setup();
    await vi.advanceTimersByTimeAsync(40000);
    expect((game.snapshot().round as Record<string, unknown>).revealedAnswer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1100);
    const settled = messages.find(message => message.type === "ROUND_SETTLED");
    expect(settled?.round).toMatchObject({ revealedAnswer: "苹果", status: "SETTLEMENT" });
    expect(settled?.winner).toBeUndefined();
    expect(game.snapshot().lastSettlement).toEqual(settled);
    await vi.advanceTimersByTimeAsync(1100);
    const next = game.snapshot();
    expect(next.round).toMatchObject({ roundNo: 2, status: "RUNNING" });
    expect((next.round as Record<string, unknown>).revealedAnswer).toBeUndefined();
    expect(next.timeline).toMatchObject({ unlockedHints: [] });
    expect(next.lastSettlement).toEqual(settled);
  });
});
