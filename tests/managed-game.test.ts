import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConfigService } from "../src/admin/AdminConfigService.js";
import { Normalizer } from "../src/core/Normalizer.js";
import { SemanticEngine } from "../src/game/SemanticEngine.js";
import { HintWordClient } from "../src/game/HintWordClient.js";
import { SemanticGameService, type InteractionProgress } from "../src/game/SemanticGameService.js";
import { defaultPresentation } from "../src/douyin/DouyinOperations.js";
import type { SemanticGameGateway, SemanticGameMessage } from "../src/game/SemanticGameGateway.js";
import type { InteractionPlan } from "../src/game/InteractionRules.js";

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function setup(carryGiftWords = false, useReviewedDefinitions = false) {
  const config=new AdminConfigService("unused-managed-test").current;
  Object.assign(config.game,{language:"zh-Hans",answer:"苹果",allowLocalGiftFallback:false});
  config.llm.batchSize=2;
  const messages:SemanticGameMessage[]=[];
  const game=new SemanticGameService({broadcast:(m:SemanticGameMessage)=>messages.push(m)} as SemanticGameGateway,{get current(){return config;}} as AdminConfigService,undefined,{presentation:()=>({...defaultPresentation,timedHints:false}),carryGiftWords,useReviewedDefinitions});
  const evaluation=vi.spyOn(SemanticEngine.prototype,"evaluateWithEmbedding").mockImplementation(async function(a,g){return this.evaluate(a,g);});
  const generate=vi.spyOn(HintWordClient.prototype,"generateWords").mockResolvedValue([]);
  const gift=new Normalizer().normalize({type:"gift",data:{user:{id:"u",nickname:"礼物测试"},giftId:"g",diamondCount:1,count:1}},"douyin","isolated",1);
  const base:InteractionPlan={ruleName:"测试规则",randomWords:0,extraTimeMs:0,hints:0,wordSource:"llm",quantity:1,note:""};
  const apply=async(patch:Partial<InteractionPlan>)=>{
    const changes:InteractionProgress[]=[];
    await game.applyInteraction(gift,{...base,...patch},p=>changes.push({...p}));
    return changes.at(-1)!;
  };
  return {game,config,messages,evaluation,generate,gift,base,apply};
}
describe("managed Douyin game effects (legacy TikTok stays opt-out)",()=>{
  it("preserves the explicitly enabled definition policy after operator reconfiguration",()=>{
    const {game}=setup(false,true);
    try {
      expect(game.snapshot().embedding).toMatchObject({answerContextMode:"reviewed-when-specific"});
      game.reconfigure();
      expect(game.snapshot().embedding).toMatchObject({answerContextMode:"reviewed-when-specific"});
    } finally {game.stop();}
    expect(setup().game.snapshot().embedding).toMatchObject({answerContextMode:"surface"});
  });
  it("time-only does not call the model or create words/hints",async()=>{
    const {game,apply,messages,generate}=setup();
    const before=(game.snapshot().round as any).endsAt;
    expect(await apply({extraTimeMs:30000})).toMatchObject({status:"completed",completedWords:0,appliedTimeMs:30000,unlockedHints:0});
    expect((game.snapshot().round as any).endsAt).toBe(before+30000);
    expect(generate).not.toHaveBeenCalled();
    expect(messages.some(m=>m.type==="HINT_UNLOCKED"||m.type==="GUESS_ACCEPTED")).toBe(false);
  });
  it("includes the actual gift icon in the viewer acknowledgement", async () => {
    const { gift, apply, messages } = setup(); gift.payload.giftIcon = "https://example.com/gift.png";
    await apply({ extraTimeMs: 1000 });
    expect(messages.find(m => m.type === "GIFT_RECEIVED")?.gift).toMatchObject({ icon: "https://example.com/gift.png" });
  });
  it("words-only runs bounded batches, counts actual words, and adds no hidden hint or time",async()=>{
    const {game,apply,messages,generate}=setup();
    generate.mockResolvedValueOnce(["香蕉","水果"]).mockResolvedValueOnce(["橘子","西瓜"]);
    const before=(game.snapshot().round as any).endsAt;
    expect(await apply({randomWords:4})).toMatchObject({status:"completed",completedWords:4,aiWords:4,localWords:0,appliedTimeMs:0,unlockedHints:0});
    expect(generate.mock.calls.map(([request])=>request.count)).toEqual([2,2]);
    expect((game.snapshot().round as any).endsAt).toBe(before);
    expect(messages.filter(m=>m.type==="GUESS_ACCEPTED")).toHaveLength(4);
    expect(game.snapshot().hintsUnlocked).toBe(0);
  });
  it("reports missing model output truthfully without silently substituting local words",async()=>{
    const {apply,generate,messages}=setup();
    generate.mockResolvedValueOnce(["香蕉"]).mockResolvedValue([]);
    expect(await apply({randomWords:4})).toMatchObject({status:"partial",completedWords:1,message:expect.stringContaining("部分")});
    expect(messages.filter(m=>m.type==="GUESS_ACCEPTED")).toHaveLength(1);
  });
  it("reproduces a one-word deficit when the remaining model candidates are the hidden answer",async()=>{
    // A synthetic failure-path diagnosis, not an assertion that real partial
    // gifts had this cause, or that the production deficit has been repaired.
    const {game,config,apply,generate,messages}=setup(true);
    config.llm.batchSize=10;
    const candidates=["香蕉","水果","橘子","西瓜","葡萄","柠檬","蜜桃","果园","果汁"];
    generate.mockResolvedValueOnce([...candidates,"苹果"]).mockResolvedValue(["苹果"]);
    try {
      expect(await apply({randomWords:10})).toMatchObject({status:"partial",completedWords:9,aiWords:9,localWords:0,remainingWords:1});
      expect(generate.mock.calls.map(([request])=>request.count)).toEqual([10,1,1,1,1,1]);
      expect(messages.filter(m=>m.type==="GUESS_ACCEPTED").map(m=>(m.guess as any).word)).toEqual(candidates);
      expect(messages.some(m=>m.type==="ROUND_ANSWERED")).toBe(false);
      expect(game.interactionDiagnostics().pendingJobs).toBe(0);
    } finally {game.stop();}
  });
  it("executes local-only gift words without a model call",async()=>{
    const {apply,generate}=setup();
    expect(await apply({randomWords:3,wordSource:"local"})).toMatchObject({status:"completed",completedWords:3,localWords:3,aiWords:0});
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not block local likes behind a pending remote gift model",async()=>{
    const {game,generate,gift,base}=setup();
    let release!:(words:string[])=>void;
    generate.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const remote=game.applyInteraction(gift,{...base,randomWords:2},()=>{});
    await Promise.resolve();
    const like=new Normalizer().normalize({type:"like",data:{count:1,user:{id:"like-viewer",nickname:"点赞测试"}}},"douyin","isolated",2);
    let result:InteractionProgress|undefined;
    await game.applyInteraction(like,{...base,randomWords:1,wordSource:"local"},p=>{result=p;});
    expect(result).toMatchObject({status:"completed",completedWords:1});
    release([]);await remote;
  });
  it("refills the actual deficit when a concurrent like consumes a model candidate", async () => {
    const { game, generate, evaluation, apply, messages, base } = setup();
    generate.mockResolvedValueOnce(["香蕉", "水果"]).mockResolvedValueOnce(["橘子"]);
    let release!: () => void;
    evaluation.mockImplementation(function (answer, guess) {
      const result = this.evaluate(answer, guess);
      return guess === "香蕉" ? new Promise(resolve => { release = () => resolve(result); }) : Promise.resolve(result);
    });
    vi.spyOn(SemanticEngine.prototype, "randomCandidate").mockReturnValue("水果");
    const remote = apply({ randomWords: 2 });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const like = new Normalizer().normalize({ type: "like", data: { count: 1, user: { id: "concurrent-like", nickname: "并发点赞" } } }, "douyin", "isolated", 2);
    await game.applyInteraction(like, { ...base, randomWords: 1, wordSource: "local" }, () => {});
    release();
    expect(await remote).toMatchObject({ status: "completed", completedWords: 2, aiWords: 2, localWords: 0, remainingWords:0 });
    const accepted = messages.filter(message => message.type === "GUESS_ACCEPTED");
    expect(accepted).toHaveLength(3);
    expect(accepted.filter(message => (message.guess as any).triggerType === "gift")).toHaveLength(2);
    expect(generate.mock.calls.map(([request])=>request.count)).toEqual([2,1]);
  });
  it("labels mixed AI and allowed local fallback separately",async()=>{
    const {config,apply,generate,messages}=setup();
    config.game.allowLocalGiftFallback=true;
    generate.mockResolvedValueOnce(["香蕉"]).mockResolvedValue([]);
    expect(await apply({randomWords:2})).toMatchObject({status:"completed",completedWords:2,localWords:1,aiWords:1});
    const accepted=messages.filter(m=>m.type==="GUESS_ACCEPTED").map(m=>(m.guess as any).bonusSource);
    expect(accepted).toEqual(["llm","local-fallback"]);
  });
  it("freezes/resumes the timer and exposes no next timed hint when disabled",()=>{
    vi.useFakeTimers();vi.setSystemTime(100000);
    const {game}=setup();
    const before=(game.snapshot().round as any).endsAt;
    game.control("pause");const timeline=game.snapshot().timeline;
    vi.advanceTimersByTime(15000);
    expect(game.snapshot().timeline).toEqual(timeline);
    expect(game.snapshot().round).toMatchObject({status:"PAUSED"});
    game.control("resume");
    expect((game.snapshot().round as any).endsAt).toBe(before+15000);
    expect(game.snapshot().timeline).toMatchObject({nextHintAt:undefined});
  });
  it.each(["pause-resume","room","next"] as const)("cancels late model output after %s",async(action)=>{
    const {game,apply,generate,messages}=setup();
    let complete!:(words:string[])=>void;
    generate.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const result=apply({randomWords:2});
    await vi.waitFor(()=>expect(complete).toBeTypeOf("function"));
    if(action==="pause-resume"){game.control("pause");game.control("resume");}
    else if(action==="room")game.resetRoom();
    else game.control("next");
    complete(["香蕉","水果"]);
    expect(await result).toMatchObject({status:"cancelled",completedWords:0});
    expect(messages.filter(m=>m.type==="GUESS_ACCEPTED")).toHaveLength(0);
  });
  it("does not award an in-flight embedding after pause followed immediately by resume",async()=>{
    const {game,apply,evaluation,messages}=setup();
    let complete!:()=>void;
    evaluation.mockImplementation(function(a,g){const result=this.evaluate(a,g);return new Promise(resolve=>{complete=()=>resolve(result);});});
    const result=apply({randomWords:1,wordSource:"local"});
    await vi.waitFor(()=>expect(complete).toBeTypeOf("function"));
    game.control("pause");game.control("resume");complete();
    expect(await result).toMatchObject({status:"cancelled",completedWords:0});
    expect(messages.filter(m=>m.type==="GUESS_ACCEPTED")).toHaveLength(0);
  });
  it("caps hint unlocks at four without converting excess hints into time",async()=>{
    const {game,apply}=setup();
    const before=(game.snapshot().round as any).endsAt;
    expect(await apply({hints:100})).toMatchObject({unlockedHints:4,appliedTimeMs:0});
    expect((game.snapshot().round as any).endsAt).toBe(before);
  });
  it("carries only remaining gift words after natural timeout and regenerates using the new round",async()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(100000);
    const {game,config,generate,gift,base,messages}=setup(true);
    const internal=game as unknown as {tick:()=>void;unlockHint:(type:string)=>void};
    internal.unlockHint("timer");
    let release!:(words:string[])=>void;
    generate.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValueOnce(["轮船","帆船"]);
    const updates:InteractionProgress[]=[];
    const result=game.applyInteraction(gift,{...base,randomWords:2},p=>updates.push(p));
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    expect(generate.mock.calls[0][0].hints.length).toBe(1);
    const oldRound=(game.snapshot().round as any).roundId;
    vi.setSystemTime((game.snapshot().round as any).endsAt+1);internal.tick();
    release(["香蕉","水果"]);
    await vi.waitFor(()=>expect(game.interactionDiagnostics().waitingForRound).toBe(1));
    expect(updates.at(-1)).toMatchObject({status:"running",remainingWords:2,waitingForRound:true});
    config.game.answer="游艇";
    vi.setSystemTime((game.snapshot().round as any).settleAt+1);internal.tick();
    vi.setSystemTime((game.snapshot().round as any).settleAt+1);internal.tick();
    await result;
    expect(updates.at(-1)).toMatchObject({status:"completed",completedWords:2,aiWords:2,remainingWords:0,carriedRounds:1});
    const accepted=messages.filter(m=>m.type==="GUESS_ACCEPTED");
    expect(accepted.map(m=>(m.guess as any).word)).toEqual(["轮船","帆船"]);
    expect(accepted.every(m=>(m.round as any).roundId!==oldRound)).toBe(true);
    expect(generate.mock.calls[1][0].hints).toEqual([]);
    expect(game.interactionDiagnostics().pendingJobs).toBe(0);
  });
  it("preserves completed counts across a natural round change without replaying them",async()=>{
    const {game,config,generate,evaluation,gift,base,messages}=setup(true);
    generate.mockResolvedValueOnce(["香蕉","水果"]).mockResolvedValueOnce(["轮船"]);
    let release!:()=>void;
    evaluation.mockImplementation(function(a,g){const result=this.evaluate(a,g);return g==="水果"?new Promise(resolve=>{release=()=>resolve(result);}):Promise.resolve(result);});
    const changes:InteractionProgress[]=[];
    const result=game.applyInteraction(gift,{...base,randomWords:2},p=>changes.push(p));
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    expect(changes.at(-1)).toMatchObject({completedWords:1,aiWords:1,remainingWords:1});
    config.game.answer="游艇";
    (game as unknown as {startNextRound:()=>void}).startNextRound();
    release();await result;
    expect(changes.at(-1)).toMatchObject({status:"completed",completedWords:2,carriedRounds:1});
    expect(messages.filter(m=>m.type==="GUESS_ACCEPTED").map(m=>(m.guess as any).word)).toEqual(["香蕉","轮船"]);
    expect(generate.mock.calls.map(([input])=>input.count)).toEqual([2,1]);
  });
  it.each(["pause","next","room","stop"] as const)("cancels a carried waiter on explicit %s",async action=>{
    const {game,gift,base}=setup(true);
    (game as unknown as {round:{status:string}}).round.status="SETTLEMENT";
    let latest:InteractionProgress|undefined;
    const result=game.applyInteraction(gift,{...base,randomWords:2},p=>{latest=p;});
    await vi.waitFor(()=>expect(game.interactionDiagnostics().waitingForRound).toBe(1));
    if(action==="room")game.resetRoom();else if(action==="stop")game.invalidateInteractions();else game.control(action);
    await result;
    expect(latest).toMatchObject({status:"cancelled",completedWords:0,remainingWords:2,waitingForRound:false});
    expect(game.interactionDiagnostics().pendingJobs).toBe(0);
  });
  it("keeps queued gifts valid across a natural round without reapplying time effects",async()=>{
    const {game,config,generate,gift,base,messages}=setup(true);
    let release!:(words:string[])=>void;
    generate.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValueOnce(["轮船"]).mockResolvedValueOnce(["帆船"]);
    const first:InteractionProgress[]=[],second:InteractionProgress[]=[];
    const job1=game.applyInteraction(gift,{...base,randomWords:1,extraTimeMs:3000},p=>first.push(p));
    const job2=game.applyInteraction({...gift,eventId:"second-gift"},{...base,randomWords:1},p=>second.push(p));
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    expect(game.interactionDiagnostics()).toMatchObject({pendingJobs:2,queuedJobs:1,modelJobs:2,remainingWords:2});
    config.game.answer="游艇";(game as unknown as {startNextRound:()=>void}).startNextRound();
    release(["香蕉"]);await Promise.all([job1,job2]);
    expect(first.at(-1)).toMatchObject({status:"completed",completedWords:1,carriedRounds:1,appliedTimeMs:3000});
    expect(second.at(-1)).toMatchObject({status:"completed",completedWords:1,carriedRounds:1});
    expect(messages.filter(m=>m.type==="GIFT_RECEIVED")).toHaveLength(2);
    expect(messages.filter(m=>m.type==="GIFT_EFFECT")).toHaveLength(1);
    expect(game.interactionDiagnostics().pendingJobs).toBe(0);
  });
});
