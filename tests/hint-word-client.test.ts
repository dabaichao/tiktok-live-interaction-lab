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
    expect(JSON.parse(String(request?.body))).not.toHaveProperty("reasoning_effort");
  });

  it("opts managed hy3 into low reasoning with a separate output budget", async () => {
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:'{"items":[{"word":"香蕉"}]}'}}],usage:{completion_tokens:1550,completion_tokens_details:{reasoning_tokens:1300}}}),{status:200}));
    const client=new HintWordClient({model:"hy3",apiKey:"test-key",hy3LowReasoning:true,maxOutputTokens:6000});
    expect(await client.generateWords({count:1,hints:[],language:"zh-Hans",exactLength:2})).toEqual(["香蕉"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({reasoning_effort:"low",max_tokens:6000});
    expect(client.status().lastRequest).toMatchObject({finishReason:"stop",acceptedWords:1,completionTokens:1550,reasoningTokens:1300});
  });

  it("does not attach hy3 reasoning parameters to other configured models", async () => {
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'{"items":["香蕉"]}'}}]}),{status:200}));
    const client=new HintWordClient({model:"minimax-m3",apiKey:"test-key",hy3LowReasoning:true,maxOutputTokens:6000});
    await client.generateWords({count:1,hints:[]});
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("reasoning_effort");
  });

  it("reports truncation without accepting incomplete output or leaking upstream data", async () => {
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(JSON.stringify({choices:[{finish_reason:"length",message:{content:""}}],usage:{completion_tokens:1200,completion_tokens_details:{reasoning_tokens:1200}},error:{message:"echo-secret"}}),{status:200}));
    const client=new HintWordClient({model:"hy3",apiKey:"test-key"});
    expect(await client.generateWords({count:20,hints:[]})).toEqual([]);
    expect(client.status().lastError).toContain("token 上限");
    expect(client.status().lastRequest).toMatchObject({finishReason:"length",contentChars:0,acceptedWords:0,reasoningTokens:1200});
    expect(JSON.stringify(client.status())).not.toMatch(/echo-secret|test-key/);
  });

  it("fails soft when no runtime key is configured", async () => {
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", model: "hy3", timeoutMs: 1000 });
    await expect(client.generateWords({ count: 10, hints: [] })).resolves.toEqual([]);
    expect(client.status()).toMatchObject({ configured: false, model: "hy3" });
  });
  it("never exposes provider error details or credentials through status", async () => {
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(JSON.stringify({error:{message:"echo-secret-test-key"}}),{status:503}));
    const client=new HintWordClient({model:"hy3",apiKey:"test-key"});
    expect(await client.generateWords({count:1,hints:[]})).toEqual([]);
    expect(client.status().lastError).toContain("HTTP 503");
    expect(JSON.stringify(client.status())).not.toContain("echo-secret");
  });

  it("asks for the exact round length and filters wrong-length model output before accepting it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, items: ["我猜苹果", "护发素", "苹1", "ok", "香蕉", "水果"] }) } }],
    }), { status: 200 }));
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", model: "hy3", apiKey: "test-key", timeoutMs: 1000 });
    await expect(client.generateWords({ count: 2, language: "zh-Hans", exactLength: 2, hints: [] })).resolves.toEqual(["香蕉", "水果"]);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.messages[0].content).toContain("exactly 2 Unicode characters");
    expect(JSON.parse(request.messages[1].content)).toMatchObject({ exactLength: 2 });
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

  it("falls back to the next configured model when the preferred model fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "preferred unavailable" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "preferred unavailable" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"schemaVersion":1,"items":[{"word":"香蕉"}]}' } }] }), { status: 200 }));
    const client = new HintWordClient({ baseUrl: "https://example.test/v1", routingMode: "preferred-fallback", preferredModel: "hy3", fallbackModels: ["minimax-m3"], fixedModel: "hy3", apiKey: "test-key", timeoutMs: 1000 });

    await expect(client.generateWords({ count: 1, language: "zh-Hans", hints: [] })).resolves.toEqual(["香蕉"]);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual(["hy3", "hy3", "minimax-m3"]);
    expect(client.status()).toMatchObject({ lastModelUsed: "minimax-m3", models: ["hy3", "minimax-m3"] });
  });
});
