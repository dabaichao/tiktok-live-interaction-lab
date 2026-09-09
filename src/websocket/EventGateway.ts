import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { NormalizedLiveEvent } from "../core/events.js";

export interface GatewayLogger {
  info(data: object, message?: string): void;
  warn(data: object, message?: string): void;
}

type RecentEventsProvider = () => NormalizedLiveEvent[];

export class EventGateway {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly logger: GatewayLogger, private readonly maxBufferedBytes = 1024 * 1024, private readonly recentEvents: RecentEventsProvider = () => []) {
    this.server.on("connection", (socket, request) => {
      this.clients.add(socket);
      this.logger.info({ path: request.url }, "ws_client_connected");
      socket.send(JSON.stringify({ op: "hello", protocol: "tiktok-live-lab", version: 1 }));
      // Send the retained history oldest-first because the dashboard prepends
      // each incoming event, preserving newest-first display order.
      for (const event of [...this.recentEvents()].reverse()) socket.send(safeStringify({ op: "event", event }));
      socket.on("close", () => {
        this.clients.delete(socket);
        this.logger.info({}, "ws_client_disconnected");
      });
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  attach(httpServer: HttpServer, paths = ["/events", "/ws/events"]): void {
    httpServer.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!paths.includes(path)) return;
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    });
  }

  broadcastEvent(event: NormalizedLiveEvent): void {
    this.broadcast({ op: "event", event });
  }

  broadcastDebug(data: unknown): void {
    this.broadcast({ op: "debug", data });
  }

  close(): void {
    for (const client of this.clients) client.close();
    this.server.close();
  }

  private broadcast(message: unknown): void {
    const serialized = safeStringify(message);
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
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") return String(current);
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  });
}
