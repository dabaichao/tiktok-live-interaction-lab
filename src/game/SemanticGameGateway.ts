import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { GatewayLogger } from "../websocket/EventGateway.js";

export type SemanticGameMessage = Record<string, unknown>;

export class SemanticGameGateway {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly logger: GatewayLogger, private readonly getSnapshot: () => SemanticGameMessage) {
    this.server.on("connection", (socket, request) => {
      this.clients.add(socket);
      this.logger.info({ path: request.url }, "ws_client_connected");
      socket.send(JSON.stringify(this.getSnapshot()));
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as { type?: string };
          if (message.type === "REQUEST_SNAPSHOT") socket.send(JSON.stringify(this.getSnapshot()));
          if (message.type === "PING") socket.send(JSON.stringify({ type: "PONG", timestamp: Date.now() }));
        } catch {
          // Ignore malformed browser messages; the game is server-authoritative.
        }
      });
      socket.on("close", () => {
        this.clients.delete(socket);
        this.logger.info({}, "ws_client_disconnected");
      });
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  attach(httpServer: HttpServer, paths = ["/word-game", "/ws/word-game"]): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!paths.includes(path)) return;
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    });
  }

  broadcast(message: SemanticGameMessage): void {
    const serialized = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  }

  close(): void {
    for (const client of this.clients) client.close();
    this.server.close();
  }
}
