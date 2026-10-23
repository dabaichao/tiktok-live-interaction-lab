import { describe, expect, it, vi } from "vitest";
import { SemanticEngine } from "../src/game/SemanticEngine.js";
import { ConceptDictionary } from "../src/dictionary/ConceptDictionary.js";

describe("SemanticEngine", () => {
  const engine = new SemanticEngine({ language: "en" });

  it("uses Chinese as the built-in dictionary default", () => {
    expect(new SemanticEngine().language).toBe("zh-Hans");
  });

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

  it("requires the round's exact character count without extracting words from chat", () => {
    const engine = new SemanticEngine({ language: "zh-Hans" });
    expect(engine.validate("  香蕉　", 2)).toEqual({ ok: true, normalizedGuess: "香蕉" });
    expect(engine.validate("𠮷野", 2).ok).toBe(true);
    for (const text of ["我进来的时候还剩下1000多个 果断加了2000多个", "我猜苹果", "苹", "洗发水", "苹果！", "苹 果"]) {
      expect(engine.validate(text, 2).ok, text).toBe(false);
    }
    for (const text of ["苹1", "A果", "苹!", "🍎果", "ok", "12"]) {
      expect(engine.validate(text, 2).ok, text).toBe(false);
    }
    expect(engine.validate("护发素", 3).ok).toBe(true);
    expect(engine.validate("春夏秋冬", 4).ok).toBe(true);
    expect(engine.validate("香蕉", 3).reason).toBe("length_mismatch");
  });

  it("selects bonus words from the matching length pool and has no unsafe fallback", () => {
    const engine = new SemanticEngine({ language: "zh-Hans" });
    for (const length of [2, 3, 4]) {
      for (let i = 0; i < 20; i += 1) {
        const word = engine.randomCandidate("苹果", length);
        expect(engine.validate(word, length).ok).toBe(true);
        expect(word).not.toBe("苹果");
      }
    }
    expect(engine.randomCandidate("苹果", 100)).toBe("");
  });

  it("prefers reviewed words linked to the current question but retains global variety", () => {
    const concept = (id: string, word: string, relatedTo?: string[]) => ({
      conceptId: id, senseKey: id, category: "nature", labels: { "zh-Hans": word }, definitions: {},
      isAnswerable: id === "answer", isGuessable: true, status: "approved" as const, aliases: [], relatedTo,
    });
    const dictionary = new ConceptDictionary({ snapshot: {
      schemaVersion: 1, wordlistId: "linked-test", release: "test", defaultLanguage: "zh-Hans", languages: ["zh-Hans"],
      concepts: [concept("answer", "森林"), concept("trees", "树木", ["森林"]), concept("ship", "小船")],
    } });
    const linkedEngine = new SemanticEngine({ dictionary, language: "zh-Hans" });
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(linkedEngine.randomCandidate("森林", 2)).toBe("树木");
      random.mockReturnValue(0.9);
      expect(linkedEngine.randomCandidate("森林", 2)).toBe("小船");
    } finally {
      random.mockRestore();
    }
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
