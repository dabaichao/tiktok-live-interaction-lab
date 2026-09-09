import { describe, expect, it } from "vitest";
import { GiftComboTracker } from "../src/core/GiftComboTracker.js";
import { Normalizer } from "../src/core/Normalizer.js";

describe("GiftComboTracker", () => {
  it("settles a streak only on the final count", () => {
    const tracker = new GiftComboTracker();
    expect(tracker.process({ userId: "u", giftId: "g", giftType: 1, count: 1, repeatEnd: false }).kind).toBe("progress");
    expect(tracker.process({ userId: "u", giftId: "g", giftType: 1, count: 2, repeatEnd: false }).kind).toBe("progress");
    expect(tracker.process({ userId: "u", giftId: "g", giftType: 1, count: 3, repeatEnd: true })).toMatchObject({ kind: "settled", count: 3 });
  });

  it("marks intermediate normalized events as gift_progress", () => {
    const normalizer = new Normalizer();
    const one = normalizer.normalize({ type: "gift", data: { user: { userId: "u" }, giftId: "g", giftType: 1, count: 1, repeatEnd: false } }, "tiktok", "s", 1);
    const two = normalizer.normalize({ type: "gift", data: { user: { userId: "u" }, giftId: "g", giftType: 1, count: 3, repeatEnd: true } }, "tiktok", "s", 2);
    expect(one.type).toBe("gift_progress");
    expect(two.type).toBe("gift");
    expect(two.payload.count).toBe(3);
  });
});
