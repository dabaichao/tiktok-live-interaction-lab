import { describe, expect, it } from "vitest";
import { ActionMapper } from "../src/actions/ActionMapper.js";
import type { NormalizedLiveEvent } from "../src/core/events.js";

const baseEvent = (type: NormalizedLiveEvent["type"], payload: Record<string, unknown>): NormalizedLiveEvent => ({
  schemaVersion: 1, eventId: "event-1", sessionId: "session-1", sequence: 1, source: "simulator", type, receivedAt: 1,
  user: { uniqueId: "player", nickname: "Player" }, payload,
});

describe("ActionMapper", () => {
  it("maps normalized events to game actions and ignores gift progress", () => {
    const mapper = new ActionMapper({ rules: [
      { when: { type: "chat", commandText: "red" }, emit: { action: "JOIN_TEAM", args: { team: "red" } } },
      { when: { type: "gift", giftId: "5655" }, emit: { action: "SPECIAL_ATTACK", power: 10 } },
    ] });
    expect(mapper.map(baseEvent("chat", { text: " RED ", commandText: "red" }))[0]).toMatchObject({ action: "JOIN_TEAM", args: { team: "red" }, actor: { uniqueId: "player" } });
    expect(mapper.map(baseEvent("gift_progress", { giftId: "5655", giftName: "Rose" })).length).toBe(0);
    expect(mapper.map(baseEvent("gift", { giftId: "5655", giftName: "Rose", count: 3 }))[0]).toMatchObject({ action: "SPECIAL_ATTACK", power: 10, args: { count: 3, giftId: "5655", giftName: "Rose" } });
  });
});
