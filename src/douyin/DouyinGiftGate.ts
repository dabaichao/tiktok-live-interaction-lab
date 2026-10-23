import type { NormalizedLiveEvent } from "../core/events.js";

/** A combo final is settled once; this is protocol deduplication, NOT cooldown. */
export class DouyinGiftGate {
  private readonly settled=new Set<string>();
  accept(event:NormalizedLiveEvent):boolean {
    if(event.type==="gift_progress" || event.payload.comboProgress || event.payload.comboDuplicate) return false;
    if(event.type!=="gift") return true;
    const group=event.payload.giftGroupId;
    const groupKey=group && group!=="0"?`group:${event.user?.id??event.user?.uniqueId}:${event.payload.giftId}:${group}`:`message:${event.payload.msgId||event.eventId}`;
    const key=`${event.sessionId}:${groupKey}`;
    if(this.settled.has(key))return false;
    this.settled.add(key);
    if(this.settled.size>20000)this.settled.delete(this.settled.values().next().value!);
    return true;
  }
  clear(){this.settled.clear();}
}
