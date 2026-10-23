import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SemanticGameGateway } from "../src/game/SemanticGameGateway.js";

describe("game delivery under bursts/slow renderers", () => {
  it("coalesces a burst into current standings and three recent actions before round transitions", async () => {
    const gateway = new SemanticGameGateway({ info() {}, warn() {} }, () => ({ type: "ROOM_SNAPSHOT" }));
    const server = createServer(); gateway.attach(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/word-game`);
    const initial = once(socket, "message"); await once(socket, "open"); await initial;
    try {
      const messages: any[] = []; let finish!: () => void;
      const transitioned = new Promise<void>(resolve => { finish = resolve; });
      socket.on("message", data => { const m = JSON.parse(data.toString()); messages.push(m); if (m.type === "ROUND_STARTED") finish(); });
      for (let i = 0; i < 100; i++) gateway.broadcast({ type: "GUESS_ACCEPTED", guess: { guessId: i }, metrics: { validGuesses: i + 1 } });
      gateway.broadcast({ type: "ROUND_STARTED" }); await transitioned;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ type: "GUESS_ACCEPTED", metrics: { validGuesses: 100 }, recentGuesses: [{ guessId: 97 }, { guessId: 98 }, { guessId: 99 }] });
    } finally { socket.terminate(); gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("disconnects a stalled display instead of accumulating unlimited outbound data", () => {
    const gateway = new SemanticGameGateway({ info() {}, warn() {} }, () => ({}));
    const slow = { readyState: WebSocket.OPEN, bufferedAmount: 3 * 1024 * 1024, terminate: vi.fn(), send: vi.fn() };
    (gateway as unknown as { clients: Set<unknown> }).clients.add(slow);
    gateway.broadcast({ type: "ROUND_STARTED" });
    expect(slow.terminate).toHaveBeenCalledTimes(1); expect(slow.send).not.toHaveBeenCalled();
    expect(gateway.diagnostics().slowClientsDisconnected).toBe(1);
    gateway.close();
  });
});
