import type { NormalizedEventType, NormalizedLiveEvent } from "../core/events.js";

export interface DouyinEventStreamItem {
  id:string;
  receivedAt:number;
  type:NormalizedEventType;
  actor:{nickname:string;uniqueId?:string;avatarUrl?:string;identityLimited:boolean;nicknameMasked:boolean};
  text?:string;
  count?:number;
  gift?:{id?:string;name:string;count:number;unitPrice?:number;totalValue?:number;progress:boolean};
  room?:{viewerCount?:number;totalLikes?:number;totalUserCount?:number};
}

function text(value:unknown):string|undefined {
  if(typeof value!=="string")return undefined;
  const normalized=value.trim();
  return normalized ? normalized.slice(0,1000) : undefined;
}

function finite(value:unknown):number|undefined {
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:undefined;
}

function safeAvatar(value:unknown):string|undefined {
  const avatar=text(value);
  return avatar&&/^https:\/\//i.test(avatar)?avatar:undefined;
}

/**
 * Builds the operator-facing projection only. Raw protobuf/debug payloads and
 * credentials can never enter this response.
 */
export function toDouyinEventStreamItem(event:NormalizedLiveEvent):DouyinEventStreamItem {
  const nickname=text(event.user?.nickname)??text(event.user?.uniqueId)??"观众";
  const item:DouyinEventStreamItem={
    id:event.eventId,
    receivedAt:event.receivedAt,
    type:event.type,
    actor:{
      nickname,
      uniqueId:text(event.user?.uniqueId),
      avatarUrl:safeAvatar(event.user?.avatarUrl),
      identityLimited:event.user?.identityLimited===true,
      nicknameMasked:event.user?.nicknameMasked===true,
    },
  };
  if(event.type==="chat"||event.type==="stream_end")item.text=text(event.payload.text)??text(event.payload.content);
  if(event.type==="like")item.count=Math.max(1,Math.floor(finite(event.payload.count)??1));
  if(event.type==="gift"||event.type==="gift_progress") {
    const count=Math.max(1,Math.floor(finite(event.payload.count)??1));
    const unitPrice=finite(event.payload.diamondCount);
    item.gift={
      id:text(event.payload.giftId),
      name:text(event.payload.giftName)??"未命名礼物",
      count,
      ...(unitPrice===undefined?{}:{unitPrice,totalValue:unitPrice*count}),
      progress:event.type==="gift_progress",
    };
  }
  if(event.type==="room_stats")item.room={
    viewerCount:finite(event.payload.viewerCount),
    totalLikes:finite(event.payload.totalLikes),
    totalUserCount:finite(event.payload.totalUserCount),
  };
  return item;
}

export function buildDouyinEventStream(events:NormalizedLiveEvent[],counts:Record<string,number>) {
  return {
    items:events.slice(0,200).map(toDouyinEventStreamItem),
    counts:{
      chat:counts.chat??0,
      gift:counts.gift??0,
      giftProgress:counts.gift_progress??0,
      like:counts.like??0,
      join:counts.join??0,
      follow:counts.follow??0,
      share:counts.share??0,
      social:counts.social??0,
      roomStats:counts.room_stats??0,
    },
    retained:Math.min(events.length,200),
    newestAt:events[0]?.receivedAt,
  };
}
