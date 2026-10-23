import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticEngine } from "../src/game/SemanticEngine.js";
import { ConceptDictionary } from "../src/dictionary/ConceptDictionary.js";

afterEach(()=>vi.unstubAllGlobals());

function dictionary(definition:string,language="zh-Hans",status:"approved"|"draft"="approved") {
  return new ConceptDictionary({snapshot:{schemaVersion:1,wordlistId:"sense-test",release:"test",defaultLanguage:language,languages:[language],concepts:[
    {conceptId:"apple",senseKey:"fruit",category:"nature",labels:{[language]:language==="en"?"apple":"苹果"},definitions:{[language]:definition},isAnswerable:true,isGuessable:true,status,aliases:[]},
  ]}});
}

describe("reviewed Chinese answer sense embedding",()=>{
  it("uses only the answer's specific definition, keeps the guess bare and reports the policy",async()=>{
    const fetch=vi.fn().mockImplementation(async(_url,options)=>{
      const input=JSON.parse(options.body).input[0];
      return new Response(JSON.stringify({data:[{embedding:input==="苹果。水果的一种"?[1,0]:[0.8,0.6]}]}));
    });vi.stubGlobal("fetch",fetch);
    const engine=new SemanticEngine({dictionary:dictionary("水果的一种"),language:"zh-Hans",useReviewedDefinitions:true});
    expect(await engine.evaluateWithEmbedding("苹果","香蕉")).toMatchObject({displayScore:80,similarityMode:"embedding",isCorrect:false});
    expect(fetch.mock.calls.map(call=>JSON.parse(call[1].body).input)).toEqual([["苹果。水果的一种"],["香蕉"]]);
    expect(engine.embeddingStatus()).toMatchObject({answerContextMode:"reviewed-when-specific",mode:"embedding"});
  });

  it.each(["","与人或人群有关的事物","与自然世界有关的事物","生活中常见的一种食物","日常生活中常用的物品","自然界或生物的一种","与新领域有关的事物","描述一种味觉感受","日常生活中的一类食材","与劳动或制作有关的活动","与知识或技能有关的活动","生活中常见的一种饮品","长".repeat(121)])("keeps absent, generic or excessive definitions out of scoring: %s",definition=>{
    const engine=new SemanticEngine({dictionary:dictionary(definition),language:"zh-Hans",useReviewedDefinitions:true});
    expect(engine.embeddingInputFor("苹果")).toBe("苹果");
  });

  it("does not change default/TikTok or non-Chinese embedding inputs",()=>{
    expect(new SemanticEngine({dictionary:dictionary("水果的一种"),language:"zh-Hans"}).embeddingInputFor("苹果")).toBe("苹果");
    const en=new SemanticEngine({dictionary:dictionary("a fruit","en"),language:"en",useReviewedDefinitions:true});
    expect(en.embeddingInputFor("apple")).toBe("apple");
    expect(en.embeddingStatus().answerContextMode).toBe("surface");
  });

  it("never uses unreviewed, unknown or ambiguous concept definitions",()=>{
    expect(new SemanticEngine({dictionary:dictionary("水果的一种","zh-Hans","draft"),language:"zh-Hans",useReviewedDefinitions:true}).embeddingInputFor("苹果")).toBe("苹果");
    const d=dictionary("水果的一种");
    const duplicate=structuredClone(d.snapshot.concepts[0]);duplicate.conceptId="brand";duplicate.senseKey="brand";
    d.snapshot.concepts.push(duplicate);
    const engine=new SemanticEngine({dictionary:new ConceptDictionary({snapshot:d.snapshot}),language:"zh-Hans",useReviewedDefinitions:true});
    expect(engine.embeddingInputFor("苹果")).toBe("苹果");
    expect(engine.embeddingInputFor("未知")).toBe("未知");
  });

  it("retains exact-concept wins without requesting vectors or exposing the definition",async()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    const engine=new SemanticEngine({dictionary:dictionary("水果的一种"),language:"zh-Hans",useReviewedDefinitions:true});
    const result=await engine.evaluateWithEmbedding("苹果","苹果");
    expect(result).toMatchObject({displayScore:100,similarityMode:"exact",isCorrect:true});
    expect(JSON.stringify(result)).not.toContain("水果的一种");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes a reviewed definition and bounds cache entries by the contextual input",async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{embedding:[1,0]}]})));
    // A fresh Response per uncached request, so its body can only be consumed once.
    fetch.mockImplementation(async()=>new Response(JSON.stringify({data:[{embedding:[1,0]}]})));vi.stubGlobal("fetch",fetch);
    const engine=new SemanticEngine({dictionary:dictionary("  水果的一种。  "),language:"zh-Hans",useReviewedDefinitions:true});
    expect(engine.embeddingInputFor("苹果")).toBe("苹果。水果的一种");
    await engine.evaluateWithEmbedding("苹果","香蕉");await engine.evaluateWithEmbedding("苹果","香蕉");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(engine.embeddingStatus().cacheEntries).toBe(2);
  });
});
