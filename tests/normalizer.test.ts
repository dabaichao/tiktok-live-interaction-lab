import { describe, expect, it } from "vitest";
import { Normalizer } from "../src/core/Normalizer.js";

describe("Normalizer", () => {
  it("normalizes chat while preserving text and deriving commandText", () => {
    const event = new Normalizer().normalize(
      { type: "chat", data: { comment: " RED ", user: { userId: "42", uniqueId: "john123", nickname: "John" } } },
      "tiktok", "session-1", 1,
    );
    expect(event.type).toBe("chat");
    expect(event.user).toMatchObject({ id: "42", uniqueId: "john123", nickname: "John" });
    expect(event.payload).toMatchObject({ text: " RED ", commandText: "red" });
  });

  it("reads TikTok WebcastChatMessage content", () => {
    const event = new Normalizer().normalize(
      { type: "chat", data: { content: "wahhhhh", text: "", user: { nickname: "Tokdabai" } } },
      "tiktok", "session-1", 2,
    );
    expect(event.payload).toMatchObject({ text: "wahhhhh", commandText: "wahhhhh" });
  });

  it("normalizes gifts and tolerates missing fields", () => {
    const normalizer = new Normalizer();
    const gift = normalizer.normalize({ type: "gift", data: { giftId: 5655, giftName: "Rose", count: 5, giftType: 0, diamondCount: 1 } }, "tiktok", "s", 1);
    const unknown = normalizer.normalize({ type: "gift", data: {} }, "tiktok", "s", 2);
    expect(gift.type).toBe("gift");
    expect(gift.payload).toMatchObject({ giftId: "5655", giftName: "Rose", count: 5, diamondCount: 1 });
    expect(unknown.type).toBe("gift");
    expect(unknown.payload.count).toBe(1);
  });

  it("extracts gift name from nested gift object or fallback dictionary", () => {
    const normalizer = new Normalizer();
    const fromNestedGift = normalizer.normalize(
      { type: "gift", data: { gift: { id: "5655", name: "Rose", diamondCount: 1, type: 1 }, repeatEnd: true, repeatCount: 2 } },
      "tiktok", "s", 3,
    );
    expect(fromNestedGift.type).toBe("gift");
    expect(fromNestedGift.payload).toMatchObject({ giftId: "5655", giftName: "Rose", diamondCount: 1, count: 2 });

    const fromDictFallback = normalizer.normalize(
      { type: "gift", data: { giftId: "5655", repeatEnd: true, repeatCount: 1 } },
      "tiktok", "s", 4,
    );
    expect(fromDictFallback.payload).toMatchObject({ giftId: "5655", giftName: "Rose", diamondCount: 1, count: 1 });
  });

  it("extracts avatarUrl from nested avatarThumb and uniqueId from displayId", () => {
    const normalizer = new Normalizer();
    const event = normalizer.normalize(
      {
        type: "chat",
        data: {
          comment: "hello",
          user: {
            id: "12345",
            displayId: "tiktok_user",
            nickname: "TikTok User",
            avatarThumb: { urlList: ["https://example.com/avatar.webp"] },
          },
        },
      },
      "tiktok", "s", 5,
    );
    expect(event.user).toMatchObject({
      id: "12345",
      uniqueId: "tiktok_user",
      nickname: "TikTok User",
      avatarUrl: "https://example.com/avatar.webp",
    });
  });
});
