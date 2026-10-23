import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DouyinOperations, defaultPresentation } from "../src/douyin/DouyinOperations.js";
import { DouyinGiftGate } from "../src/douyin/DouyinGiftGate.js";
import { parsePlatformGiftCatalog } from "../src/douyin/DouyinWebcastProxy.js";
import { AdminConfigService } from "../src/admin/AdminConfigService.js";
import { Normalizer } from "../src/core/Normalizer.js";
import { defaultRules, interactionRuleSchema, matchRule, planInteraction, rulesSchema } from "../src/game/InteractionRules.js";

const event = (data:Record<string,unknown> = {}, type="gift") => new Normalizer().normalize({
  type,data:{user:{id:"u1",nickname:"测试观众"},giftId:"g1",diamondCount:20,count:3,...data},
},"douyin","test-session",1);
const setup = async()=>new DouyinOperations(await mkdtemp(join(tmpdir(),"douyin-operations-")));
const timeRule = () => interactionRuleSchema.parse({id:"time",name:"小心心加时",enabled:true,trigger:"gift",match:"gift",giftId:"g1",actions:[{type:"extra_time",amount:30,basis:"quantity"}]});

describe("Douyin rule calculation",()=>{
  it("uses actual total value and has no implicit extra time or hints",()=>{
    const input={trigger:"gift" as const,unitPrice:20,quantity:3};
    expect(planInteraction(matchRule(defaultRules(),input),input)).toMatchObject({randomWords:600,totalValue:60,extraTimeMs:0,hints:0});
  });
  it("prioritizes exact gift, then price range, then the default, without stacking",()=>{
    const price=interactionRuleSchema.parse({...timeRule(),id:"range",match:"price",minPrice:10,maxPrice:30,actions:[]});
    const rules=[...defaultRules(),price,timeRule()];
    const input={trigger:"gift" as const,giftId:"g1",unitPrice:20,quantity:3};
    expect(planInteraction(matchRule(rules,input),input)).toMatchObject({ruleId:"time",extraTimeMs:90000,randomWords:0});
    expect(matchRule(rules,{...input,giftId:"other"})?.id).toBe("range");
    expect(matchRule(rules,{...input,giftId:"other",unitPrice:99})?.id).toBe("gift-default");
  });
  it("supports explicit combinations, display-only, and unknown prices",()=>{
    const rule=timeRule();
    rule.actions.push({type:"random_words",amount:10,basis:"value",source:"llm"},{type:"unlock_hint",amount:1,basis:"event",source:"llm"});
    expect(planInteraction(rule,{trigger:"gift",quantity:2,unitPrice:1})).toMatchObject({randomWords:20,extraTimeMs:60000,hints:1});
    expect(planInteraction(rule,{trigger:"gift",quantity:2})).toMatchObject({randomWords:0,extraTimeMs:60000,hints:1,note:expect.stringContaining("价格未知")});
    expect(planInteraction({...rule,actions:[]},{trigger:"gift",quantity:2})).toMatchObject({randomWords:0,extraTimeMs:0,hints:0});
  });
  it("rejects ambiguous defaults, invalid value actions and unsafe time arithmetic",()=>{
    const duplicate={...defaultRules()[0],id:"duplicate",giftId:"unused"};
    expect(()=>rulesSchema.parse([...defaultRules(),duplicate])).toThrow();
    expect(()=>interactionRuleSchema.parse({...defaultRules()[0],actions:[{type:"random_words",amount:10,basis:"value"}]})).toThrow();
    expect(()=>planInteraction({...timeRule(),actions:[{type:"extra_time",amount:10000,basis:"value",source:"llm"}]},{trigger:"gift",quantity:1000000,unitPrice:1000000})).toThrow("安全范围");
  });
});

describe("Douyin operations persistence and isolation",()=>{
  it("rejects concurrent stale saves and never loses recent rooms",async()=>{
    const ops=await setup(),revision=ops.view("room").revision;
    const results=await Promise.allSettled([ops.saveRules([timeRule()],revision),ops.saveRules([],revision),ops.rememberRoom("123456789","测试房")]);
    expect(results.map(r=>r.status)).toEqual(["fulfilled","rejected","fulfilled"]);
    expect(ops.view("room")).toMatchObject({revision:revision+1,rules:[{id:"time"}],rooms:[{webRid:"123456789"}]});
    await ops.flush();
  });
  it("preserves a corrupt file until explicit rule recovery",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"douyin-corrupt-"));
    await writeFile(join(dir,"operations.json"),"{incomplete");
    await writeFile(join(dir,"gift-catalog.json"),'{"broken":{"gifts":null}}');
    const ops=new DouyinOperations(dir);
    expect(ops.rules).toEqual([]);
    expect(ops.catalog("broken").gifts).toEqual([]);
    await ops.rememberRoom("123456789","cannot overwrite damaged state");
    expect(await readFile(join(dir,"operations.json"),"utf8")).toBe("{incomplete");
    await ops.saveRules(defaultRules(),1);
    expect(new DouyinOperations(dir).rules).toHaveLength(2);
  });
  it("commits game, hints and rewards together and restores them on restart",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"douyin-game-config-")),ops=new DouyinOperations(dir);
    const config=new AdminConfigService("unused").current;
    config.game.answer="香蕉";
    await ops.saveGame(config,{...defaultPresentation,directionHint:"水果的一种",winnerPoints:250},1);
    expect(new DouyinOperations(dir).gameConfig?.game.answer).toBe("香蕉");
    expect(new DouyinOperations(dir).presentation.winnerPoints).toBe(250);
    await expect(ops.saveGame(config,defaultPresentation,1)).rejects.toThrow("其他页面");
  });
  it("keeps catalog scope and trusted metadata, rejects invalid imports",async()=>{
    const ops=await setup();
    await ops.mergeGifts("roomA",[{id:"g1",name:"小心心",price:1,icon:"https://example.com/g.png"}],"platform");
    await ops.mergeGifts("roomA",[{id:"g1",name:"抖音礼物"}],"observed");
    expect(ops.catalog("roomA")).toMatchObject({complete:false,gifts:[{name:"小心心",source:"platform",price:1}]});
    expect(ops.catalog("roomB").gifts).toEqual([]);
    await expect(ops.mergeGifts("roomA",[{id:"bad",name:"bad",price:-1}],"imported")).rejects.toThrow();
    await ops.mergeGifts("roomA",[{id:"html",name:"<script>",icon:"javascript:alert(1)"}],"imported");
    expect(ops.catalog("roomA").gifts[1].icon).toBe("");
  });
  it("accumulates likes per user without cooldown, and preview does not consume counters",async()=>{
    const ops=await setup(),rule={...defaultRules()[0],every:10};
    await ops.saveRules([rule],1);
    expect(ops.plan({trigger:"like",quantity:6},"a").randomWords).toBe(0);
    expect(ops.plan({trigger:"like",quantity:4}).randomWords).toBe(0);
    expect(ops.plan({trigger:"like",quantity:4},"b").randomWords).toBe(0);
    expect(ops.plan({trigger:"like",quantity:4},"a").randomWords).toBe(1);
    expect(ops.plan({trigger:"like",quantity:20},"a").randomWords).toBe(2);
    expect(ops.view("room").records).toHaveLength(0);
  });
  it("recovers unfinished work as cancelled, never replays it",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"douyin-ledger-")),ops=new DouyinOperations(dir);
    const plan=planInteraction(timeRule(),{trigger:"gift",quantity:3});
    const r=ops.record(event(),"roomA",plan);
    ops.update(r,{status:"running",completedWords:2});
    await ops.flush();
    const recovered=new DouyinOperations(dir);
    expect(recovered.view("roomA").records[0]).toMatchObject({status:"cancelled",completedWords:2,message:expect.stringContaining("重启")});
    expect(recovered.view("roomB").records).toEqual([]);
    await recovered.flush();
  });
});

describe("Douyin gifts",()=>{
  it("settles each final combo once and permits a new combo immediately",()=>{
    const gate=new DouyinGiftGate();
    expect(gate.accept(event({giftType:1,repeatEnd:false,giftGroupId:"groupA"}))).toBe(false);
    expect(gate.accept(event({giftType:1,repeatEnd:true,giftGroupId:"groupA"}))).toBe(true);
    expect(gate.accept(event({giftType:1,repeatEnd:true,giftGroupId:"groupA"}))).toBe(false);
    expect(gate.accept(event({giftType:1,repeatEnd:true,giftGroupId:"groupB"}))).toBe(true);
    gate.clear();
    expect(gate.accept(event({giftType:1,repeatEnd:true,giftGroupId:"groupA"}))).toBe(true);
  });
  it("parses platform gift fields without turning denial or HTML into a fake catalog",()=>{
    expect(parsePlatformGiftCatalog(JSON.stringify({status_code:0,data:{gifts:[{id:"123",name:"测试礼物",diamond_count:20,image:{url_list:["https://example.com/a"]}}]}}))).toEqual([{id:"123",name:"测试礼物",price:20,icon:"https://example.com/a"}]);
    for(const body of ["<html>登录</html>",'{"status_code":401}',"null",'{"data":{"gifts":[]}}'])expect(()=>parsePlatformGiftCatalog(body)).toThrow();
  });
});
