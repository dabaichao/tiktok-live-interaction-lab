import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { DouyinInteractionLab } from "../src/douyin-server.js";
import { DouyinWebcastProxy } from "../src/douyin/DouyinWebcastProxy.js";

// Real loopback socket cleanup, without platform/model calls or live state.
it("closes the proxy sockets after stream_end and rejects stale connected reports", async () => {
  vi.stubEnv("DATA_DIR", await mkdtemp(join(tmpdir(), "douyin-ended-diagnostic-")));
  vi.stubEnv("HINT_LLM_API_KEY", "");
  vi.stubEnv("EMBEDDING_BASE_URL", "http://127.0.0.1:1/v1");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  if (typeof upstreamAddress === "string") throw new Error("missing test port");
  const lab = new DouyinInteractionLab();
  const proxy = new DouyinWebcastProxy(undefined, {
    createTarget: () => new WebSocket(`ws://127.0.0.1:${upstreamAddress.port}`),
    canOpenBridge: () => lab.hasActiveWebcastBridge(),
  });
  proxy.onTransportState(state => lab.updateWebcastTransport(state.state));
  lab.onWebcastEnded(()=>proxy.disconnectClients("disconnected"));
  const server = createServer();
  proxy.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  let client: WebSocket | undefined;
  let target: WebSocket | undefined;
  try {
    const result = await lab.startWebcast({ webRid: "resourceTest" }) as { connection: { sessionToken: string } };
    const token = result.connection.sessionToken;
    lab.updateWebcastState(token, { status: "connected", roomId: "isolated-room" });
    const connected = once(upstream, "connection");
    client = new WebSocket(`ws://127.0.0.1:${address.port}/socket/webcast/im/push/v2/`);
    await once(client, "open");
    [target] = await connected;
    await vi.waitFor(() => expect(proxy.diagnostics().transport.state).toBe("connected"));
    lab.acceptWebcastMessages(token, [{ id: "isolated-ended", method: "WebcastControlMessage", room: { status: 3 } }]);
    expect((lab.view().sources as any).douyin.status).toBe("disconnected");
    expect(proxy.diagnostics().transport.state).toBe("disconnected");
    await vi.waitFor(()=>expect(target!.readyState).toBe(WebSocket.CLOSED));
    expect(client.readyState).toBe(WebSocket.CLOSED);
    lab.updateWebcastState(token,{status:"connected"});
    expect((lab.view().sources as any).douyin.status).toBe("disconnected");
    expect(proxy.diagnostics().transport.frames).toBe(0);
    const staleClient = new WebSocket(`ws://127.0.0.1:${address.port}/socket/webcast/im/push/v2/`);
    staleClient.on("error", () => {});
    await new Promise<void>(resolve => staleClient.once("close", () => resolve()));
    expect(proxy.diagnostics().transport.state).toBe("disconnected");
    expect(upstream.clients.size).toBe(0);
  } finally {
    client?.terminate(); target?.terminate(); proxy.close(); lab.close();
    await lab.operations.flush();
    for (const socket of upstream.clients) socket.terminate();
    await Promise.all([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => upstream.close(() => resolve())),
    ]);
    vi.unstubAllEnvs();
  }
});
