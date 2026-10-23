import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { isLocalAdminRequest } from "../src/douyin/LocalAccess.js";
import { DouyinWebcastProxy } from "../src/douyin/DouyinWebcastProxy.js";
import { SemanticGameGateway } from "../src/game/SemanticGameGateway.js";

function localRequest(overrides: { address?: string; host?: string; origin?: string; site?: string } = {}) {
  return { socket: { remoteAddress: overrides.address ?? "127.0.0.1" }, headers: {
    host: overrides.host ?? "127.0.0.1:3002", origin: overrides.origin, "sec-fetch-site": overrides.site,
  } } as unknown as IncomingMessage;
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe("local admin and credential proxy boundary", () => {
  it("allows local same-origin UI and no-origin local scripts", () => {
    expect(isLocalAdminRequest(localRequest())).toBe(true);
    expect(isLocalAdminRequest(localRequest({ origin: "http://127.0.0.1:3002", site: "same-origin" }))).toBe(true);
    expect(isLocalAdminRequest(localRequest({ address: "::1", host: "[::1]:3002", origin: "http://[::1]:3002" }))).toBe(true);
  });

  it("rejects foreign addresses, rebinding-style Hosts and cross-origin requests", () => {
    for (const value of [
      { address: "192.0.2.1" }, { host: "external.example:3002" },
      { origin: "https://external.example" }, { origin: "null" },
      { origin: "http://127.0.0.1:9999" }, { site: "cross-site" },
    ]) expect(isLocalAdminRequest(localRequest(value)), JSON.stringify(value)).toBe(false);
  });

  it("rejects a foreign-origin Webcast socket before creating an upstream target", async () => {
    // Only loopback sockets. No real platform, Cookie, login or data directory.
    const createTarget = vi.fn(() => { throw new Error("upstream must not be called"); });
    const proxy = new DouyinWebcastProxy(undefined, { createTarget });
    const server = createServer(); proxy.attach(server);
    const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/socket/webcast/im/push/v2/`, { origin: "https://external.example" });
    const opened = vi.fn(); client.on("open", opened);
    const failed = new Promise<void>(resolve => client.once("error", () => resolve()));
    try {
      await failed;
      expect(opened).not.toHaveBeenCalled();
      expect(createTarget).not.toHaveBeenCalled();
    } finally { client.terminate(); proxy.close(); await close(server); }
  });
});

describe("shared game socket access boundary", () => {
  it("rejects a foreign Origin without sending the game snapshot", async () => {
    const getSnapshot = vi.fn(() => ({ type: "ROOM_SNAPSHOT", scoreboard: [{ nickname: "synthetic-viewer", score: 5 }] }));
    const gateway = new SemanticGameGateway({ info() {}, warn() {} }, getSnapshot);
    const server = createServer(); gateway.attach(server); const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/word-game`, { origin: "https://external.example" });
    const failed = new Promise<void>(resolve=>client.once("error",()=>resolve()));
    try {
      await failed;
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(gateway.diagnostics().clients).toBe(0);
    } finally { client.terminate(); gateway.close(); await close(server); }
  });
  it("allows a configured local page with a different HTTP port",async()=>{
    const gateway=new SemanticGameGateway({info(){},warn(){}},()=>({type:"ROOM_SNAPSHOT"}),{allowedOrigins:["http://127.0.0.1:3002"]});
    const server=createServer();gateway.attach(server);const port=await listen(server);
    const client=new WebSocket(`ws://127.0.0.1:${port}/word-game`,{origin:"http://127.0.0.1:3002"});
    const initial=once(client,"message");
    try {await once(client,"open");expect(JSON.parse((await initial)[0].toString()).type).toBe("ROOM_SNAPSHOT");}
    finally{client.terminate();gateway.close();await close(server);}
  });

  it("ignores unsupported game-control messages instead of mutating game state", async () => {
    const getSnapshot = vi.fn(() => ({ type: "ROOM_SNAPSHOT", round: { status: "RUNNING" }, score: 5 }));
    const gateway = new SemanticGameGateway({ info() {}, warn() {} }, getSnapshot);
    const server = createServer(); gateway.attach(server); const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/word-game`);
    const initial = once(client, "message");
    try {
      await once(client, "open"); await initial;
      const reply = once(client, "message");
      client.send(JSON.stringify({ type: "GAME_RESET", score: 99999 }));
      client.send(JSON.stringify({ type: "ROUND_NEXT" }));
      client.send(JSON.stringify({ type: "PING" }));
      expect(JSON.parse((await reply)[0].toString()).type).toBe("PONG");
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      const snapshot = once(client, "message"); client.send(JSON.stringify({ type: "REQUEST_SNAPSHOT" }));
      expect(JSON.parse((await snapshot)[0].toString())).toMatchObject({ round: { status: "RUNNING" }, score: 5 });
    } finally { client.terminate(); gateway.close(); await close(server); }
  });

  it("closes a game socket whose single incoming message exceeds 64KiB", async () => {
    const gateway = new SemanticGameGateway({ info() {}, warn() {} }, () => ({ type: "ROOM_SNAPSHOT" }));
    const server = createServer(); gateway.attach(server); const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}/word-game`);
    const initial = once(client, "message");
    try {
      await once(client, "open"); await initial;
      const ended = once(client, "close");
      client.send("x".repeat(64 * 1024 + 1));
      expect((await ended)[0]).toBe(1009);
    } finally { client.terminate(); gateway.close(); await close(server); }
  });
});
