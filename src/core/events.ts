import { z } from "zod";
import type { SourceKind } from "../sources/LiveEventSource.js";

export const normalizedEventTypes = [
  "chat",
  "gift",
  "gift_progress",
  "like",
  "join",
  "follow",
  "share",
  "room_stats",
  "stream_end",
  "social",
  "unknown",
] as const;

export type NormalizedEventType = (typeof normalizedEventTypes)[number];

export interface EventUser {
  id?: string;
  uniqueId?: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface NormalizedLiveEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  sequence: number;
  source: SourceKind;
  type: NormalizedEventType;
  receivedAt: number;
  platformTimestamp?: number;
  originalSource?: string;
  originalReceivedAt?: number;
  user?: EventUser;
  payload: Record<string, unknown>;
  raw?: unknown;
  debug?: {
    decoded?: unknown;
    eventName?: string;
  };
}

const optionalUnknownRecord = z.record(z.string(), z.unknown());

export const normalizedLiveEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().positive(),
  source: z.enum(["tiktok", "replay", "simulator"]),
  type: z.enum(normalizedEventTypes),
  receivedAt: z.number().int().nonnegative(),
  platformTimestamp: z.number().optional(),
  originalSource: z.string().optional(),
  originalReceivedAt: z.number().optional(),
  user: z
    .object({
      id: z.string().optional(),
      uniqueId: z.string().optional(),
      nickname: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  payload: optionalUnknownRecord,
  raw: z.unknown().optional(),
  debug: z
    .object({
      decoded: z.unknown().optional(),
      eventName: z.string().optional(),
    })
    .optional(),
});

export function isNormalizedLiveEvent(value: unknown): value is NormalizedLiveEvent {
  return normalizedLiveEventSchema.safeParse(value).success;
}
