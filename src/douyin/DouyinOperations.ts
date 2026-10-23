import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { mkdir, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultRules, rulesSchema, matchRule, planInteraction, type InteractionInput, type InteractionPlan, type InteractionRule } from "../game/InteractionRules.js";
import type { NormalizedLiveEvent } from "../core/events.js";
import { adminConfigSchema } from "../admin/AdminConfigService.js";

export const presentationSettingsSchema = z.object({
  timedHints: z.boolean(), directionHint: z.string().max(160),
  winnerPoints: z.number().int().min(0).max(100000), secondPoints: z.number().int().min(0).max(100000),
  thirdPoints: z.number().int().min(0).max(100000), assistPoints: z.number().int().min(0).max(100000),
}).strict();
export const defaultPresentation = {timedHints:true,directionHint:"",winnerPoints:150,secondPoints:100,thirdPoints:50,assistPoints:50};
const stateSchema = z.object({version:z.literal(1),revision:z.number().int(),rules:rulesSchema,presentation:presentationSettingsSchema,gameConfig:adminConfigSchema.optional(),rooms:z.array(z.object({webRid:z.string().max(50),title:z.string().max(200)})).max(20)});
const giftSchema = z.object({id:z.string().min(1).max(100),name:z.string().min(1).max(100),icon:z.string().max(2000).default(""),price:z.number().min(0).max(1e9).optional()}).strict();
const catalogSchema = z.record(z.object({
  gifts:z.array(giftSchema.extend({source:z.enum(["platform","observed","imported"]),updatedAt:z.number()})).max(10000),
  syncedAt:z.number().optional(),message:z.string(),
}));
const executionSchema = z.object({
  id:z.string(),createdAt:z.number(),roomKey:z.string(),eventId:z.string(),actor:z.string(),trigger:z.string(),
  giftName:z.string().optional(),ruleRevision:z.number(),
  plan:z.object({ruleId:z.string().optional(),ruleName:z.string(),randomWords:z.number(),extraTimeMs:z.number(),hints:z.number(),wordSource:z.enum(["llm","local"]),quantity:z.number(),totalValue:z.number().optional(),note:z.string()}),
  status:z.enum(["queued","running","completed","partial","cancelled","failed","display-only"]),
  completedWords:z.number(),aiWords:z.number().default(0),localWords:z.number().default(0),appliedTimeMs:z.number(),unlockedHints:z.number(),message:z.string(),
  carriedRounds:z.number().optional(),remainingWords:z.number().optional(),waitingForRound:z.boolean().optional(),currentRoundNo:z.number().optional(),
});
const JOURNAL_ROTATE_BYTES = 10 * 1024 * 1024;

// Bound startup memory even after a very busy broadcast. Incomplete first/last
// lines are ignored; archives remain on disk and are never replayed as events.
function journalTail(path:string):string {
  const fd=openSync(path,"r");
  try {
    const size=fstatSync(fd).size,offset=Math.max(0,size-2*1024*1024),buffer=Buffer.alloc(size-offset);
    const read=readSync(fd,buffer,0,buffer.length,offset);
    const text=buffer.subarray(0,read).toString("utf8");
    return offset?text.slice(text.indexOf("\n")+1):text;
  } finally {closeSync(fd);}
}
export interface CatalogGift { id:string;name:string;icon:string;price?:number;source:"platform"|"observed"|"imported";updatedAt:number; }
export interface ExecutionRecord {
  id:string;createdAt:number;roomKey:string;eventId:string;actor:string;trigger:string;giftName?:string;ruleRevision:number;
  plan:InteractionPlan;status:"queued"|"running"|"completed"|"partial"|"cancelled"|"failed"|"display-only";
  completedWords:number;aiWords:number;localWords:number;appliedTimeMs:number;unlockedHints:number;message:string;
  carriedRounds?:number;remainingWords?:number;waitingForRound?:boolean;currentRoundNo?:number;
}
export class DouyinOperations {
  private state = stateSchema.parse({version:1,revision:1,rules:defaultRules(),presentation:defaultPresentation,rooms:[]});
  private catalogs: Record<string,{gifts:CatalogGift[];syncedAt?:number;message:string}> = {};
  private records: ExecutionRecord[] = [];
  private persistence: Promise<void> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private corruptState = false;
  private journalBytes = 0;
  private remainder = new Map<string,number>();
  private storageError = "";
  constructor(private readonly dir:string) {
    if (existsSync(join(dir,"operations.json"))) {
      try {this.state = stateSchema.parse(JSON.parse(readFileSync(join(dir,"operations.json"),"utf8")));}
      catch {this.corruptState=true;this.state.rules=[];this.storageError="运营配置损坏，已停用互动效果，请检查配置或恢复默认；未覆盖原文件。";}
    }
    if(existsSync(join(dir,"gift-catalog.json"))) {
      try {this.catalogs = catalogSchema.parse(JSON.parse(readFileSync(join(dir,"gift-catalog.json"),"utf8")));}
      catch {this.storageError ||= "本机礼物目录损坏，请重新同步或导入；互动规则未改变。";}
    }
    // The journal is append-only; a pending job from an old process is explicitly
    // cancelled on recovery rather than replayed against a new room/round.
    try {
      const latest = new Map<string,ExecutionRecord>();
      this.journalBytes=statSync(join(dir,"executions.jsonl")).size;
      for (const line of journalTail(join(dir,"executions.jsonl")).trim().split('\n')) {try {const r=executionSchema.parse(JSON.parse(line)); latest.set(r.id,r);} catch {}}
      this.records=[...latest.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
      for (const r of this.records) if (r.status === "queued" || r.status === "running") {r.status="cancelled";r.message="服务重启，未完成任务已取消；不会自动投递到新局。";this.journal(r);}
    } catch {}
  }
  view(roomKey:string) {return { ...structuredClone(this.state),storageError:this.storageError,roomKey,catalog:this.catalog(roomKey),records:structuredClone(this.records.filter(r=>r.roomKey===roomKey).slice(0,100)) };}
  get rules() {return structuredClone(this.state.rules);}
  get presentation() {return {...this.state.presentation};}
  get gameConfig() {return this.state.gameConfig ? structuredClone(this.state.gameConfig) : undefined;}
  saveRules(input:unknown, revision:number):Promise<void> {
    const rules=rulesSchema.parse(input);
    return this.mutate(async()=>{
      if (revision !== this.state.revision) throw new Error("配置已被其他页面修改，请重新读取后保存。");
      const next={...this.state,rules,revision:this.state.revision+1};
      await this.persist("operations.json",next);this.state=next;this.remainder.clear();this.storageError="";this.corruptState=false;
    });
  }
  savePresentation(input:unknown) {
    const presentation=presentationSettingsSchema.parse(input);
    return this.mutate(async()=>{
      if(this.corruptState)throw new Error("运营配置损坏，请先恢复互动规则。");
      const next={...this.state,presentation,revision:this.state.revision+1};
      await this.persist("operations.json",next);this.state=next;
    });
  }
  saveGame(config:unknown,presentation:unknown,revision:number) {
    const validatedConfig=adminConfigSchema.parse(config),validatedPresentation=presentationSettingsSchema.parse(presentation);
    return this.mutate(async()=>{
      if(this.corruptState)throw new Error("运营配置损坏，请先恢复互动规则。");
      if(revision!==this.state.revision)throw new Error("配置已被其他页面修改，请重新读取后保存。");
      const next={...this.state,gameConfig:validatedConfig,presentation:validatedPresentation,revision:this.state.revision+1};
      // Game + hint/reward settings commit together, never half of each file.
      await this.persist("operations.json",next);this.state=next;
    });
  }
  rememberRoom(webRid:string,title:string) {
    return this.mutate(async()=>{
      if(this.corruptState)return;
      const next={...this.state,rooms:[{webRid,title:title.slice(0,200)},...this.state.rooms.filter(r=>r.webRid!==webRid)].slice(0,20)};
      await this.persist("operations.json",next);this.state=next;
    }).catch(()=>{this.storageError="常用直播间保存失败";});
  }
  resetCounters() {this.remainder.clear();}
  catalog(roomKey:string) {const data=this.catalogs[roomKey] ?? {gifts:[],message:"尚未同步平台礼物目录。实收礼物不代表完整目录。"}; return { ...structuredClone(data),complete:false };}
  async mergeGifts(roomKey:string,input:unknown,source:CatalogGift["source"],message?:string) {
    const incoming=z.array(giftSchema).max(10000).parse(input);
    return this.mutate(async()=>{
    const data=structuredClone(this.catalogs[roomKey] ?? {gifts:[],message:"仅包含已观测/导入礼物，不是完整平台列表。"});
    const map=new Map(data.gifts.map(g=>[g.id,g]));
    for (const item of incoming) {
      const old=map.get(item.id);
      // Empty metadata from an event must not erase a known name/price/icon.
      map.set(item.id,{...old,...item,name:source==="observed"&&old&&["抖音礼物","未命名礼物"].includes(item.name)?old.name:item.name,icon:/^https:\/\//.test(item.icon)?item.icon:old?.icon??"",price:item.price??old?.price,source:source==="observed"?old?.source??source:source,updatedAt:Date.now()});
    }
    if(map.size>10000)throw new Error("当前房间礼物目录已超过 10000 种，未写入本次数据。");
    data.gifts=[...map.values()];
    if(source==="platform") data.syncedAt=Date.now();
    if(message) data.message=message;
    const next={...this.catalogs,[roomKey]:data};
    await this.persist("gift-catalog.json",next);this.catalogs=next;
    return this.catalog(roomKey);
    });
  }
  observe(roomKey:string,event:NormalizedLiveEvent) {
    if (!['gift','gift_progress'].includes(event.type) || !event.payload.giftId) return;
    const price=Number(event.payload.diamondCount);
    const gift={id:String(event.payload.giftId),name:String(event.payload.giftName||"未命名礼物").slice(0,100),icon:String(event.payload.giftIcon||""),...(Number.isFinite(price)&&price>0?{price}: {})};
    const old=this.catalogs[roomKey]?.gifts.find(g=>g.id===gift.id);
    if (old && (old.name===gift.name || ["抖音礼物","未命名礼物"].includes(gift.name)) && (!gift.price || old.price===gift.price) && (!gift.icon || old.icon===gift.icon)) return;
    void this.mergeGifts(roomKey,[gift],"observed").catch(()=>{this.storageError="实收礼物保存失败";});
  }
  inputFor(event:NormalizedLiveEvent,roomKey:string):InteractionInput {
    const giftId=String(event.payload.giftId||"");
    const rawPrice=Number(event.payload.diamondCount);
    const unitPrice=Number.isFinite(rawPrice)&&rawPrice>0?rawPrice:this.catalogs[roomKey]?.gifts.find(g=>g.id===giftId)?.price;
    const count=Number(event.payload.count??1);
    return {trigger:event.type as InteractionInput["trigger"],giftId,unitPrice,quantity:Number.isFinite(count)?Math.max(1,Math.floor(count)):1};
  }
  plan(input:InteractionInput, actorKey?:string):InteractionPlan {
    const rule=matchRule(this.state.rules,input);
    if(rule && input.trigger==="like") {
      const key=`${rule.id}:${actorKey??"preview"}`;
      const sum=input.quantity+(actorKey?this.remainder.get(key)??0:0);
      if(actorKey)this.remainder.set(key,sum%rule.every);
      return planInteraction(rule,{...input,quantity:Math.floor(sum/rule.every)});
    }
    return planInteraction(rule,input);
  }
  record(event:NormalizedLiveEvent,roomKey:string,plan:InteractionPlan):ExecutionRecord {
    const record:ExecutionRecord={id:randomUUID(),createdAt:Date.now(),roomKey,eventId:event.eventId,actor:event.user?.nickname??event.user?.uniqueId??"观众",trigger:event.type,giftName:String(event.payload.giftName??""),ruleRevision:this.state.revision,plan,status:"queued",completedWords:0,aiWords:0,localWords:0,appliedTimeMs:0,unlockedHints:0,message:plan.note};
    this.records.unshift(record);this.records.length=Math.min(200,this.records.length);this.journal(record);return record;
  }
  update(record:ExecutionRecord,patch:Partial<Pick<ExecutionRecord,"status"|"completedWords"|"aiWords"|"localWords"|"appliedTimeMs"|"unlockedHints"|"message"|"carriedRounds"|"remainingWords"|"waitingForRound"|"currentRoundNo">>) {Object.assign(record,patch);this.journal(record);}
  async flush() {await this.mutations;await this.persistence;}
  private mutate<T>(action:()=>Promise<T>):Promise<T> {
    const job=this.mutations.catch(()=>{}).then(action);
    this.mutations=job.catch(()=>{});return job;
  }
  private journal(record:ExecutionRecord) {
    const line=JSON.stringify(record)+'\n';
    this.persistence=this.persistence.catch(()=>{}).then(async()=>{
      await mkdir(this.dir,{recursive:true});
      const path=join(this.dir,"executions.jsonl");
      if(this.journalBytes>=JOURNAL_ROTATE_BYTES) {
        await rename(path,join(this.dir,`executions-${Date.now()}-${randomUUID()}.jsonl`));
        this.journalBytes=0;
      }
      await appendFile(path,line,"utf8");this.journalBytes+=Buffer.byteLength(line);
    }).catch(()=>{this.storageError="执行记录写入失败，请检查磁盘空间";});
  }
  private persist(name:string,value:unknown):Promise<void> {
    const text=JSON.stringify(value,null,2);
    const job=this.persistence.catch(()=>{}).then(async()=>{await mkdir(this.dir,{recursive:true});const temp=join(this.dir,`${name}.${randomUUID()}.tmp`);await writeFile(temp,text,"utf8");await rename(temp,join(this.dir,name));});
    this.persistence=job;return job;
  }
}
