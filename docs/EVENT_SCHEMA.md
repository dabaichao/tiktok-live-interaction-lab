# NormalizedLiveEvent

```ts
interface NormalizedLiveEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  sequence: number;
  source: "tiktok" | "replay" | "simulator";
  type: "chat" | "gift" | "gift_progress" | "like" | "join" | "follow" | "share" | "room_stats" | "stream_end" | "social" | "unknown";
  receivedAt: number;
  platformTimestamp?: number;
  originalSource?: string;
  originalReceivedAt?: number;
  user?: { id?: string; uniqueId?: string; nickname?: string; avatarUrl?: string };
  payload: Record<string, unknown>;
  raw?: unknown;
  debug?: { decoded?: unknown; eventName?: string };
}
```

`chat.payload.text` 永远是原始评论；`chat.payload.commandText` 是 trim + lowercase 后用于规则匹配的值。礼物的 `count` 是一次确认后的 count，不把 combo 中间值累加。进行中的 streak 可以用 `gift_progress` 展示，但不会被 ActionMapper 结算。
