import type { LiveEventSource, SourceConfig, SourceEvent, SourceStatus } from "./LiveEventSource.js";

type Connector = {
  on(event: string, callback: (...args: unknown[]) => void): void;
  fetchRoomId?: () => Promise<string>;
  connect(roomId?: string): Promise<unknown>;
  disconnect(): Promise<void> | void;
  roomId?: string;
};

const connectorEvents = ["chat", "gift", "member", "like", "follow", "share", "social", "roomUser", "roomStats", "streamEnd"];

export class TikTokSource implements LiveEventSource {
  private connection?: Connector;
  private connected = false;
  private intentionalDisconnect = false;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private hasConnectedOnce = false;
  private lastResolvedRoomId?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private config: SourceConfig = {};
  private lastDecoded?: unknown;
  private lastRaw?: unknown;
  private readonly eventListeners: Array<(event: SourceEvent) => void> = [];
  private readonly statusListeners: Array<(status: SourceStatus) => void> = [];

  async connect(config: SourceConfig): Promise<void> {
    this.config = config;
    this.intentionalDisconnect = false;
    this.shouldReconnect = this.config.autoReconnect !== false;
    this.reconnectAttempt = 0;
    this.hasConnectedOnce = false;
    this.lastResolvedRoomId = undefined;
    await this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    const username = typeof this.config.username === "string" ? this.config.username.trim() : "";
    if (!username) throw new Error("TikTok username is required");

    this.lastDecoded = undefined;
    this.lastRaw = undefined;
    try {
      await this.connectWithOptions(this.config.enableExtendedGiftInfo !== false);
    } catch (error) {
      const roomId = this.lastResolvedRoomId ?? this.connection?.roomId;
      if (!this.intentionalDisconnect && roomId && isExtendedInfoFallbackError(error)) {
        await this.disposeCurrentConnection();
        try {
          await this.connectWithOptions(false, roomId);
          this.emitStatus({ source: "tiktok", status: "connected", username, roomId, connectedAt: Date.now(), message: "已连接；扩展礼物信息不可用，已使用基础礼物字段" });
          return;
        } catch (fallbackError) {
          this.handleConnectionFailure(fallbackError, username);
          throw fallbackError;
        }
      }
      this.handleConnectionFailure(error, username);
      throw error;
    }
  }

  private async connectWithOptions(enableExtendedGiftInfo: boolean, roomId?: string): Promise<void> {
    const username = String(this.config.username ?? "").trim();
    this.emitStatus({ source: "tiktok", status: "connecting", username, message: enableExtendedGiftInfo ? undefined : "正在使用基础礼物字段连接" });
    const connectorModule = await import("tiktok-live-connector");
    const Connection = (connectorModule as unknown as { TikTokLiveConnection: new (username: string, options: Record<string, unknown>) => Connector }).TikTokLiveConnection;

    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
    let webClientOptions: Record<string, unknown> | undefined;
    let wsClientOptions: Record<string, unknown> | undefined;
    if (proxyUrl) {
      try {
        const proxyModule = await import("https-proxy-agent");
        const HttpsProxyAgent = (proxyModule as unknown as { HttpsProxyAgent?: new (url: string) => unknown; default?: new (url: string) => unknown }).HttpsProxyAgent ?? (proxyModule as unknown as { default?: new (url: string) => unknown }).default ?? proxyModule;
        const agent = new (HttpsProxyAgent as new (url: string) => unknown)(proxyUrl);
        webClientOptions = { agent: { https: agent, http: agent } };
        wsClientOptions = { agent };
      } catch {
        // Fallback to direct connection if proxy agent initialization fails
      }
    }

    this.connection = new Connection(username.replace(/^@/, ""), {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo,
      authenticateWs: false,
      useMobile: false,
      ...(webClientOptions ? { webClientOptions } : {}),
      ...(wsClientOptions ? { wsClientOptions } : {}),
    });
    this.bindConnectorEvents(username);
    const resolvedRoomId = roomId ?? await this.connection.fetchRoomId?.();
    if (resolvedRoomId) this.lastResolvedRoomId = resolvedRoomId;
    const result = await this.connection.connect(resolvedRoomId);
    const connectedRoomId = extractRoomId(result) ?? resolvedRoomId ?? this.connection.roomId;
    this.connected = true;
    this.hasConnectedOnce = true;
    this.reconnectAttempt = 0;
    this.emitStatus({ source: "tiktok", status: "connected", username, roomId: connectedRoomId, connectedAt: Date.now(), message: enableExtendedGiftInfo ? undefined : "已连接；扩展礼物信息不可用，已使用基础礼物字段" });
  }

  private bindConnectorEvents(username: string): void {
    const connection = this.connection;
    if (!connection) return;
    for (const eventName of connectorEvents) {
      connection.on(eventName, (...args) => {
        const data = args[0];
        if (eventName === "streamEnd") {
          this.shouldReconnect = false;
          this.emitEvent({ type: eventName, data });
          this.connected = false;
          this.emitStatus({ source: "tiktok", status: "offline", username, message: "Stream ended" });
          return;
        }
        this.emitEvent({
          type: eventName,
          data,
          decoded: this.isDebug() ? this.lastDecoded : undefined,
          raw: this.storeRawEvents() ? this.lastRaw : undefined,
        });
      });
    }
    connection.on("connected", (data) => {
      const roomId = extractRoomId(data);
      this.connected = true;
      this.hasConnectedOnce = true;
      this.emitStatus({ source: "tiktok", status: "connected", username, roomId, connectedAt: Date.now() });
    });
    connection.on("decodedData", (...args) => {
      const method = String(args[0] ?? "unknown");
      const decoded = args[1] ?? args[0];
      const raw = args[2];
      this.lastDecoded = decoded;
      if (this.storeRawEvents()) this.lastRaw = raw;
      if (this.isDebug()) this.emitEvent({ type: "decodedData", data: decoded, decoded, raw, debug: true });
      if (!isKnownDecodedMethod(method)) this.emitEvent({ type: "unknown", data: decoded, decoded, raw: this.storeRawEvents() ? raw : undefined });
    });
    connection.on("rawData", (...args) => {
      const raw = args[1] ?? args[0];
      this.lastRaw = raw;
      if (this.isDebug()) this.emitEvent({ type: "rawData", data: raw, raw, debug: true });
    });
    connection.on("websocketConnected", () => {
      if (this.isDebug()) this.emitEvent({ type: "websocketConnected", data: { connected: true }, debug: true });
    });
    connection.on("disconnected", (data) => {
      this.connected = false;
      this.emitStatus({ source: "tiktok", status: "disconnected", username, message: String((data as { reason?: unknown })?.reason ?? "Disconnected") });
      if (!this.intentionalDisconnect && this.shouldReconnect && this.hasConnectedOnce) this.scheduleReconnect();
    });
    connection.on("error", (data) => {
      const message = errorMessage(data);
      this.emitEvent({ type: "error", data: { message } });
      this.emitStatus({ source: "tiktok", status: "error", username, error: message });
    });
  }

  private handleConnectionFailure(error: unknown, username: string): void {
    this.connected = false;
    const message = errorMessage(error);
    this.emitStatus({ source: "tiktok", status: "error", username, error: message });
    if (!this.intentionalDisconnect && this.shouldReconnect && this.hasConnectedOnce) this.scheduleReconnect();
  }

  private async disposeCurrentConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.connected = false;
    if (connection) {
      try { await connection.disconnect(); } catch { /* failed connections are already closed */ }
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.shouldReconnect = false;
    this.hasConnectedOnce = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connected = false;
    await this.disposeCurrentConnection();
    this.emitStatus({ source: "tiktok", status: "disconnected", username: String(this.config.username ?? "") });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(callback: (event: SourceEvent) => void): void {
    this.eventListeners.push(callback);
  }

  onStatus(callback: (status: SourceStatus) => void): void {
    this.statusListeners.push(callback);
  }

  private emitEvent(event: SourceEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private emitStatus(status: SourceStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  private isDebug(): boolean {
    return this.config.debug === true || process.env.DEBUG === "true" || process.env.DEBUG === "1";
  }

  private storeRawEvents(): boolean {
    return this.config.storeRawEvents === true || process.env.STORE_RAW_EVENTS === "true" || process.env.STORE_RAW_EVENTS === "1";
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalDisconnect || !this.shouldReconnect) return;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const base = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(100, base * 0.2)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectOnce().catch(() => undefined);
    }, base + jitter);
  }
}

function extractRoomId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const roomInfo = record.roomInfo && typeof record.roomInfo === "object" ? (record.roomInfo as Record<string, unknown>) : undefined;
  const roomId = record.roomId ?? record.room_id ?? roomInfo?.roomId ?? roomInfo?.room_id;
  return roomId === undefined || roomId === null ? undefined : String(roomId);
}

function isKnownDecodedMethod(method: string): boolean {
  const value = method.toLowerCase();
  return ["chat", "gift", "like", "member", "follow", "share", "social", "roomuser", "room_user", "roomstats", "streamend"].some((known) => value.includes(known));
}

function isExtendedInfoFallbackError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("business plan") || message.includes("fetchwebcastsignaturefromeuler") || message.includes("failed to sign a request");
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.exception) return `${String(record.info ?? "")}: ${errorMessage(record.exception)}`.trim();
    if (record.message) return String(record.message);
  }
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
