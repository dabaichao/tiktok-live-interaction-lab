import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

// Minimal in-memory DOM contract; no browser, live connection or model calls.
class ElementFixture {
  children: ElementFixture[] = [];
  parentElement?: ElementFixture;
  dataset: Record<string,string> = {};
  style: Record<string,string> = {};
  className = "";
  textContent = "";
  title = "";
  markupWrites = 0;
  private markup = "";
  private parts = new Map<string,ElementFixture>();
  motions: any[] = [];
  classList = {
    contains:(value:string)=>this.className.split(" ").includes(value),
    toggle:(value:string,on:boolean)=>{
      const set=new Set(this.className.split(" ").filter(Boolean));
      on?set.add(value):set.delete(value);this.className=[...set].join(" ");
    },
  };
  get innerHTML() {return this.markup;}
  set innerHTML(value:string) {this.markup=value;this.markupWrites++;this.parts.clear();this.replaceChildren();}
  get firstElementChild() {return this.children[0];}
  get isConnected() {return true;}
  querySelector(selector:string):ElementFixture|null {
    if(selector===".empty"&&!this.markup.includes('class="empty"'))return null;
    const token=selector.match(/\.([\w-]+)/)?.[1];
    if(token&&!this.markup.includes(token))return null;
    if(!this.parts.has(selector))this.parts.set(selector,new ElementFixture());
    return this.parts.get(selector)!;
  }
  querySelectorAll(selector:string) {return selector.split(",").map(s=>this.querySelector(s)).filter(Boolean) as ElementFixture[];}
  append(el:ElementFixture) {this.insertBefore(el,null);}
  insertBefore(el:ElementFixture,before:ElementFixture|null) {
    if(el===before)return;
    el.remove();
    const index=before?this.children.indexOf(before):-1;
    if(index<0)this.children.push(el);else this.children.splice(index,0,el);
    el.parentElement=this;
  }
  replaceChildren() {this.children.forEach(el=>{el.parentElement=undefined;});this.children=[];}
  remove() {if(this.parentElement){const parent=this.parentElement;parent.children=parent.children.filter(el=>el!==this);this.parentElement=undefined;}}
  getBoundingClientRect() {return {top:this.parentElement?this.parentElement.children.indexOf(this)*80:0,left:0,width:1080,height:80};}
  getAnimations() {return this.motions.filter(m=>m.state==="running");}
  animate(frames:any,options:any) {
    const motion:any={frames,options,state:"running",onfinish:null,oncancel:null};
    const timer=setTimeout(()=>{motion.state="finished";motion.onfinish?.();},(options.duration||0)+(options.delay||0));
    motion.cancel=()=>{if(motion.state==="cancelled")return;clearTimeout(timer);motion.state="cancelled";motion.oncancel?.();};
    this.motions.push(motion);return motion;
  }
}

function harness(query="",systemReduced=false) {
  vi.useFakeTimers();vi.setSystemTime(0);
  const nodes=new Map<string,ElementFixture>();
  const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new ElementFixture());return nodes.get(id)!;};
  const state={topGuesses:[],scoreboard:[]} as any;
  const context=createContext({
    console,state,params:new URLSearchParams(query),gameRoot:get("gameRoot"),
    document:{body:{dataset:{}},hidden:false,createElement:()=>new ElementFixture(),addEventListener(){},querySelectorAll:()=>[]},
    $:get,matchMedia:()=>({matches:systemReduced,addEventListener(){}}),addEventListener(){},
    setTimeout,clearTimeout,setInterval,clearInterval,
    requestAnimationFrame:(callback:Function)=>setTimeout(()=>callback(Date.now()),16),cancelAnimationFrame:clearTimeout,
    performance:{now:()=>Date.now()},
    safeUrl:(value:string)=>value||"",initials:(value:any)=>value.nickname?.slice(0,1)||"观",
    avatarHtml:(actor:any)=>`<span class="avatar">${actor.nickname?.slice(0,1)||"观"}</span>`,
    actorName:(actor:any)=>actor.nickname||"观众",escapeHtml:(value:any)=>String(value||""),
    fmt:(value:number)=>String(value),compactScore:(value:number)=>String(Math.round(value)),
    tierBadgeHtml:()=>'<b>青铜</b>',scoreLevel:()=>"warm",guessModeLabel:()=>"聊天猜词",
    updateRankFocus(){},focusPlayerId:null,focusMovement:0,
  });
  for(const file of ["live-effects.js","overlay-core.js","gift-barrage.js"])runInContext(readFileSync(`tools/test-word-game/${file}`,"utf8"),context);
  return {get,state,run:(script:string)=>runInContext(script,context)};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe("live display motion without changing game state",()=>{
  it("keeps row/avatar nodes across score changes and animates real numbers to the exact final total",()=>{
    const h=harness();
    h.state.scoreboard=[{playerId:"a",nickname:"甲",score:100},{playerId:"b",nickname:"乙",score:90}];
    h.run("renderScoreCards()");
    const row=h.get("scoreboard").children[0],avatar=row.querySelector(".score-avatar")!,value=row.querySelector(".score-value")!;
    const writes=avatar.markupWrites;
    h.state.scoreboard[0].score=250;
    h.run("renderScoreCards()");
    expect(h.get("scoreboard").children[0]).toBe(row);
    expect(row.markupWrites).toBe(1);
    expect(row.querySelector(".score-avatar")).toBe(avatar);
    expect(avatar.markupWrites).toBe(writes);
    expect(value.textContent).toBe("100");
    vi.advanceTimersByTime(300);
    expect(Number(value.textContent)).toBeGreaterThan(100);
    expect(Number(value.textContent)).toBeLessThan(250);
    vi.advanceTimersByTime(600);
    expect(value.textContent).toBe("250");
  });
  it("reorders original cards, and an unchanged update does not restart movement",()=>{
    const h=harness();
    const a={playerId:"a",nickname:"甲",score:100},b={playerId:"b",nickname:"乙",score:90};
    h.state.scoreboard=[a,b];h.run("renderScoreCards()");
    vi.advanceTimersByTime(600);
    const [rowA,rowB]=h.get("scoreboard").children;
    h.state.scoreboard=[{...b,score:150},a];h.run("renderScoreCards()");
    expect(h.get("scoreboard").children).toEqual([rowB,rowA]);
    const move=(rowB as any)._rowMotion;
    expect(move.frames[0].transform).toContain("80");
    h.run("renderScoreCards()");
    expect((rowB as any)._rowMotion).toBe(move);
    expect(move.state).toBe("running");
  });
  it("retargets a counting number from its current value instead of restarting or overshooting",()=>{
    const h=harness();
    h.run("updateNumber($('counter'),100,Math.round)");
    h.run("updateNumber($('counter'),200,Math.round)");
    vi.advanceTimersByTime(250);
    const midway=Number(h.get("counter").textContent);
    h.run("updateNumber($('counter'),400,Math.round)");
    expect(Number(h.get("counter").textContent)).toBe(midway);
    vi.advanceTimersByTime(1000);
    expect(h.get("counter").textContent).toBe("400");
    expect(h.run("numberTweens.size")).toBe(0);
  });
  it("enables broadcast motion explicitly while retaining OS-following and reduced modes",()=>{
    expect(harness("",true).run("effectsOff()")).toBe(false);
    expect(harness("motion=auto",true).run("effectsOff()")).toBe(true);
    const h=harness("motion=reduced");
    h.run("updateNumber($('counter'),100,Math.round);updateNumber($('counter'),250,Math.round)");
    expect(h.get("counter").textContent).toBe("250");
    expect(h.run("numberTweens.size")).toBe(0);
  });
  it("bounds a gift burst to one dock card without losing the server-independent receipt history",()=>{
    const h=harness();
    h.run("globalThis.gifts=new GiftBarrage($('giftDanmaku'),{game:{priority:0},celebration:{active:false},resultActive:false})");
    h.run(`for(let i=0;i<100;i++)gifts.receive({eventId:'e'+i,actor:{id:'u'+i,nickname:'观众'+i},gift:{id:'rose',name:'玫瑰',count:1,diamondCount:1}})`);
    expect(h.get("giftDanmaku").children).toHaveLength(1);
    expect(h.get("giftDanmaku").className).toBe("gift-spotlight");
    expect(h.run("gifts.queue.length")).toBeLessThanOrEqual(24);
    expect(h.run("gifts.history.length")).toBe(60);
    expect(h.run("gifts.seen.size")).toBe(100);
    expect(h.get("giftFlowStatus").textContent).not.toMatch(/转入|合并|60/);
    vi.advanceTimersByTime(3000);
    expect(h.get("giftDanmaku").children).toHaveLength(1);
    expect(h.run("gifts.active.item.gift.count")).toBe(1);
  });
  it("merges repeated acknowledgement counts in place, deduplicates IDs and clears stale visual work",()=>{
    const h=harness();
    h.run("globalThis.gifts=new GiftBarrage($('giftDanmaku'),{game:{priority:0},celebration:{active:false},resultActive:false})");
    const receipt="actor:{id:'u',nickname:'观众'},gift:{id:'rose',name:'玫瑰',count:1,diamondCount:1}";
    h.run(`gifts.receive({eventId:'a',${receipt}})`);
    const card=h.get("giftDanmaku").children[0];
    h.run(`gifts.receive({eventId:'b',${receipt}});gifts.receive({eventId:'b',${receipt}})`);
    expect(h.get("giftDanmaku").children[0]).toBe(card);
    expect(card.querySelector(".gift-count strong")?.textContent).toBe("×2");
    expect(h.run("gifts.queue.length")).toBe(0);
    expect(h.run("gifts.history.length")).toBe(2);
    h.run("gifts.suspend()");
    expect(h.run("gifts.active")).toBeNull();
    expect(h.run("gifts.queue.length")).toBe(0);
    expect(h.get("giftDanmaku").children[0].className).toBe("gift-dock-idle");
  });
});
