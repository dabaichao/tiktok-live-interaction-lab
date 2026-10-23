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
  it("does not invent localized answers by falling back to English",()=>{
    const dictionary=ConceptDictionary.default();
    expect(dictionary.answerWords("zh-Hans")).not.toContain("creator");
    expect(dictionary.answerWords("zh-Hans").every(word=>/^\p{Script=Han}+$/u.test(word))).toBe(true);
    expect(dictionary.conceptsFor("nonexistent-language","answerable")).toEqual([]);
  });
  it("rejects invalid labels and duplicate concept IDs before publication",()=>{
    const original=ConceptDictionary.default().snapshot;
    const invalid=structuredClone(original);(invalid.concepts[0].labels as any)["zh-Hans"]=42;
    expect(()=>new ConceptDictionary({snapshot:invalid})).toThrow("词面与提示");
    const duplicate=structuredClone(original);duplicate.concepts.push(duplicate.concepts[0]);
    expect(()=>new ConceptDictionary({snapshot:duplicate})).toThrow("重复");
  });
  it("keeps normalization idempotent across serialized snapshot reloads", () => {
    const first = ConceptDictionary.default();
    const original = structuredClone(first.snapshot);
    let reloaded = first;
    for (let round = 0; round < 4; round++) {
      reloaded = new ConceptDictionary({ snapshot: JSON.parse(JSON.stringify(reloaded.snapshot)) });
      expect(reloaded.snapshot).toEqual(first.snapshot);
      expect(reloaded.stats()).toEqual(first.stats());
      expect(reloaded.answerWords("zh-Hans")).toEqual(first.answerWords("zh-Hans"));
    }
    expect(first.snapshot).toEqual(original);
  });
  it("only removes identical aliases and preserves review and provenance differences", () => {
    const snapshot = structuredClone(ConceptDictionary.default().snapshot);
    const concept = snapshot.concepts[0];
    snapshot.concepts = [concept];
    concept.labels = { "zh-Hans": "主词" };
    const approved = { lang: "zh-Hans", text: "异名", type: "synonym" as const, exact: true, reviewStatus: "approved" as const, sourceId: "review-a", confidence: 0.9 };
    concept.aliases = [approved, { ...approved }, { ...approved, reviewStatus: "pending" },
      { ...approved, sourceId: "review-b" }, { ...approved, confidence: 0.8 },
      { ...approved, exact: false }, { ...approved, text: "待审词", reviewStatus: "pending" },
      { ...approved, text: "拒绝词", reviewStatus: "rejected" }];
    const original = structuredClone(snapshot);
    const dictionary = new ConceptDictionary({ snapshot });
    expect(dictionary.snapshot.concepts[0].aliases).toHaveLength(8);
    expect(dictionary.snapshot.concepts[0].aliases.filter(a => a.text === "异名")).toHaveLength(5);
    expect(dictionary.resolve("异名", "zh-Hans").status).toBe("resolved");
    expect(dictionary.resolve("待审词", "zh-Hans").status).toBe("unknown");
    expect(dictionary.resolve("拒绝词", "zh-Hans").status).toBe("unknown");
    expect(snapshot).toEqual(original);
    expect(new ConceptDictionary({ snapshot: dictionary.snapshot }).snapshot).toEqual(dictionary.snapshot);
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
