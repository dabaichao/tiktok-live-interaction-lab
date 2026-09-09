import { describe, expect, it } from "vitest";
import { FakeLiveEventSource } from "../src/sources/FakeLiveEventSource.js";
import { Normalizer } from "../src/core/Normalizer.js";

describe("source abstraction", () => {
  it("uses a fake source without requiring TikTok connectivity", async () => {
    const source = new FakeLiveEventSource();
    const events: string[] = [];
    const normalizer = new Normalizer();
    source.onEvent((input) => events.push(normalizer.normalize(input, "simulator", "fake-session", events.length + 1).type));
    await source.connect();
    source.emit({ type: "chat", data: { text: "hello" } });
    source.emit({ type: "like", data: { count: 2 } });
    expect(events).toEqual(["chat", "like"]);
  });
});
