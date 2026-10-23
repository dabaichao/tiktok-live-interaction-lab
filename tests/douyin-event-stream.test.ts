import { describe, expect, it } from "vitest";
import { buildDouyinEventStream, toDouyinEventStreamItem } from "../src/douyin/DouyinEventStream.js";
import type { NormalizedLiveEvent } from "../src/core/events.js";

function event(type:NormalizedLiveEvent["type"],payload:Record<string,unknown>,sequence=1):NormalizedLiveEvent {
  return {
    schemaVersion:1,eventId:`event-${sequence}`,sessionId:"session",sequence,source:"douyin",type,receivedAt:1700000000000+sequence,
    user:{id:"internal-id",uniqueId:"public-user",nickname:"完整昵称",avatarUrl:"https://example.com/avatar.png"},
    payload,raw:{cookie:"must-never-leak"},debug:{decoded:{signature:"private"}},
  };
}

describe("Douyin operator event stream",()=>{
  it("shows full chat identity and content without exposing raw transport data",()=>{
    const item=toDouyinEventStreamItem(event("chat",{text:"可以的"}));
    expect(item).toMatchObject({type:"chat",actor:{nickname:"完整昵称",uniqueId:"public-user"},text:"可以的"});
    expect(JSON.stringify(item)).not.toContain("must-never-leak");
    expect(JSON.stringify(item)).not.toContain("signature");
  });

  it("projects gift quantities, values and room statistics truthfully",()=>{
    expect(toDouyinEventStreamItem(event("gift",{giftId:"g1",giftName:"小心心",count:3,diamondCount:2}))).toMatchObject({
      gift:{id:"g1",name:"小心心",count:3,unitPrice:2,totalValue:6,progress:false},
    });
    expect(toDouyinEventStreamItem(event("room_stats",{viewerCount:72,totalLikes:900,totalUserCount:200}))).toMatchObject({room:{viewerCount:72,totalLikes:900,totalUserCount:200}});
  });

  it("keeps newest-first input order and publishes current connection counts",()=>{
    const stream=buildDouyinEventStream([event("join",{},3),event("chat",{text:"你好"},2)],{join:315,chat:8,follow:22,gift:2});
    expect(stream.items.map(item=>item.id)).toEqual(["event-3","event-2"]);
    expect(stream.counts).toMatchObject({join:315,chat:8,follow:22,gift:2,share:0});
  });
});
