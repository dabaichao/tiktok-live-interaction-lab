import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { GatewayLogger } from "../websocket/EventGateway.js";

export type SemanticGameMessage = Record<string, unknown>;

export class SemanticGameGateway {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  private readonly pending = new Map<string, SemanticGameMessage>();
  private pendingGuesses: unknown[] = [];
  private flushTimer?: NodeJS.Timeout;
  private slowClients = 0;

  constructor(private readonly logger: GatewayLogger, private readonly getSnapshot: () => SemanticGameMessage, private readonly access: {allowedOrigins?:string[]} = {}) {
    this.server.on("connection", (socket, request) => {
      this.clients.add(socket);
      this.logger.info({ path: request.url }, "ws_client_connected");
      this.send(socket, JSON.stringify(this.getSnapshot()));
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as { type?: string };
          if (message.type === "REQUEST_SNAPSHOT") this.send(socket, JSON.stringify(this.getSnapshot()));
          if (message.type === "PING") this.send(socket, JSON.stringify({ type: "PONG", timestamp: Date.now() }));
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
      if (!this.allowRequest(request)) { socket.destroy(); return; }
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    });
  }

  private allowRequest(request:IncomingMessage):boolean {
    const address=request.socket.remoteAddress;
    if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(address??""))return false;
    try {
      const host=new URL(`http://${request.headers.host}`);
      if(!["127.0.0.1","localhost","[::1]"].includes(host.hostname)||host.username||host.password)return false;
      const origin=request.headers.origin;
      // OBS/local scripts without Origin remain compatible. Browser origins
      // must be the configured local page or this socket's own HTTP origin.
      if(origin===undefined)return true;
      const value=new URL(origin);
      if(!["http:","https:"].includes(value.protocol)||value.origin!==origin)return false;
      return value.origin===host.origin || this.access.allowedOrigins?.includes(value.origin)===true;
    } catch {return false;}
  }

  broadcast(message: SemanticGameMessage): void {
    const type = String(message.type);
    if (["GUESS_ACCEPTED", "ROOM_STATS", "ACTIVITY"].includes(type)) {
      this.pending.set(type, message);
      if (type === "GUESS_ACCEPTED" && message.guess) {
        this.pendingGuesses.push(message.guess);
        this.pendingGuesses = this.pendingGuesses.slice(-3);
      }
      // Coalesce presentation only; scoring and execution logs remain exact.
      this.flushTimer ??= setTimeout(() => this.flushPending(), 100);
      this.flushTimer.unref();
      return;
    }
    if (type.startsWith("ROUND_") || type === "ROOM_SNAPSHOT" || type === "HINT_UNLOCKED") this.flushPending();
    this.broadcastNow(message);
  }

  diagnostics() { return { clients: this.clients.size, slowClientsDisconnected: this.slowClients, pendingFrames: this.pending.size }; }

  private flushPending(): void {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    for (const [type, message] of this.pending) this.broadcastNow(type === "GUESS_ACCEPTED" ? { ...message, recentGuesses: this.pendingGuesses } : message);
    this.pending.clear(); this.pendingGuesses = [];
  }

  private send(client: WebSocket, serialized: string): void {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 2 * 1024 * 1024) {
      this.slowClients++; client.terminate(); return;
    }
    client.send(serialized, error => { if (error) client.terminate(); });
  }

  private broadcastNow(message: SemanticGameMessage): void {
    const serialized = JSON.stringify(message);
    for (const client of this.clients) this.send(client, serialized);
  }

  close(): void {
    clearTimeout(this.flushTimer); this.pending.clear(); this.pendingGuesses = [];
    for (const client of this.clients) client.terminate();
    this.server.close();
  }
}
