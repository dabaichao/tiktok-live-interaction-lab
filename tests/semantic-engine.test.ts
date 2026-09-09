import { describe, expect, it } from "vitest";
import { SemanticEngine } from "../src/game/SemanticEngine.js";

describe("SemanticEngine", () => {
  const engine = new SemanticEngine();

  it("normalizes and accepts live-room terms without a bundled vocabulary gate", () => {
    expect(engine.validate("  APPLE ")).toEqual({ ok: true, normalizedGuess: "apple" });
    expect(engine.validate("yacht").ok).toBe(true);
    expect(engine.validate("AppStore")).toEqual({ ok: true, normalizedGuess: "appstore" });
    expect(engine.validate("App Store")).toEqual({ ok: true, normalizedGuess: "app store" });
    expect(engine.validate("not-in-the-wordlist")).toEqual({ ok: true, normalizedGuess: "not-in-the-wordlist" });
    expect(engine.validate("How many hours are you doing this morning").ok).toBe(true);
    expect(engine.validate("a").ok).toBe(true);
    expect(engine.validate("   ").reason).toBe("empty");
    expect(engine.validate("!!!").reason).toBe("not_word");
  });

  it("provides a Chinese directional hint from the concept definition", () => {
    const engine = new SemanticEngine({ language: "zh-Hans" });
    expect(engine.hintFor("苹果")).toBe("水果的一种");
  });

  it("returns a perfect result for the hidden answer", () => {
    const result = engine.evaluate("apple", "APPLE");
    expect(result).toMatchObject({ normalizedGuess: "apple", displayScore: 100, rank: 1, bucket: "correct", isCorrect: true });
  });

  it("uses the refreshed multi-topic answer pool", () => {
    expect(engine.answerPool.length).toBeGreaterThan(80);
    expect(engine.themeFor("appstore")).toBe("科技与互联网");
  });

  it("keeps related guesses hotter than unrelated guesses", () => {
    const related = engine.evaluate("apple", "flower");
    const unrelated = engine.evaluate("apple", "train");
    expect(related.displayScore).toBeGreaterThan(unrelated.displayScore);
    expect(related.rank).toBeLessThan(unrelated.rank);
  });
});
