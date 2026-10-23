import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DouyinWebcastSource, type WebcastBridgeMessage } from "../src/sources/DouyinWebcastSource.js";

// Runs the real browser script and Source, with no platform/model mutation.
async function bridgeFixture(failFirstEventsRequest: boolean | "lost-response" = false) {
  const nodes = new Map<string, any>();
  const clients: FakeClient[] = [];
  const requests: Array<{ path: string; body: any }> = [];
  const source = new DouyinWebcastSource();
  const sourceStatuses: string[] = [];
  const events: string[] = [];
  source.onStatus(status => sourceStatuses.push(status.status));
  source.onEvent(event => events.push(event.type));
  const element = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", disabled: false, textContent: "", className: "",
      classList: { toggle() {} }, addEventListener() {},
    });
    return nodes.get(id);
  };
  class FakeClient {
    listeners: Record<string, (...args: any[]) => void> = {};
    closed = 0;
    constructor() { clients.push(this); }
    on(name: string, callback: (...args: any[]) => void) { this.listeners[name] = callback; }
    async connect() {}
    close() { this.closed++; this.listeners.close?.(1000); }
    getDiagnostics() { return { frames: 1 }; }
  }
  let failed = false;
  const context = createContext({
    document: { getElementById: element }, location: { origin: "http://127.0.0.1:3002" },
    navigator: {}, console, setInterval() {}, setTimeout, clearTimeout, confirm: () => true,
    loadTestModule: async () => ({ DyCast: FakeClient }),
    fetch: async (path: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body || "{}");
      requests.push({ path, body });
      let result: unknown = {};
      if (path === "/api/douyin/webcast/start") {
        await source.connect({ webRid: "123456789" });
        result = { connection: source.connectionInstructions() };
      } else if (path === "/api/douyin/webcast/events") {
        if (failFirstEventsRequest && !failed) {
          failed = true;
          if(failFirstEventsRequest==="lost-response") { source.acceptMessages(body.sessionToken,body.messages); throw new Error("response lost after commit"); }
          return { ok: false, status: 503, json: async () => ({ error: "隔离的临时服务故障" }) };
        }
        result = source.acceptMessages(body.sessionToken, body.messages);
      } else if (path === "/api/douyin/webcast/state") {
        source.updateState(body.sessionToken, body.state);
      }
      return { ok: true, status: 200, json: async () => result };
    },
  });
  const script = readFileSync("tools/douyin-admin/app.js", "utf8")
    .replace('await import("/vendor/dycast/index.mjs?v=diagnostics-2")', "await loadTestModule()");
  runInContext(script, context);
  element("webcastRoom").value = "123456789";
  await runInContext("connectWebcast()", context);
  const emit = async (messages: WebcastBridgeMessage[]) => {
    clients[0].listeners.message(messages);
    // Drain only the fixture's async HTTP queue, not a real live connection.
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { source, sourceStatuses, events, requests, clients, element, emit, context };
}

describe("Douyin browser bridge failure recovery", () => {
  it("treats the first stream_end as terminal and closes instead of confirming connected", async () => {
    const fixture = await bridgeFixture();
    await fixture.emit([{ id: "isolated-end", method: "WebcastControlMessage", room: { status: 3 } }]);
    expect(fixture.events).toEqual(["stream_end"]);
    expect(fixture.sourceStatuses).not.toContain("connected");
    expect(fixture.source.isConnected()).toBe(false);
    expect(fixture.clients[0].closed).toBe(1);
    expect(fixture.element("webcastFeedback").textContent).toContain("直播已结束");
    fixture.source.updateState(fixture.source.connectionInstructions().sessionToken,{status:"connected"});
    expect(fixture.source.isConnected()).toBe(false);
  });

  it("retries a failed gift before sending later messages", async () => {
    const fixture = await bridgeFixture(true);
    await fixture.emit([{ id: "isolated-gift", method: "WebcastGiftMessage", gift: { id: "g", price: 1, count: 1, repeatEnd: 1 } }]);
    expect(fixture.element("webcastFeedback").textContent).toContain("保留");
    await fixture.emit([{ id: "isolated-chat", method: "WebcastChatMessage", content: "苹果" }]);
    await vi.waitFor(()=>expect(fixture.events).toEqual(["gift","chat"]));
    const batches = fixture.requests.filter(request => request.path === "/api/douyin/webcast/events");
    expect(batches.map(request => request.body.messages[0].id)).toEqual(["isolated-gift", "isolated-gift", "isolated-chat"]);
    expect(fixture.source.diagnostics().acceptedByMethod.WebcastGiftMessage).toBe(1);
    expect(fixture.source.diagnostics().acceptedMessages).toBe(2);
  });
  it("deduplicates an uncertain commit even when the platform omitted a message ID",async()=>{
    const fixture=await bridgeFixture("lost-response");
    await fixture.emit([{method:"WebcastGiftMessage",gift:{id:"g",price:1,count:1,repeatEnd:1}}]);
    await vi.waitFor(()=>expect(fixture.source.diagnostics().duplicateMessages).toBe(1));
    expect(fixture.events).toEqual(["gift"]);
    const batches=fixture.requests.filter(r=>r.path==="/api/douyin/webcast/events");
    expect(batches[0].body.messages[0].bridgeId).toBe(batches[1].body.messages[0].bridgeId);
  });
  it("handles a normal message followed by end in one batch without reviving the connection",async()=>{
    const fixture=await bridgeFixture();
    await fixture.emit([{id:"chat-before-end",method:"WebcastChatMessage",content:"香蕉"},{id:"end",method:"WebcastControlMessage",room:{status:3}},{id:"after-end",method:"WebcastChatMessage",content:"橘子"}]);
    expect(fixture.events).toEqual(["chat","stream_end"]);
    expect(fixture.source.isConnected()).toBe(false);
    expect(fixture.clients[0].closed).toBe(1);
  });
  it("cancels a retry when the user switches sessions rather than delivering it to a new room",async()=>{
    const fixture=await bridgeFixture(true);
    await fixture.emit([{id:"old-gift",method:"WebcastGiftMessage",gift:{id:"g",price:1,count:1,repeatEnd:1}}]);
    await runInContext("connectWebcast()",fixture.context);
    await new Promise(resolve=>setTimeout(resolve,300));
    expect(fixture.events).toEqual([]);
    expect(fixture.requests.filter(r=>r.path==="/api/douyin/webcast/events")).toHaveLength(1);
  });
  it("fails visibly and stops acquisition when the bounded forwarding queue is exceeded",async()=>{
    const fixture=await bridgeFixture();
    await fixture.emit(Array.from({length:20001},()=>({method:"WebcastChatMessage",content:"香蕉"})));
    expect(fixture.clients[0].closed).toBe(1);
    expect(fixture.requests.filter(r=>r.path==="/api/douyin/webcast/events")).toHaveLength(0);
    expect(fixture.element("webcastFeedback").textContent).toContain("20001 条消息未确认送达");
    expect(fixture.events).toEqual([]);
  });
});
