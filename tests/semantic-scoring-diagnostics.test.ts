import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticEngine } from "../src/game/SemanticEngine.js";

afterEach(() => vi.unstubAllGlobals());

function vectors(values: Record<string, number[]>) {
  const fetch = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    const embedding = values[body.input[0]];
    if (!embedding) throw new Error("unexpected test word");
    return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function engine() {
  return new SemanticEngine({ language: "zh-Hans", apiKey: "", retryDelayMs: 0 });
}

describe("semantic score formula and exact-concept boundary", () => {
  it("uses the actual cosine, not a probability or a corpus rank", async () => {
    const fetch = vectors({ 苹果: [1, 0], 香蕉: [0.8, 0.6] });
    const result = await engine().evaluateWithEmbedding("苹果", "香蕉");
    expect(result.rawCosine).toBeCloseTo(0.8);
    expect(result).toMatchObject({ displayScore: 80, similarityMode: "embedding", isCorrect: false });
    expect(result.rank).toBe(Math.round(1 + Math.pow(100 - 80, 1.35) * 2.2));
    expect(fetch.mock.calls.map(call => JSON.parse(String(call[1].body)).input)).toEqual([["苹果"], ["香蕉"]]);
  });

  it("recognizes an exact answer without invoking a model", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await engine().evaluateWithEmbedding("苹果", "苹果")).toMatchObject({
      displayScore: 100, similarityMode: "exact", isCorrect: true, bucket: "correct",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not turn identical vectors for different concepts into a win", async () => {
    vectors({ 苹果: [1, 0], 香蕉: [1, 0] });
    expect(await engine().evaluateWithEmbedding("苹果", "香蕉")).toMatchObject({
      rawCosine: 1, displayScore: 99.9, similarityMode: "embedding", isCorrect: false,
    });
  });

  it("retains a negative raw cosine but clips the displayed score at zero", async () => {
    vectors({ 苹果: [1, 0], 香蕉: [-1, 0] });
    expect(await engine().evaluateWithEmbedding("苹果", "香蕉")).toMatchObject({
      rawCosine: -1, displayScore: 0, similarityMode: "embedding", isCorrect: false, bucket: "cold",
    });
  });

  it("explicitly reports a network failure as heuristic fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("isolated failure")));
    const subject = engine();
    expect(await subject.evaluateWithEmbedding("苹果", "香蕉")).toMatchObject({ similarityMode: "heuristic", isCorrect: false });
    expect(subject.embeddingStatus().mode).toBe("unavailable");
  });
});

describe("vector-result validation and safe numeric scoring", () => {
  it("rejects changed dimensions and reports fallback honestly", async () => {
    vectors({ 苹果: [1, 0], 香蕉: [1, 0, 0] });
    const subject = engine();
    const result = await subject.evaluateWithEmbedding("苹果", "香蕉");
    expect(result.similarityMode).toBe("heuristic");
    expect(subject.embeddingStatus()).toMatchObject({ mode: "unavailable", cacheEntries: 0 });
    expect(subject.embeddingStatus().lastError).toContain("维度");
  });

  it("does not cache zero vectors or report them as usable embeddings", async () => {
    const fetch = vectors({ 苹果: [0, 0], 香蕉: [0, 0] });
    const subject = engine();
    expect((await subject.evaluateWithEmbedding("苹果", "香蕉")).similarityMode).toBe("heuristic");
    expect(subject.embeddingStatus()).toMatchObject({ mode: "unavailable", cacheEntries: 0 });
    expect((await subject.evaluateWithEmbedding("苹果", "香蕉")).similarityMode).toBe("heuristic");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([1e308,1e-308])("scales extreme finite vectors (%s) without NaN or underflow", async value => {
    vectors({ 苹果: [value, value], 香蕉: [value, value] });
    const result = await engine().evaluateWithEmbedding("苹果", "香蕉");
    expect(result.similarityMode).toBe("embedding");
    expect(result.displayScore).toBe(99.9);
    expect(Number.isFinite(result.rank)).toBe(true);
    expect(JSON.parse(JSON.stringify(result)).displayScore).toBe(99.9);
  });
});
