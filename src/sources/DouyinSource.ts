import { createHash, timingSafeEqual } from "node:crypto";
import type { LiveEventSource, SourceConfig, SourceEvent, SourceStatus } from "./LiveEventSource.js";

export const DOUYIN_MESSAGE_TYPES = ["live_comment", "live_like", "live_gift"] as const;
export type DouyinMessageType = (typeof DOUYIN_MESSAGE_TYPES)[number];

export interface DouyinGiftCatalogEntry {
  name: string;
  valueFen?: number;
}

export interface DouyinConnectConfig extends SourceConfig {
  roomId: string;
  appId: string;
  accessToken: string;
  pushSecret: string;
  giftCatalog?: Record<string, DouyinGiftCatalogEntry>;
}

export interface DouyinTaskView {
  messageType: DouyinMessageType;
  status: "idle" | "starting" | "running" | "stopping" | "error";
  taskId?: string;
  error?: string;
}

export interface DouyinDiagnostics {
  tasks: Record<DouyinMessageType, DouyinTaskView>;
  acceptedCallbacks: number;
  duplicateMessages: number;
  filteredTestMessages: number;
  invalidCallbacks: number;
  lastCallbackAt?: number;
}

type FetchLike = typeof fetch;
type HeaderRecord = Record<string, string | string[] | undefined>;
type PushItem = Record<string, unknown>;

interface DouyinApiResponse {
  err_no?: number;
  err_msg?: string;
  logid?: string;
  data?: { task_id?: string };
}

const API_ROOT = "https://webcast.bytedance.com/api/live_data/task";
const SIGNED_HEADER_NAMES = ["x-msg-type", "x-nonce-str", "x-roomid", "x-timestamp"] as const;

export function createDouyinPushSignature(headers: HeaderRecord, body: string, secret: string): string {
  const prefix = SIGNED_HEADER_NAMES
    .map((name) => [name, headerValue(headers, name)] as const)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const rawData = `${prefix}${body}${secret}`;
  return createHash("md5").update(rawData, "utf8").digest("base64");
}

export class DouyinSource implements LiveEventSource {
  private readonly eventCallbacks = new Set<(event: SourceEvent) => void>();
  private readonly statusCallbacks = new Set<(status: SourceStatus) => void>();
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageOrder: string[] = [];
  private connected = false;
  private config?: DouyinConnectConfig;
  private acceptedCallbacks = 0;
  private duplicateMessages = 0;
  private filteredTestMessages = 0;
  private invalidCallbacks = 0;
  private lastCallbackAt?: number;
  private readonly tasks = Object.fromEntries(DOUYIN_MESSAGE_TYPES.map((messageType) => [messageType, { messageType, status: "idle" }])) as Record<DouyinMessageType, DouyinTaskView>;

  constructor(private readonly fetcher: FetchLike = fetch) {}

  async connect(rawConfig: SourceConfig): Promise<void> {
    const config = this.validateConfig(rawConfig);
    if (this.connected) await this.disconnect();
    this.config = config;
    this.emitStatus({ source: "douyin", status: "connecting", roomId: config.roomId, message: "正在启动抖音评论、点赞和礼物推送任务" });
    const started: DouyinMessageType[] = [];
    try {
      for (const messageType of DOUYIN_MESSAGE_TYPES) {
        this.tasks[messageType] = { messageType, status: "starting" };
        const result = await this.callTaskApi("start", messageType);
        this.tasks[messageType] = { messageType, status: "running", taskId: result.data?.task_id };
        started.push(messageType);
      }
      this.connected = true;
      this.emitStatus({ source: "douyin", status: "connected", roomId: config.roomId, connectedAt: Date.now(), message: "抖音三类数据推送任务运行中" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const messageType of DOUYIN_MESSAGE_TYPES) {
        if (this.tasks[messageType].status === "starting") this.tasks[messageType] = { messageType, status: "error", error: message };
      }
      await Promise.allSettled(started.map((messageType) => this.callTaskApi("stop", messageType)));
      for (const messageType of started) this.tasks[messageType] = { messageType, status: "idle" };
      this.connected = false;
      this.emitStatus({ source: "douyin", status: "error", roomId: config.roomId, error: message, message: "抖音数据任务启动失败" });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const config = this.config;
    if (!config) return;
    const failures: string[] = [];
    for (const messageType of DOUYIN_MESSAGE_TYPES) {
      if (this.tasks[messageType].status !== "running") continue;
      this.tasks[messageType] = { ...this.tasks[messageType], status: "stopping" };
      try {
        await this.callTaskApi("stop", messageType);
        this.tasks[messageType] = { messageType, status: "idle" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${messageType}: ${message}`);
        this.tasks[messageType] = { ...this.tasks[messageType], status: "error", error: message };
      }
    }
    this.connected = false;
    this.emitStatus({ source: "douyin", status: failures.length ? "error" : "disconnected", roomId: config.roomId, error: failures.length ? failures.join("；") : undefined, message: failures.length ? "部分抖音任务停止失败" : "抖音数据任务已停止" });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(callback: (event: SourceEvent) => void): void {
    this.eventCallbacks.add(callback);
  }

  onStatus(callback: (status: SourceStatus) => void): void {
    this.statusCallbacks.add(callback);
  }

  diagnostics(): DouyinDiagnostics {
    return {
      tasks: structuredClone(this.tasks),
      acceptedCallbacks: this.acceptedCallbacks,
      duplicateMessages: this.duplicateMessages,
      filteredTestMessages: this.filteredTestMessages,
      invalidCallbacks: this.invalidCallbacks,
      lastCallbackAt: this.lastCallbackAt,
    };
  }

  acceptPush(headers: HeaderRecord, body: string): { accepted: number; duplicates: number; filteredTests: number } {
    const config = this.config;
    if (!config) throw new Error("抖音数据任务尚未启动");
    const roomId = headerValue(headers, "x-roomid");
    const messageType = headerValue(headers, "x-msg-type") as DouyinMessageType;
    if (roomId !== config.roomId) return this.rejectCallback("回调房间 ID 与当前任务不一致");
    if (!DOUYIN_MESSAGE_TYPES.includes(messageType)) return this.rejectCallback("不支持的抖音消息类型");
    const receivedSignature = headerValue(headers, "x-signature");
    const expectedSignature = createDouyinPushSignature(headers, body, config.pushSecret);
    if (!safeEqual(receivedSignature, expectedSignature)) return this.rejectCallback("抖音回调签名校验失败");

    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return this.rejectCallback("抖音回调不是有效 JSON");
    }
    const items = Array.isArray(decoded) ? decoded : [decoded];
    let accepted = 0;
    let duplicates = 0;
    let filteredTests = 0;
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as PushItem;
      const messageId = stringValue(item.msg_id);
      if (messageId && this.seenMessageIds.has(messageId)) {
        duplicates += 1;
        this.duplicateMessages += 1;
        continue;
      }
      if (messageId) this.rememberMessage(messageId);
      if (messageType === "live_gift" && item.test === true) {
        filteredTests += 1;
        this.filteredTestMessages += 1;
        continue;
      }
      const sourceEvent = this.mapPushItem(messageType, item);
      for (const callback of this.eventCallbacks) callback(sourceEvent);
      accepted += 1;
      this.acceptedCallbacks += 1;
    }
    this.lastCallbackAt = Date.now();
    return { accepted, duplicates, filteredTests };
  }

  private validateConfig(rawConfig: SourceConfig): DouyinConnectConfig {
    const roomId = stringValue(rawConfig.roomId);
    const appId = stringValue(rawConfig.appId);
    const accessToken = stringValue(rawConfig.accessToken);
    const pushSecret = stringValue(rawConfig.pushSecret);
    if (!roomId) throw new Error("缺少抖音直播间房间 ID");
    if (!appId) throw new Error("缺少抖音小玩法 AppID");
    if (!accessToken) throw new Error("缺少抖音 access token");
    if (!pushSecret) throw new Error("缺少抖音数据推送密钥");
    return { ...rawConfig, roomId, appId, accessToken, pushSecret, giftCatalog: normalizeGiftCatalog(rawConfig.giftCatalog) };
  }

  private async callTaskApi(action: "start" | "stop", messageType: DouyinMessageType): Promise<DouyinApiResponse> {
    if (!this.config) throw new Error("抖音连接配置尚未初始化");
    const response = await this.fetcher(`${API_ROOT}/${action}`, {
      method: "POST",
      headers: { "access-token": this.config.accessToken, "content-type": "application/json" },
      body: JSON.stringify({ roomid: this.config.roomId, appid: this.config.appId, msg_type: messageType }),
    });
    const result = await response.json() as DouyinApiResponse;
    if (!response.ok || result.err_no !== 0) {
      throw new Error(`抖音 ${messageType} 任务${action === "start" ? "启动" : "停止"}失败：${result.err_msg || `HTTP ${response.status}`}${result.logid ? `（logid: ${result.logid}）` : ""}`);
    }
    return result;
  }

  private mapPushItem(messageType: DouyinMessageType, item: PushItem): SourceEvent {
    const user = {
      userId: stringValue(item.sec_openid),
      uniqueId: stringValue(item.sec_openid),
      nickname: stringValue(item.nickname) || "抖音观众",
      avatarUrl: stringValue(item.avatar_url),
    };
    const common = { user, msgId: stringValue(item.msg_id), timestamp: numberValue(item.timestamp) };
    if (messageType === "live_comment") {
      return { type: "chat", data: { ...common, content: stringValue(item.content) }, platformTimestamp: normalizeTimestamp(item.timestamp), raw: item };
    }
    if (messageType === "live_like") {
      return { type: "like", data: { ...common, likeCount: Math.max(1, numberValue(item.like_num) || 1) }, platformTimestamp: normalizeTimestamp(item.timestamp), raw: item };
    }
    const giftId = stringValue(item.sec_gift_id) || "unknown";
    const count = Math.max(1, numberValue(item.gift_num) || 1);
    const totalValueFen = Math.max(0, numberValue(item.gift_value) || 0);
    const catalogEntry = this.config?.giftCatalog?.[giftId];
    return {
      type: "gift",
      data: {
        ...common,
        giftId,
        giftName: catalogEntry?.name || "抖音礼物",
        count,
        diamondCount: count > 0 ? totalValueFen / count : totalValueFen,
        giftValueFen: totalValueFen,
        repeatEnd: true,
      },
      platformTimestamp: normalizeTimestamp(item.timestamp),
      raw: item,
    };
  }

  private rememberMessage(messageId: string): void {
    this.seenMessageIds.add(messageId);
    this.seenMessageOrder.push(messageId);
    if (this.seenMessageOrder.length <= 20_000) return;
    const oldest = this.seenMessageOrder.shift();
    if (oldest) this.seenMessageIds.delete(oldest);
  }

  private rejectCallback(message: string): never {
    this.invalidCallbacks += 1;
    throw new Error(message);
  }

  private emitStatus(status: SourceStatus): void {
    for (const callback of this.statusCallbacks) callback(status);
  }
}

function headerValue(headers: HeaderRecord, name: string): string {
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(direct) ? String(direct[0] ?? "") : String(direct ?? "");
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTimestamp(value: unknown): number | undefined {
  const parsed = numberValue(value);
  if (!parsed) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeGiftCatalog(value: unknown): Record<string, DouyinGiftCatalogEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, DouyinGiftCatalogEntry]> = [];
  for (const [id, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawEntry === "string" && rawEntry.trim()) entries.push([id, { name: rawEntry.trim() }]);
    else if (rawEntry && typeof rawEntry === "object") {
      const entry = rawEntry as Record<string, unknown>;
      const name = stringValue(entry.name);
      if (name) entries.push([id, { name, valueFen: numberValue(entry.valueFen) || undefined }]);
    }
  }
  return Object.fromEntries(entries);
}
