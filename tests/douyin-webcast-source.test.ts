import { describe, expect, it, vi } from "vitest";
import { Normalizer } from "../src/core/Normalizer.js";
import { DouyinWebcastSource, parseDouyinWebRid } from "../src/sources/DouyinWebcastSource.js";

describe("DouyinWebcastSource", () => {
  it("expires a crashed browser bridge but keeps a quiet room connected while its heartbeat is present", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    try {
      const source = new DouyinWebcastSource(); await source.connect({ webRid: "123456789" });
      const token = source.connectionInstructions().sessionToken;
      source.updateState(token, { status: "connected" });
      vi.advanceTimersByTime(40000); source.updateDiagnostics(token, { frames: 1 });
      vi.advanceTimersByTime(40000); expect(source.isConnected()).toBe(true);
      vi.advanceTimersByTime(60001); expect(source.isConnected()).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("distinguishes follow and share actions instead of counting every social event as a follow",async()=>{
    const source=new DouyinWebcastSource(),types:string[]=[];
    source.onEvent(event=>types.push(event.type));
    await source.connect({webRid:"123456789"});
    source.acceptMessages(source.connectionInstructions().sessionToken,[
      {id:"follow",method:"WebcastSocialMessage",socialAction:"1"},
      {id:"share",method:"WebcastSocialMessage",socialAction:"3"},
      {id:"unknown",method:"WebcastSocialMessage",socialAction:"999"},
    ]);
    expect(types).toEqual(["follow","share","social"]);
  });
  it("accepts a live room URL or plain web_rid", () => {
    expect(parseDouyinWebRid("https://live.douyin.com/123456789?foo=1")).toBe("123456789");
    expect(parseDouyinWebRid("123456789")).toBe("123456789");
    expect(parseDouyinWebRid("https://example.com/123456789")).toBeUndefined();
  });

  it("maps Webcast chat, like and gift messages into the shared event model", async () => {
    const source = new DouyinWebcastSource();
    const sourceEvents: Array<Parameters<Normalizer["normalize"]>[0]> = [];
    source.onEvent((event) => sourceEvents.push(event));
    await source.connect({ url: "https://live.douyin.com/123456789" });
    const { sessionToken } = source.connectionInstructions();
    source.updateState(sessionToken, { status: "connected", roomId: "room-1", title: "测试直播间" });
    const result = source.acceptMessages(sessionToken, [
      { id: "1", method: "WebcastChatMessage", user: { id: "u1", name: "用户甲", avatar: "a.jpg" }, content: "苹果" },
      { id: "2", method: "WebcastLikeMessage", user: { id: "u2", name: "用户乙" }, content: "为主播点赞了(12)", room: { likeCount: "99" } },
      { id: "3", method: "WebcastGiftMessage", user: { id: "u3", name: "用户丙" }, gift: { id: "g1", name: "小心心", price: 1, count: "2", type: 1, repeatEnd: 1 } },
    ]);
    expect(result).toEqual({ accepted: 3, duplicates: 0, ended:false });
    const normalized = sourceEvents.map((event, index) => new Normalizer().normalize(event, "douyin", "session", index + 1));
    expect(normalized[0]).toMatchObject({ type: "chat", user: { nickname: "用户甲" }, payload: { text: "苹果" } });
    expect(normalized[1]).toMatchObject({ type: "like", payload: { count: 12, totalLikes: 99 } });
    expect(normalized[2]).toMatchObject({ type: "gift", payload: { giftId: "g1", giftName: "小心心", diamondCount: 1, count: 2 } });
  });

  it("does not merge unrelated viewers that share Douyin's 111111 placeholder id", async () => {
    const source = new DouyinWebcastSource();
    const sourceEvents: Array<Parameters<Normalizer["normalize"]>[0]> = [];
    source.onEvent(event => sourceEvents.push(event));
    await source.connect({ webRid:"123456789" });
    source.acceptMessages(source.connectionInstructions().sessionToken, [
      { id:"masked-a", method:"WebcastLikeMessage", count:1, user:{id:"111111", name:"用***", avatar:"https://example.com/default.jpg", identityLimited:true, nicknameMasked:true} },
      { id:"masked-b", method:"WebcastLikeMessage", count:1, user:{id:"111111", name:"只***", avatar:"https://example.com/default.jpg", identityLimited:true, nicknameMasked:true} },
      { id:"masked-a2", method:"WebcastLikeMessage", count:1, user:{id:"111111", name:"用***", avatar:"https://example.com/default.jpg", identityLimited:true, nicknameMasked:true} },
    ]);
    const normalized = sourceEvents.map((event,index) => new Normalizer().normalize(event,"douyin","session",index+1));
    expect(normalized[0].user).toMatchObject({nickname:"用***",identityLimited:true,nicknameMasked:true});
    expect(normalized[0].user?.id).toMatch(/^douyin-limited:[a-f0-9]{24}$/);
    expect(normalized[0].user?.id).not.toBe(normalized[1].user?.id);
    expect(normalized[0].user?.id).toBe(normalized[2].user?.id);
    expect(normalized[0].user?.uniqueId).toBeUndefined();
    expect(JSON.stringify(normalized[0].user)).not.toContain("111111");
    expect(source.diagnostics()).toMatchObject({limitedIdentityMessages:3,maskedNicknameMessages:3});
  });

  it("prefers a usable display id and preserves it as a real platform identity", async () => {
    const source = new DouyinWebcastSource();
    const events: Array<Parameters<Normalizer["normalize"]>[0]> = [];
    source.onEvent(event => events.push(event));
    await source.connect({webRid:"123456789"});
    source.acceptMessages(source.connectionInstructions().sessionToken,[
      {id:"display",method:"WebcastChatMessage",user:{id:"111111",displayId:"account_abc",name:"完整昵称"},content:"苹果"},
    ]);
    const normalized=new Normalizer().normalize(events[0],"douyin","session",1);
    expect(normalized.user).toMatchObject({id:"account_abc",uniqueId:"account_abc",nickname:"完整昵称",identityLimited:false,nicknameMasked:false});
  });

  it("deduplicates Webcast messages and rejects stale browser sessions", async () => {
    const source = new DouyinWebcastSource();
    await source.connect({ webRid: "123456789" });
    const { sessionToken } = source.connectionInstructions();
    const message = { id: "same", method: "WebcastChatMessage", content: "游艇" };
    expect(source.acceptMessages(sessionToken, [message])).toEqual({ accepted: 1, duplicates: 0, ended:false });
    expect(source.acceptMessages(sessionToken, [message])).toEqual({ accepted: 0, duplicates: 1, ended:false });
    expect(() => source.acceptMessages("stale", [message])).toThrow("会话已失效");
  });

  it("accepts numeric alternate likes and does not reset missing totalLikes to zero", async () => {
    const source = new DouyinWebcastSource();
    const events: Array<Parameters<Normalizer["normalize"]>[0]> = [];
    source.onEvent(event => events.push(event));
    await source.connect({ webRid: "123456789" });
    const token = source.connectionInstructions().sessionToken;
    source.acceptMessages(token, [
      { id:"alternate", method:"WebcastChatLikeMessage", count:12, user:{id:"u", name:"观众"}, room:{likeCount:500} },
      { id:"stats", method:"WebcastRoomStatsMessage", room:{audienceCount:20} },
    ]);
    expect(new Normalizer().normalize(events[0], "douyin", "test", 1)).toMatchObject({ type:"like", payload:{count:12,totalLikes:500} });
    expect(new Normalizer().normalize(events[1], "douyin", "test", 2).payload.totalLikes).toBeUndefined();
    expect(source.diagnostics().acceptedByMethod).toMatchObject({ WebcastChatLikeMessage:1 });
    await source.connect({webRid:"987654321"});
    expect(source.diagnostics()).toMatchObject({ acceptedMessages:0, limitedIdentityMessages:0, maskedNicknameMessages:0, acceptedByMethod:{}, decoder:{} });
  });

  it("stores only bounded diagnostics metadata and rejects stale diagnostic updates", async () => {
    const source = new DouyinWebcastSource();
    await source.connect({ webRid:"123456789" });
    const token = source.connectionInstructions().sessionToken;
    source.updateDiagnostics(token, { frames:10, cookie:"private-test", payload:"private-content", rawMethods:{ WebcastGiftMessage:3, Cookie:100 }, decodeErrors:{WebcastGiftMessage:2}, droppedMethods:{ WebcastUnknownMessage:1 }, lastFrameAt:1234 });
    const snapshot = source.diagnostics();
    expect(snapshot.decoder).toMatchObject({ frames:10, rawMethods:{WebcastGiftMessage:3}, decodeErrors:{WebcastGiftMessage:2} });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-test|private-content|Cookie/);
    expect(() => source.updateDiagnostics("invalid", {})).toThrow("会话已失效");
  });

  it("does not silently truncate oversized message batches", async () => {
    const source = new DouyinWebcastSource();
    await source.connect({webRid:"123456789"});
    expect(() => source.acceptMessages(source.connectionInstructions().sessionToken, Array.from({length:501}, () => ({method:"WebcastLikeMessage",count:1})))).toThrow("500");
    expect(source.diagnostics().acceptedMessages).toBe(0);
  });

  it("retains only fixed bounded failure-stage counters, without inventing causes for old clients", async () => {
    const source = new DouyinWebcastSource();
    await source.connect({webRid:"123456789"});
    const token = source.connectionInstructions().sessionToken;
    source.updateDiagnostics(token, {
      decodeErrors:{WebcastChatLikeMessage:3},
      decodeFailureReasons:{
        WebcastChatLikeMessage:{like_count_zero:1,like_payload_decode_failed:2,private_exception_cookie:99,payload:"private-payload"},
        WebcastLikeMessage:{like_count_invalid:-3,like_user_mapping_failed:Infinity,like_event_mapping_failed:Number.MAX_VALUE},
        WebcastSocialMessage:{social_postprocess_failed:1.9},
        Cookie:{like_count_zero:9}, WebcastGiftMessage:["private-payload"],
      },
    });
    expect(source.diagnostics().decoder).toMatchObject({
      decodeErrors:{WebcastChatLikeMessage:3},
      decodeFailureReasons:{
        WebcastChatLikeMessage:{like_count_zero:1,like_payload_decode_failed:2},
        WebcastLikeMessage:{like_count_invalid:0,like_user_mapping_failed:0,like_event_mapping_failed:Number.MAX_SAFE_INTEGER},
        WebcastSocialMessage:{social_postprocess_failed:1},
      },
    });
    expect(JSON.stringify(source.diagnostics().decoder)).not.toMatch(/private|Cookie|payload"/);
    source.updateDiagnostics(token,{decodeErrors:{WebcastChatLikeMessage:3}});
    expect(source.diagnostics().decoder).toMatchObject({decodeErrors:{WebcastChatLikeMessage:3},decodeFailureReasons:{}});
    source.updateDiagnostics(token,{decodeFailureReasons:Object.fromEntries(Array.from({length:100},(_,index)=>[`WebcastSynthetic${index}`,{upstream_decoder_returned_empty:1}]))});
    expect(Object.keys(source.diagnostics().decoder.decodeFailureReasons as object)).toHaveLength(65);
    expect(()=>source.updateDiagnostics("stale",{decodeFailureReasons:{WebcastLikeMessage:{like_count_zero:1}}})).toThrow("会话已失效");
    await source.connect({webRid:"987654321"});
    expect(source.diagnostics().decoder).toEqual({});
    source.close();
  });
});
