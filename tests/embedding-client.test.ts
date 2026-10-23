import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingClient } from "../src/game/EmbeddingClient.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const vectorResponse = () => new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
describe("embedding availability and bounded caching", () => {
  it("reports unverified at startup and available only after a successful model response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(vectorResponse));
    const client = new EmbeddingClient();
    expect(client.status().mode).toBe("pending");
    await client.embed("测试");
    expect(client.status()).toMatchObject({ mode: "embedding", dimensions: 3, cacheEntries: 1 });
  });
  it("deduplicates concurrent requests and evicts least recently used vectors", async () => {
    const fetch = vi.fn().mockImplementation(vectorResponse); vi.stubGlobal("fetch", fetch);
    const client = new EmbeddingClient({ maxCacheEntries: 3 });
    await Promise.all([client.embed("one"), client.embed("one")]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.embed("two"); await client.embed("three"); await client.embed("one"); await client.embed("four");
    expect(client.status().cacheEntries).toBe(3);
    await client.embed("two"); expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("does not make every viewer wait a fresh timeout while the model is unavailable, and retries later", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const fetch = vi.fn().mockRejectedValueOnce(new Error("private upstream detail")).mockImplementation(vectorResponse); vi.stubGlobal("fetch", fetch);
    const client = new EmbeddingClient({ retryDelayMs: 5000 });
    await expect(client.embed("first")).rejects.toThrow();
    await expect(client.embed("second")).rejects.toThrow("向量服务");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.status())).not.toContain("private upstream");
    vi.advanceTimersByTime(5001); await client.embed("second");
    expect(client.status().mode).toBe("embedding"); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
