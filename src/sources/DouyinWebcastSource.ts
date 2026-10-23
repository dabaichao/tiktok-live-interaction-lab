import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { LiveEventSource, SourceConfig, SourceEvent, SourceStatus } from "./LiveEventSource.js";

export interface WebcastBridgeMessage {
  id?: string;
  bridgeId?: string;
  method?: string;
  user?: { id?: string; displayId?: string; shortId?: string; name?: string; avatar?: string; identityLimited?: boolean; nicknameMasked?: boolean };
  gift?: { id?: string; name?: string; icon?: string; price?: number; type?: number; count?: number | string; repeatEnd?: number; groupId?:string };
  count?: number | string;
  content?: string;
  socialAction?: string | number;
  room?: { audienceCount?: number | string; likeCount?: number | string; totalUserCount?: number | string; followCount?: number | string; status?: number };
}

export interface DouyinWebcastDiagnostics {
  ended: boolean;
  bridgeExpired: boolean;
  webRid?: string;
  roomId?: string;
  title?: string;
  connectedBy?: "browser-webcast";
  acceptedMessages: number;
  duplicateMessages: number;
  lastMessageAt?: number;
  reconnectCount: number;
  limitedIdentityMessages: number;
  maskedNicknameMessages: number;
  acceptedByMethod: Record<string, number>;
  decoder: Record<string, unknown>;
}

export class DouyinWebcastSource implements LiveEventSource {
  private readonly eventCallbacks = new Set<(event: SourceEvent) => void>();
  private readonly statusCallbacks = new Set<(status: SourceStatus) => void>();
  private readonly bridgeExpiredCallbacks = new Set<() => void>();
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private connected = false;
  private sessionToken?: string;
  private webRid?: string;
  private roomId?: string;
  private title?: string;
  private acceptedMessages = 0;
  private duplicateMessages = 0;
  private lastMessageAt?: number;
  private reconnectCount = 0;
  private limitedIdentityMessages = 0;
  private maskedNicknameMessages = 0;
  private acceptedByMethod: Record<string, number> = {};
  private decoder: Record<string, unknown> = {};
  private lastBridgeAt = 0;
  private ended = false;
  private bridgeExpired = false;
  private bridgeLeaseTimer?: ReturnType<typeof setTimeout>;
  private readonly bridgeLeaseMs = 60_000;

  async connect(config: SourceConfig): Promise<void> {
    const webRid = parseDouyinWebRid(String(config.webRid ?? config.url ?? config.roomId ?? ""));
    if (!webRid) throw new Error("请输入有效的抖音直播间链接或 web_rid");
    this.clearBridgeLeaseTimer();
    this.webRid = webRid;
    this.roomId = undefined;
    this.title = undefined;
    this.sessionToken = randomUUID();
    this.acceptedMessages = 0;
    this.duplicateMessages = 0;
    this.lastMessageAt = undefined;
    this.reconnectCount = 0;
    this.limitedIdentityMessages = 0;
    this.maskedNicknameMessages = 0;
    this.acceptedByMethod = {};
    this.decoder = {};
    this.seenIds.clear();
    this.seenOrder.length = 0;
    this.connected = false;
    this.ended = false;
    this.bridgeExpired = false;
    this.touchBridgeLease();
    this.emitStatus({ source: "douyin", status: "connecting", username: webRid, message: "正在解析直播间并连接 Webcast" });
  }

  async disconnect(): Promise<void> {
    this.close();
    this.emitStatus({ source: "douyin", status: "disconnected", roomId: this.roomId, username: this.webRid, message: "抖音 Webcast 已断开" });
  }

  isConnected(): boolean {
    // A crashed/suspended renderer cannot send its close-state HTTP request.
    // The browser reports diagnostics every 2s; expire that bridge lease.
    this.expireBridgeLease();
    return this.connected;
  }

  hasActiveBridge(): boolean {
    this.expireBridgeLease();
    return Boolean(this.sessionToken) && !this.ended;
  }

  transportState(status: "connecting" | "disconnected" | "error", message?: string): void {
    if (this.expireBridgeLease() || !this.sessionToken) return;
    // Server-side socket activity is not proof that the browser is alive.
    this.applyState({ status, message });
  }

  onEvent(callback: (event: SourceEvent) => void): void {
    this.eventCallbacks.add(callback);
  }

  onStatus(callback: (status: SourceStatus) => void): void {
    this.statusCallbacks.add(callback);
  }

  onBridgeExpired(callback: () => void): void {
    this.bridgeExpiredCallbacks.add(callback);
  }

  close(): void {
    this.clearBridgeLeaseTimer();
    this.connected = false;
    this.sessionToken = undefined;
  }

  connectionInstructions(): { sessionToken: string; webRid: string } {
    this.expireBridgeLease();
    if (!this.sessionToken || !this.webRid) throw new Error("Webcast 快速连接尚未初始化");
    return { sessionToken: this.sessionToken, webRid: this.webRid };
  }

  updateState(token: string, state: { status?: string; roomId?: string; title?: string; message?: string; reconnectCount?: number }): void {
    this.assertToken(token);
    this.touchBridgeLease();
    this.applyState(state);
  }

  private applyState(state: { status?: string; roomId?: string; title?: string; message?: string; reconnectCount?: number }): void {
    // End is terminal, including delayed/ambiguous HTTP responses.
    if (this.ended && state.status !== "disconnected") return;
    if (state.roomId) this.roomId = state.roomId;
    if (state.title) this.title = state.title;
    if (typeof state.reconnectCount === "number") this.reconnectCount = state.reconnectCount;
    if (state.status === "connected") {
      this.connected = true;
      this.emitStatus({ source: "douyin", status: "connected", roomId: this.roomId, username: this.webRid, connectedAt: Date.now(), message: state.message || "抖音 Webcast 已连接" });
    } else if (state.status === "reconnecting" || state.status === "connecting") {
      this.connected = false;
      this.emitStatus({ source: "douyin", status: "connecting", roomId: this.roomId, username: this.webRid, message: state.message || "抖音 Webcast 正在重连" });
    } else if (state.status === "error") {
      this.connected = false;
      this.emitStatus({ source: "douyin", status: "error", roomId: this.roomId, username: this.webRid, error: state.message || "Webcast 连接失败", message: "抖音 Webcast 连接失败" });
    } else if (state.status === "disconnected") {
      this.connected = false;
      this.emitStatus({ source: "douyin", status: "disconnected", roomId: this.roomId, username: this.webRid, message: state.message || "抖音 Webcast 已断开" });
    }
  }

  acceptMessages(token: string, messages: WebcastBridgeMessage[]): { accepted: number; duplicates: number; ended: boolean } {
    this.assertToken(token);
    this.touchBridgeLease();
    let accepted = 0;
    let duplicates = 0;
    if (messages.length > 500) throw new Error("单批互动消息超过 500 条，请分批发送。");
    for (const message of messages) {
      if (this.ended) break;
      if (!message || typeof message !== "object") continue;
      const id = text(message.id) || text(message.bridgeId);
      if (id && this.seenIds.has(id)) {
        this.duplicateMessages += 1;
        duplicates += 1;
        continue;
      }
      if (id) this.remember(id);
      const event = mapWebcastMessage(message);
      if (!event) continue;
      if (event.data && typeof event.data === "object") {
        const data = event.data as Record<string, unknown>;
        const eventUser = data.user && typeof data.user === "object" ? data.user as Record<string, unknown> : {};
        if (eventUser.identityLimited === true) this.limitedIdentityMessages += 1;
        if (eventUser.nicknameMasked === true) this.maskedNicknameMessages += 1;
      }
      for (const callback of this.eventCallbacks) callback(event);
      if (event.type === "stream_end") {
        this.ended = true;
        this.clearBridgeLeaseTimer();
        this.transportState("disconnected", "直播已结束，请连接正在直播的房间。");
      }
      this.acceptedMessages += 1;
      const method = text(message.method);
      this.acceptedByMethod[method] = (this.acceptedByMethod[method] || 0) + 1;
      accepted += 1;
    }
    if (accepted) this.lastMessageAt = Date.now();
    return { accepted, duplicates, ended: this.ended };
  }

  diagnostics(): DouyinWebcastDiagnostics {
    return { ended: this.ended, bridgeExpired: this.bridgeExpired, webRid: this.webRid, roomId: this.roomId, title: this.title, connectedBy: this.webRid ? "browser-webcast" : undefined, acceptedMessages: this.acceptedMessages, duplicateMessages: this.duplicateMessages, lastMessageAt: this.lastMessageAt, reconnectCount: this.reconnectCount, limitedIdentityMessages: this.limitedIdentityMessages, maskedNicknameMessages: this.maskedNicknameMessages, acceptedByMethod: { ...this.acceptedByMethod }, decoder: structuredClone(this.decoder) };
  }

  updateDiagnostics(token: string, value: unknown): void {
    this.assertToken(token);
    this.touchBridgeLease();
    const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const result: Record<string, unknown> = {};
    for (const key of ["frames", "frameErrors", "lastFrameAt"]) result[key] = boundedCount(input[key]);
    for (const key of ["rawMethods", "decodedMethods", "droppedMethods", "decodeErrors"]) {
      const counts: Record<string, number> = {};
      if (input[key] && typeof input[key] === "object") {
        for (const [method, count] of Object.entries(input[key] as object).slice(0, 65)) {
          if (/^Webcast[A-Za-z0-9_]{1,80}$/.test(method) || method === "other") counts[method] = boundedCount(count);
        }
      }
      result[key] = counts;
    }
    // Optional for old browser clients. Keep only a fixed finite reason set;
    // untrusted diagnostic strings/payload fragments must not be persisted.
    const failureReasons: Record<string, Record<string, number>> = {};
    const allowedReasons = ["like_payload_decode_failed", "like_count_invalid", "like_count_zero", "like_user_mapping_failed", "like_event_mapping_failed", "upstream_decoder_failed", "upstream_decoder_returned_empty", "gift_postprocess_failed", "social_postprocess_failed"];
    if (input.decodeFailureReasons && typeof input.decodeFailureReasons === "object" && !Array.isArray(input.decodeFailureReasons)) {
      for (const [method, reasons] of Object.entries(input.decodeFailureReasons as object).slice(0, 65)) {
        if ((!/^Webcast[A-Za-z0-9_]{1,80}$/.test(method) && method !== "other") || !reasons || typeof reasons !== "object" || Array.isArray(reasons)) continue;
        const counts: Record<string, number> = {};
        for (const reason of allowedReasons) {
          if (Object.prototype.hasOwnProperty.call(reasons, reason)) counts[reason] = boundedCount((reasons as Record<string, unknown>)[reason]);
        }
        if (Object.keys(counts).length) failureReasons[method] = counts;
      }
    }
    result.decodeFailureReasons = failureReasons;
    this.decoder = result;
    const delivery = input.delivery as Record<string, unknown> | undefined;
    if (delivery && typeof delivery === "object") result.delivery = Object.fromEntries(["pendingMessages", "pendingBytes", "retryCount", "oldestPendingMs", "overflowMessages"].map(key => [key, boundedCount(delivery[key])]));
  }

  private assertToken(token: string): void {
    // A delayed heartbeat must not resurrect an already expired lease, even
    // when event-loop suspension prevented the timer from running on time.
    this.expireBridgeLease();
    if (!this.sessionToken || !safeTokenEqual(token, this.sessionToken)) throw new Error("Webcast 会话已失效，请重新快速连接");
  }

  private touchBridgeLease(): void {
    if (this.ended || !this.sessionToken) return;
    this.lastBridgeAt = Date.now();
    this.scheduleBridgeExpiry();
  }

  private scheduleBridgeExpiry(): void {
    this.clearBridgeLeaseTimer();
    const token = this.sessionToken;
    if (!token || this.ended) return;
    this.bridgeLeaseTimer = setTimeout(() => {
      this.bridgeLeaseTimer = undefined;
      if (token !== this.sessionToken || this.ended) return;
      if (!this.expireBridgeLease()) this.scheduleBridgeExpiry();
    }, Math.max(1, this.bridgeLeaseMs - (Date.now() - this.lastBridgeAt)));
    this.bridgeLeaseTimer.unref();
  }

  private clearBridgeLeaseTimer(): void {
    if (this.bridgeLeaseTimer) clearTimeout(this.bridgeLeaseTimer);
    this.bridgeLeaseTimer = undefined;
  }

  private expireBridgeLease(): boolean {
    if (!this.sessionToken || this.ended || Date.now() - this.lastBridgeAt < this.bridgeLeaseMs) return false;
    this.close();
    this.bridgeExpired = true;
    this.emitStatus({ source: "douyin", status: "disconnected", roomId: this.roomId, username: this.webRid, message: "后台页面超过 60 秒未响应，数据连接已释放；请刷新页面并重新连接直播间，登录缓存仍保留。" });
    for (const callback of this.bridgeExpiredCallbacks) callback();
    return true;
  }

  private remember(id: string): void {
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length <= 20_000) return;
    const oldest = this.seenOrder.shift();
    if (oldest) this.seenIds.delete(oldest);
  }

  private emitStatus(status: SourceStatus): void {
    for (const callback of this.statusCallbacks) callback(status);
  }
}

export function parseDouyinWebRid(input: string): string | undefined {
  const normalized = input.trim();
  if (/^[a-zA-Z0-9_-]{5,40}$/.test(normalized)) return normalized;
  try {
    const url = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    if (!/(^|\.)live\.douyin\.com$/i.test(url.hostname)) return undefined;
    const candidate = url.pathname.split("/").filter(Boolean)[0];
    return candidate && /^[a-zA-Z0-9_-]{5,40}$/.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function mapWebcastMessage(message: WebcastBridgeMessage): SourceEvent | undefined {
  const method = text(message.method);
  const nickname = text(message.user?.name) || "抖音观众";
  const nicknameMasked = message.user?.nicknameMasked === true || isMaskedNickname(nickname);
  const platformId = [message.user?.id, message.user?.displayId, message.user?.shortId].map(usableUserId).find(Boolean);
  // Anonymous Webcast may provide the same placeholder account ID (111111)
  // for every viewer. A deterministic opaque fallback keeps visibly different
  // masked viewers separate without pretending to know their real account ID.
  const fallbackId = opaqueLimitedIdentity(nickname, text(message.user?.avatar));
  const userId = platformId || fallbackId;
  const identityLimited = message.user?.identityLimited === true || !platformId;
  const user = { userId, uniqueId: platformId || undefined, nickname, avatarUrl: text(message.user?.avatar), identityLimited, nicknameMasked };
  const common = { msgId: text(message.id) || text(message.bridgeId), user };
  if (method === "WebcastChatMessage" || method === "WebcastEmojiChatMessage") return { type: "chat", data: { ...common, content: text(message.content) }, raw: message };
  if (method === "WebcastLikeMessage" || method === "WebcastChatLikeMessage") {
    const count = Number(message.count ?? text(message.content).match(/\((\d+)\)/)?.[1]);
    if (!Number.isFinite(count) || count <= 0) return undefined;
    return { type: "like", data: { ...common, likeCount: count, totalLikes: optionalNumber(message.room?.likeCount) }, raw: message };
  }
  if (method === "WebcastGiftMessage") return { type: "gift", data: { ...common, giftId: text(message.gift?.id), giftName: text(message.gift?.name) || "抖音礼物", count: Math.max(1, number(message.gift?.count) || 1), giftType: message.gift?.type, repeatEnd: message.gift?.repeatEnd === 1, diamondCount: Math.max(0, number(message.gift?.price)), giftIcon: text(message.gift?.icon), giftGroupId:text(message.gift?.groupId) }, raw: message };
  if (method === "WebcastMemberMessage") return { type: "join", data: { ...common, viewerCount: number(message.room?.audienceCount) }, raw: message };
  if (method === "WebcastSocialMessage") {
    const action=text(message.socialAction);
    // Unknown/new actions stay observable but never pretend to be a follow.
    return { type:action==="1"?"follow":action==="3"?"share":"social",data:{...common,socialAction:action},raw:message };
  }
  if (method === "WebcastRoomUserSeqMessage" || method === "WebcastRoomStatsMessage") return { type: "room_stats", data: { viewerCount: optionalNumber(message.room?.audienceCount), totalLikes: optionalNumber(message.room?.likeCount), totalUserCount: optionalNumber(message.room?.totalUserCount) }, raw: message };
  if (method === "WebcastControlMessage" && number(message.room?.status) >= 3) return { type: "stream_end", data: { content: text(message.content) }, raw: message };
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

const unusableUserIds = new Set(["", "0", "-1", "111111", "null", "undefined"]);

function usableUserId(value: unknown): string | undefined {
  const id = text(value);
  return unusableUserIds.has(id.toLowerCase()) || /[*＊]/u.test(id) ? undefined : id;
}

function isMaskedNickname(value: string): boolean {
  return /[*＊]{2,}/u.test(value);
}

function opaqueLimitedIdentity(nickname: string, avatar: string): string {
  const digest = createHash("sha256").update(`${nickname}\u0000${avatar}`).digest("hex").slice(0, 24);
  return `douyin-limited:${digest}`;
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
