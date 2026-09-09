import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { GameAction } from "../actions/GameAction.js";
import type { GatewayLogger } from "./EventGateway.js";

export class ActionGateway {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly logger: GatewayLogger, private readonly maxBufferedBytes = 1024 * 1024) {
    this.server.on("connection", (socket, request) => {
      this.clients.add(socket);
      this.logger.info({ path: request.url }, "ws_client_connected");
      socket.send(JSON.stringify({ op: "hello", protocol: "tiktok-live-lab", version: 1 }));
      socket.on("close", () => {
        this.clients.delete(socket);
        this.logger.info({}, "ws_client_disconnected");
      });
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  attach(httpServer: HttpServer, paths = ["/actions", "/ws/actions"]): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!paths.includes(path)) return;
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    });
  }

  broadcastAction(action: GameAction): void {
    const serialized = JSON.stringify({ op: "action", action });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > this.maxBufferedBytes) {
        this.logger.warn({ bufferedAmount: client.bufferedAmount }, "ws_client_disconnected_slow");
        client.terminate();
        this.clients.delete(client);
        continue;
      }
      client.send(serialized);
    }
  }

  close(): void {
    for (const client of this.clients) client.close();
    this.server.close();
  }
}
