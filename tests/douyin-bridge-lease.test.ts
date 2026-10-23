import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { DouyinInteractionLab } from "../src/douyin-server.js";
import { DouyinWebcastProxy } from "../src/douyin/DouyinWebcastProxy.js";
import { HintWordClient } from "../src/game/HintWordClient.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function isolatedLab() {
  vi.stubEnv("DATA_DIR", await mkdtemp(join(tmpdir(), "douyin-bridge-jobs-")));
  vi.stubEnv("HINT_LLM_API_KEY", "");
  vi.stubEnv("EMBEDDING_BASE_URL", "http://127.0.0.1:1/v1");
  const lab = new DouyinInteractionLab();
  const started = await lab.startWebcast({ webRid: "isolatedLease" }) as { connection: { sessionToken: string } };
  const token = started.connection.sessionToken;
  lab.updateWebcastState(token, { status: "connected" });
  const source = (lab as any).webcastSource, game = (lab as any).game;
  return { lab, token, source, game };
}

const gift = (id: string) => ({ id, method: "WebcastGiftMessage", user: { id: "isolated-viewer", name: "隔离测试" }, gift: { id: "isolated-gift", name: "隔离礼物", count: 1, price: 1, type: 1, repeatEnd: 1, groupId: id } });

// All clocks/sockets/credentials/events are isolated; never touches port 3002.
it("releases the upstream proxy when the browser bridge lease expires", async () => {
  vi.stubEnv("DATA_DIR", await mkdtemp(join(tmpdir(), "douyin-bridge-lease-")));
  vi.stubEnv("HINT_LLM_API_KEY", "");
  vi.stubEnv("EMBEDDING_BASE_URL", "http://127.0.0.1:1/v1");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if(typeof upstreamAddress === "string")throw new Error("missing port");
  const lab = new DouyinInteractionLab();
  const createTarget = vi.fn(() => new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`));
  const proxy = new DouyinWebcastProxy(undefined, { createTarget, canOpenBridge: () => lab.hasActiveWebcastBridge() });
  proxy.onTransportState(state=>lab.updateWebcastTransport(state.state));
  lab.onWebcastEnded(()=>proxy.disconnectClients("disconnected"));
  lab.onWebcastBridgeExpired(()=>proxy.disconnectClients("disconnected"));
  const server = createServer();proxy.attach(server);server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw new Error("missing port");
  let client:WebSocket|undefined,target:WebSocket|undefined;
  try {
    await proxy.setCookie("sessionid=synthetic-lease-test");
    const started=await lab.startWebcast({webRid:"isolatedLease"}) as {connection:{sessionToken:string}};
    const token=started.connection.sessionToken;
    const connected=once(upstream,"connection");
    client=new WebSocket(`ws://127.0.0.1:${address.port}/socket/webcast/im/push/v2/`);
    await once(client,"open");[target]=await connected;
    await vi.waitFor(()=>expect(proxy.diagnostics().transport.state).toBe("connected"));
    lab.updateWebcastState(token,{status:"connected",roomId:"isolated-only"});
    const source=(lab as any).webcastSource;
    source.lastBridgeAt=Date.now()-60_001;
    const expired=lab.view();
    expect(expired.activeSource).toBe("none");
    expect((expired.sources as any).douyin.status).toBe("disconnected");
    expect((expired.douyin as any).webcast).toMatchObject({bridgeExpired:true,ended:false});
    expect(proxy.diagnostics().transport.state).toBe("disconnected");
    await vi.waitFor(()=>expect(target!.readyState).toBe(WebSocket.CLOSED));
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(proxy.diagnostics().cookie.hasLoginSession).toBe(true);
    expect(()=>lab.updateWebcastState(token,{status:"connected"})).toThrow("会话已失效");
    expect(()=>lab.acceptWebcastMessages(token,[{id:"late",method:"WebcastLikeMessage",count:1}])).toThrow("会话已失效");
    expect(()=>lab.updateWebcastDiagnostics(token,{frames:2})).toThrow("会话已失效");
    const staleClient = new WebSocket(`ws://127.0.0.1:${address.port}/socket/webcast/im/push/v2/`);
    staleClient.on("error", () => {});
    await new Promise<void>(resolve => staleClient.once("close", () => resolve()));
    expect(createTarget).toHaveBeenCalledTimes(1);
    expect(proxy.diagnostics().transport.state).toBe("disconnected");
    // An explicit fresh start is still permitted; expiry is not logout.
    const next = await lab.startWebcast({webRid:"nextIsolatedLease"}) as {connection:{sessionToken:string}};
    expect(next.connection.sessionToken).not.toBe(token);
    const nextConnected = once(upstream, "connection");
    client = new WebSocket(`ws://127.0.0.1:${address.port}/socket/webcast/im/push/v2/`);
    await once(client, "open"); [target] = await nextConnected;
    await vi.waitFor(() => expect(proxy.diagnostics().transport.state).toBe("connected"));
    expect(createTarget).toHaveBeenCalledTimes(2);
    expect(proxy.diagnostics().cookie.hasLoginSession).toBe(true);
  } finally {
    client?.terminate();target?.terminate();proxy.close();lab.close();await lab.operations.flush();
    for(const socket of upstream.clients)socket.terminate();
    await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);
    vi.unstubAllEnvs();
  }
});

it("cancels queued gift work and discards a late in-flight model response after expiry", async () => {
  const { lab, token, source, game } = await isolatedLab();
  let release: ((words: string[]) => void) | undefined;
  const generate = vi.spyOn(HintWordClient.prototype, "generateWords").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const cleanup = vi.fn(); lab.onWebcastBridgeExpired(cleanup);
  try {
    lab.acceptWebcastMessages(token, [gift("first"), gift("queued")]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(game.interactionDiagnostics()).toMatchObject({ pendingJobs: 2, queuedJobs: 1, modelJobs: 2 });
    source.lastBridgeAt = Date.now() - 60_001;
    lab.view();
    expect(cleanup).toHaveBeenCalledTimes(1);
    // In-flight HTTP is allowed to settle within its existing bounded timeout;
    // no further request or word delivery is allowed after invalidation.
    release!(["fruit"]);
    await game.modelInteractionQueue;
    const records = lab.operations.view(lab.roomKey).records;
    expect(records).toHaveLength(2);
    expect(records.every(record => record.status === "cancelled" && record.completedWords === 0 && record.aiWords === 0 && record.localWords === 0)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(game.snapshot().topGuesses).toHaveLength(0);
    expect(game.interactionDiagnostics()).toMatchObject({ pendingJobs: 0, remainingWords: 0 });
  } finally {
    release?.([]); await game.modelInteractionQueue;
    lab.close(); await lab.operations.flush();
  }
});

it("wakes and cancels a carry-over gift waiting for the next round when the bridge expires", async () => {
  const { lab, token, source, game } = await isolatedLab();
  const generate = vi.spyOn(HintWordClient.prototype, "generateWords").mockResolvedValue([]);
  try {
    game.round.endsAt = Date.now() - 1; game.tick();
    lab.acceptWebcastMessages(token, [gift("waiting")]);
    await vi.waitFor(() => expect(game.interactionDiagnostics().waitingForRound).toBe(1));
    expect(generate).not.toHaveBeenCalled();
    source.lastBridgeAt = Date.now() - 60_001;
    lab.view();
    await game.modelInteractionQueue;
    expect(lab.operations.view(lab.roomKey).records[0]).toMatchObject({ status: "cancelled", completedWords: 0, remainingWords: 10, waitingForRound: false });
    expect(game.interactionDiagnostics()).toMatchObject({ pendingJobs: 0, waitingForRound: 0 });
    expect(generate).not.toHaveBeenCalled();
  } finally { lab.close(); await lab.operations.flush(); }
});
