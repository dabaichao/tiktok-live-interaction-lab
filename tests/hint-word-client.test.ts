import { afterEach, describe, expect, it, vi } from "vitest";
import { HintWordClient } from "../src/game/HintWordClient.js";

describe("HintWordClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requests the configured model and parses the accepted JSON schema", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"schemaVersion":1,"items":[{"word":"Hotel"},{"word":"train"},{"word":"train"}]}' } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", model: "hy3", apiKey: "test-key", timeoutMs: 1000 });

    await expect(client.generateWords({ count: 3, phase: "探索期", hints: [{ label: "主题", value: "交通与旅行" }] })).resolves.toEqual(["hotel", "train"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "hy3", response_format: { type: "json_object" } });
  });

  it("fails soft when no runtime key is configured", async () => {
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", model: "hy3", timeoutMs: 1000 });
    await expect(client.generateWords({ count: 10, hints: [] })).resolves.toEqual([]);
    expect(client.status()).toMatchObject({ configured: false, model: "hy3" });
  });

  it("accepts provider content blocks and excludes words already used in the round", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: "text", text: '{"schemaVersion":1,"items":[{"word":"Boat"},{"word":"Sail"},{"word":"Boat"}]}' }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", model: "hy3", apiKey: "test-key", timeoutMs: 1000 });

    await expect(client.generateWords({ count: 3, hints: [], excludeWords: ["boat"] })).resolves.toEqual(["sail"]);
  });

  it("retries when the model response contains no accepted words", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"schemaVersion":1,"items":[]}' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"schemaVersion":1,"items":[{"word":"yacht"}]}' } }] }), { status: 200 }));
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", model: "hy3", apiKey: "test-key", timeoutMs: 1000 });

    await expect(client.generateWords({ count: 1, hints: [] })).resolves.toEqual(["yacht"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
