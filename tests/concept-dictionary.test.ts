import { afterEach, describe, expect, it, vi } from "vitest";
import { ConceptDictionary } from "../src/dictionary/ConceptDictionary.js";
import { DictionaryGapFillClient, missingLabelsForLanguage } from "../src/dictionary/DictionaryGapFill.js";

describe("ConceptDictionary", () => {
  it("resolves approved aliases to one stable concept across languages", () => {
    const dictionary = ConceptDictionary.default();
    expect(dictionary.resolve("yacht", "en")).toMatchObject({ status: "resolved", conceptId: "travel.yacht" });
    expect(dictionary.resolve("游艇", "zh-Hans")).toMatchObject({ status: "resolved", conceptId: "travel.yacht" });
    expect(dictionary.resolve("App Store", "en")).toMatchObject({ status: "resolved", conceptId: "technology.appstore" });
    expect(dictionary.resolve("商店", "zh-Hans").status).toBe("ambiguous");
  });

  it("keeps a published snapshot immutable and reports language gaps", () => {
    const dictionary = ConceptDictionary.default();
    const stats = dictionary.stats();
    expect(stats.wordlistId).toBe("multi_core_v1");
    expect(stats.aliasesByLanguage.en).toBeGreaterThan(80);
    expect(stats.missingLabelsByLanguage.vi).toBeGreaterThan(0);
    expect(missingLabelsForLanguage(dictionary.snapshot.concepts, "vi").some((concept) => concept.conceptId === "legacy.creator")).toBe(true);
  });
});

describe("DictionaryGapFillClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses only requested concepts and keeps proposals pending", () => {
    const client = new DictionaryGapFillClient({ apiKey: "test", model: "hy3" });
    const proposals = client.parse(JSON.stringify({ schemaVersion: 1, language: "vi", items: [
      { conceptId: "legacy.creator", label: "người sáng tạo", aliases: ["nhà sáng tạo"] },
      { conceptId: "not-requested", label: "bỏ qua" },
    ] }), "vi", new Set(["legacy.creator"]));
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ conceptId: "legacy.creator", reviewStatus: "pending", sourceId: "llm", model: "hy3" });
  });

  it("splits large fills into batches of at most 100 concepts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const user = JSON.parse(request.messages[1].content) as { concepts: Array<{ conceptId: string }> };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, items: [{ conceptId: user.concepts[0]?.conceptId, label: "候选词" }] }) } }] }), { status: 200 });
    });
    const concepts = Array.from({ length: 101 }, (_, index) => ({ conceptId: `legacy.${index}`, category: "people", canonicalEn: `term-${index}`, existingLabels: { en: `term-${index}` } }));
    const client = new DictionaryGapFillClient({ apiKey: "test", maxBatchSize: 100, timeoutMs: 1000 });
    const proposals = await client.propose({ language: "vi", concepts });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(JSON.parse(String(call[1]?.body)).messages[1].content).concepts.length)).toEqual([100, 1]);
    expect(proposals).toHaveLength(2);
  });
});
