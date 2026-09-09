import { describe, expect, it, vi } from "vitest";
import { ReplaySource } from "../src/sources/ReplaySource.js";
import type { NormalizedLiveEvent } from "../src/core/events.js";

function event(sequence: number, receivedAt: number): NormalizedLiveEvent {
  return { schemaVersion: 1, eventId: `e-${sequence}`, sessionId: "recorded", sequence, source: "simulator", type: "chat", receivedAt, payload: { text: String(sequence) } };
}

describe("ReplaySource", () => {
  it("replays A, B, C in sequence order", async () => {
    vi.useFakeTimers();
    const source = new ReplaySource();
    const seen: string[] = [];
    source.onEvent((sourceEvent) => seen.push(String((sourceEvent.originalEvent as NormalizedLiveEvent).payload.text)));
    await source.connect({ speed: "MAX" });
    source.load([event(1, 1000), event(2, 5000), event(3, 2000)], "MAX");
    source.play();
    await vi.runAllTimersAsync();
    expect(seen).toEqual(["1", "2", "3"]);
    vi.useRealTimers();
  });
});
