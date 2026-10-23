import { describe, expect, it, vi } from "vitest";
import { Normalizer } from "../src/core/Normalizer.js";
import { createDouyinPushSignature, DouyinSource } from "../src/sources/DouyinSource.js";

const config = {
  roomId: "268",
  appId: "tt-test-app",
  accessToken: "test-token",
  pushSecret: "123abc",
  giftCatalog: { gift_1: { name: "小心心" } },
};

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { msg_type: string };
    return new Response(JSON.stringify({ err_no: 0, err_msg: "ok", data: { task_id: `task-${request.msg_type}` } }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function signedHeaders(type: "live_comment" | "live_like" | "live_gift", body: string) {
  const headers = { "x-msg-type": type, "x-nonce-str": "123456", "x-roomid": "268", "x-timestamp": "456789" };
  return { ...headers, "x-signature": createDouyinPushSignature(headers, body, config.pushSecret) };
}

describe("DouyinSource", () => {
  it("matches the official Douyin signature example", () => {
    expect(createDouyinPushSignature(
      { "x-nonce-str": "123456", "x-timestamp": "456789", "x-roomid": "268", "x-msg-type": "live_gift" },
      "abc123你好",
      "123abc",
    )).toBe("PDcKhdlsrKEJif6uMKD2dw==");
  });

  it("starts comment, like and gift tasks independently", async () => {
    const fetcher = okFetch();
    const source = new DouyinSource(fetcher as typeof fetch);
    await source.connect(config);
    expect(source.isConnected()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(Object.values(source.diagnostics().tasks).every((task) => task.status === "running")).toBe(true);
    await source.disconnect();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("verifies, deduplicates and normalizes callback data", async () => {
    const source = new DouyinSource(okFetch() as typeof fetch);
    const events: Parameters<Normalizer["normalize"]>[0][] = [];
    source.onEvent((event) => events.push(event));
    await source.connect(config);
    const body = JSON.stringify([{ msg_id: "comment-1", sec_openid: "user-1", content: "苹果", nickname: "小明", avatar_url: "https://example.com/a.jpg", timestamp: 1649068964 }]);
    expect(source.acceptPush(signedHeaders("live_comment", body), body)).toEqual({ accepted: 1, duplicates: 0, filteredTests: 0 });
    expect(source.acceptPush(signedHeaders("live_comment", body), body)).toEqual({ accepted: 0, duplicates: 1, filteredTests: 0 });
    const normalized = new Normalizer().normalize(events[0], "douyin", "session", 1);
    expect(normalized).toMatchObject({ source: "douyin", type: "chat", user: { id: "user-1", nickname: "小明" }, payload: { text: "苹果" } });
  });

  it("uses gift total value and filters official test gifts", async () => {
    const source = new DouyinSource(okFetch() as typeof fetch);
    const events: Array<{ type: string; data?: unknown }> = [];
    source.onEvent((event) => events.push(event));
    await source.connect(config);
    const body = JSON.stringify([
      { msg_id: "gift-real", sec_openid: "user-1", sec_gift_id: "gift_1", gift_num: 2, gift_value: 200, nickname: "送礼人", test: false },
      { msg_id: "gift-test", sec_openid: "user-2", sec_gift_id: "gift_1", gift_num: 9, gift_value: 900, nickname: "测试", test: true },
    ]);
    expect(source.acceptPush(signedHeaders("live_gift", body), body)).toEqual({ accepted: 1, duplicates: 0, filteredTests: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ giftId: "gift_1", giftName: "小心心", count: 2, diamondCount: 100, giftValueFen: 200 });
  });

  it("rejects a forged callback", async () => {
    const source = new DouyinSource(okFetch() as typeof fetch);
    await source.connect(config);
    expect(() => source.acceptPush({ ...signedHeaders("live_like", "[]"), "x-signature": "forged" }, "[]")).toThrow("签名校验失败");
    expect(source.diagnostics().invalidCallbacks).toBe(1);
  });
});
