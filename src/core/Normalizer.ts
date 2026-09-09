import { randomUUID } from "node:crypto";
import type { EventUser, NormalizedEventType, NormalizedLiveEvent } from "./events.js";
import { GiftComboTracker, type GiftComboInput } from "./GiftComboTracker.js";
import type { SourceEvent, SourceKind } from "../sources/LiveEventSource.js";

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value !== null && typeof value === "object" ? (value as AnyRecord) : {};
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

function pick(source: AnyRecord, ...keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function extractAvatarUrl(user: AnyRecord, data: AnyRecord): string | undefined {
  const direct = stringValue(
    pick(user, "avatarUrl", "avatar", "profilePictureUrl"),
    pick(data, "avatarUrl", "avatar", "profilePictureUrl"),
  );
  if (direct) return direct;
  for (const objKey of ["avatarThumb", "avatarMedium", "avatarLarge", "avatarJpg"]) {
    const avatarObj = asRecord(user[objKey] ?? data[objKey]);
    if (Array.isArray(avatarObj.urlList) && avatarObj.urlList.length > 0) {
      const first = avatarObj.urlList[0];
      if (typeof first === "string" && first.length > 0) return first;
    }
  }
  return undefined;
}

function userFrom(data: AnyRecord): EventUser | undefined {
  const user = asRecord(pick(data, "user", "author", "member", "userInfo"));
  const result: EventUser = {
    id: stringValue(pick(user, "id", "userId"), pick(data, "userId", "uid")),
    uniqueId: stringValue(
      pick(user, "uniqueId", "unique_id", "displayId", "username"),
      pick(data, "uniqueId", "unique_id", "displayId", "username"),
    ),
    nickname: stringValue(pick(user, "nickname", "displayName", "name"), pick(data, "nickname", "displayName")),
    avatarUrl: extractAvatarUrl(user, data),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function payloadWithoutUser(data: AnyRecord): AnyRecord {
  const payload = { ...data };
  delete payload.user;
  delete payload.author;
  delete payload.member;
  delete payload.userInfo;
  return payload;
}

function mapType(type: string): NormalizedEventType {
  const normalized = type.toLowerCase();
  if (normalized === "chat" || normalized === "comment") return "chat";
  if (normalized === "gift") return "gift";
  if (normalized === "like") return "like";
  if (normalized === "member" || normalized === "join") return "join";
  if (normalized === "roomuser" || normalized === "room_user") return "room_stats";
  if (normalized === "follow" || normalized === "subscribe") return "follow";
  if (normalized === "share") return "share";
  if (normalized === "roomstats" || normalized === "roomuserstats" || normalized === "room_stats") return "room_stats";
  if (normalized === "streamend" || normalized === "stream_end") return "stream_end";
  if (normalized === "social") return "social";
  return "unknown";
}

const KNOWN_GIFTS: Record<string, { name: string; zhName?: string; diamonds?: number }> = {
  "5655": { name: "Rose", zhName: "玫瑰花", diamonds: 1 },
  "5269": { name: "TikTok", zhName: "TikTok", diamonds: 1 },
  "5827": { name: "Heart Me", zhName: "点赞心", diamonds: 1 },
  "5656": { name: "Finger Heart", zhName: "比心", diamonds: 5 },
  "6064": { name: "GG", zhName: "GG", diamonds: 1 },
  "6046": { name: "Panda", zhName: "熊猫", diamonds: 5 },
  "6060": { name: "Ice Cream Cone", zhName: "甜筒冰淇淋", diamonds: 1 },
  "6071": { name: "Gamepad", zhName: "游戏手柄", diamonds: 10 },
  "5585": { name: "Doughnut", zhName: "甜甜圈", diamonds: 30 },
  "5487": { name: "Confetti", zhName: "彩带礼炮", diamonds: 100 },
  "5332": { name: "Money Gun", zhName: "钞票枪", diamonds: 500 },
  "5879": { name: "Swan", zhName: "天鹅", diamonds: 699 },
  "5660": { name: "Lion", zhName: "狮子", diamonds: 29999 },
  "6059": { name: "TikTok Universe", zhName: "TikTok宇宙", diamonds: 34999 },
  "6115": { name: "Mini Speaker", zhName: "小喇叭", diamonds: 1 },
  "6070": { name: "Hand Wave", zhName: "挥手", diamonds: 9 },
  "6045": { name: "Cap", zhName: "鸭舌帽", diamonds: 99 },
  "6055": { name: "Boxing Gloves", zhName: "拳击手套", diamonds: 299 },
  "6093": { name: "Crown", zhName: "皇冠", diamonds: 9999 },
};

export interface NormalizerOptions {
  storeRawEvents?: boolean;
  debug?: boolean;
}

export class Normalizer {
  private readonly giftCombos = new GiftComboTracker();

  constructor(private readonly options: NormalizerOptions = {}) {}

  normalize(sourceEvent: SourceEvent, source: SourceKind, sessionId: string, sequence: number): NormalizedLiveEvent {
    const now = Date.now();
    const original = sourceEvent.originalEvent;
    if (source === "replay" && original && typeof original === "object") {
      const originalEvent = original as NormalizedLiveEvent;
      return {
        ...originalEvent,
        eventId: randomUUID(),
        sessionId,
        sequence,
        source: "replay",
        receivedAt: now,
        originalSource: originalEvent.source,
        originalReceivedAt: originalEvent.receivedAt,
        raw: this.options.storeRawEvents ? originalEvent.raw : undefined,
      };
    }

    const data = asRecord(sourceEvent.data);
    const type = mapType(sourceEvent.type);
    const user = userFrom(data);
    let payload: AnyRecord;

    switch (type) {
      case "chat": {
        // TikTok's current WebcastChatMessage payload uses `content`; older
        // adapters commonly expose the same value as comment/text/message.
        const text = stringValue(
          pick(data, "comment"),
          pick(data, "text"),
          pick(data, "message"),
          pick(data, "content"),
        ) ?? "";
        payload = { ...payloadWithoutUser(data), text, commandText: text.trim().toLowerCase() };
        break;
      }
      case "gift": {
        const giftObj = asRecord(pick(data, "gift", "giftDetails", "gift_details"));
        const rawGiftId = stringValue(
          pick(data, "giftId", "gift_id", "id"),
          pick(giftObj, "id", "giftId", "gift_id"),
        );
        const known = rawGiftId ? KNOWN_GIFTS[rawGiftId] : undefined;
        const giftName = stringValue(
          pick(data, "giftName", "gift_name", "name"),
          pick(giftObj, "name", "giftName", "gift_name", "describe"),
          known?.name,
        );
        const diamondCount = numberValue(
          pick(data, "diamondCount", "diamond_count"),
          pick(giftObj, "diamondCount", "diamond_count"),
          known?.diamonds,
        );
        const giftInput: GiftComboInput = {
          userId: user?.id,
          uniqueId: user?.uniqueId,
          giftId: rawGiftId,
          giftName,
          count: numberValue(pick(data, "repeatCount", "count", "amount")),
          giftType: numberValue(pick(data, "giftType", "gift_type"), pick(giftObj, "type", "giftType", "gift_type")),
          repeatEnd: booleanValue(pick(data, "repeatEnd", "repeat_end")),
          diamondCount,
        };
        const comboResult = this.giftCombos.process(giftInput);
        payload = {
          ...payloadWithoutUser(data),
          giftId: giftInput.giftId,
          giftName: giftInput.giftName,
          count: comboResult.count,
          giftType: giftInput.giftType,
          repeatEnd: giftInput.repeatEnd,
          diamondCount: giftInput.diamondCount,
        };
        if (comboResult.kind === "progress") payload.comboProgress = true;
        if (comboResult.kind === "ignored") payload.comboDuplicate = true;
        break;
      }
      case "like":
        payload = {
          ...payloadWithoutUser(data),
          count: numberValue(pick(data, "likeCount", "count", "likes")),
          totalLikes: numberValue(pick(data, "totalLikes", "total_likes", "totalLikeCount", "total_like_count", "likeCount", "likes")),
        };
        break;
      case "room_stats":
        payload = {
          ...payloadWithoutUser(data),
          viewerCount: numberValue(pick(data, "viewerCount", "viewer_count", "viewers")),
          totalLikes: numberValue(pick(data, "totalLikes", "total_likes", "totalLikeCount", "total_like_count", "likeCount", "likes")),
        };
        break;
      default:
        payload = payloadWithoutUser(data);
    }

    const normalizedType = type === "gift" && payload.comboProgress === true ? "gift_progress" : type;
    const event: NormalizedLiveEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sessionId,
      sequence,
      source,
      type: normalizedType,
      receivedAt: now,
      platformTimestamp: sourceEvent.platformTimestamp ?? numberValue(pick(data, "timestamp", "createTime", "create_time")),
      user,
      payload: compactUndefined(payload),
    };
    if (this.options.storeRawEvents && sourceEvent.raw !== undefined) event.raw = sourceEvent.raw;
    if (this.options.debug && sourceEvent.decoded !== undefined) {
      event.debug = { decoded: sourceEvent.decoded, eventName: sourceEvent.type };
    }
    return event;
  }
}

function compactUndefined(record: AnyRecord): AnyRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
