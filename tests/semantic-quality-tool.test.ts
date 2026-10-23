import { describe, expect, it } from "vitest";
import { qualityCases, relationResult, scoreCosine, verifyQuality, selectQualityCases, guardedCheckSummary } from "../tools/verify-semantic-quality.mjs";
import { expandedQualityCases } from "../tools/semantic-quality-cases.mjs";

describe("isolated real-model quality verifier",()=>{
  it("includes unrelated controls and matching lengths for every labelled case",()=>{
    expect(qualityCases.length).toBe(29);
    for(const c of qualityCases){
      expect(c.related.length).toBe(3);expect(c.unrelated.length).toBe(3);
      for(const word of [...c.related,...c.unrelated])expect([...word].length,`${c.answer}/${word}`).toBe([...c.answer].length);
      expect(new Set([...c.related,...c.unrelated]).size).toBe(6);
    }
  });
  it("only passes when all related words outrank every unrelated control",()=>{
    expect(relationResult([{relation:"related",score:80},{relation:"related",score:70},{relation:"unrelated",score:60}])).toEqual({passed:true,margin:10});
    expect(relationResult([{relation:"related",score:60},{relation:"unrelated",score:60}]).passed).toBe(false);
    expect(relationResult([{relation:"related",score:80},{relation:"related",score:40},{relation:"unrelated",score:60}]).passed).toBe(false);
    expect(()=>relationResult([])).toThrow();
    expect(()=>relationResult([{relation:"related",score:NaN},{relation:"unrelated",score:60}])).toThrow();
  });
  it("has distinct predeclared controls for each of the 207 questions",()=>{
    expect(expandedQualityCases.length).toBe(207);
    const answers=expandedQualityCases.map(c=>c.answer);
    const result=selectQualityCases(expandedQualityCases,answers,true);
    expect(result.selected.length).toBe(207);expect(result.coverageComplete).toBe(true);
    expect(result.uncovered).toEqual([]);expect(result.absent).toEqual([]);
    for(const original of qualityCases)expect(expandedQualityCases.find(c=>c.answer===original.answer)).toEqual(original);
  });
  it("cannot silently call incomplete coverage a full-pool check",()=>{
    const sample=[qualityCases[0]];
    expect(selectQualityCases(sample,["苹果","森林"]).uncovered).toEqual(["森林"]);
    expect(()=>selectQualityCases(sample,["苹果","森林"],true)).toThrow("缺少1题");
    expect(()=>selectQualityCases(sample,["森林"],true)).toThrow("多出1题");
    expect(()=>selectQualityCases(sample,["森林"])).toThrow("没有可以验证");
  });
  it("separates completed coverage from passing every guarded relation check",()=>{
    const passed={answer:"苹果",withGuard:{passed:true}};
    const failed={answer:"帆",withGuard:{passed:false}};
    expect(guardedCheckSummary([passed,failed],2)).toEqual({failedAnswers:["帆"],allSelectedGuardedChecksPassed:false,fullPoolGuardedChecksPassed:false});
    expect(guardedCheckSummary([passed],2)).toEqual({failedAnswers:[],allSelectedGuardedChecksPassed:true,fullPoolGuardedChecksPassed:false});
    expect(guardedCheckSummary([passed],1).fullPoolGuardedChecksPassed).toBe(true);
    expect(guardedCheckSummary([],0).fullPoolGuardedChecksPassed).toBe(false);
  });
  it("rejects duplicate/self/length-mismatched or incomplete labels before inference",()=>{
    const sample=qualityCases[0];
    expect(()=>selectQualityCases([sample,sample],["苹果"])).toThrow("重复");
    expect(()=>selectQualityCases([{...sample,related:["苹果","葡萄","水果"]}],["苹果"])).toThrow("自引用");
    expect(()=>selectQualityCases([{...sample,related:["水","葡萄","水果"]}],["苹果"])).toThrow("字数");
    expect(()=>selectQualityCases([{...sample,unrelated:["电脑"]}],["苹果"])).toThrow("三条");
  });
  it("uses finite cosine values with the production display limit, not forced winners",()=>{
    expect(scoreCosine([1,0],[0.8,0.6])).toBe(80);
    expect(scoreCosine([1e308,1e308],[1e308,1e308])).toBe(99.9);
    expect(scoreCosine([1,0],[-1,0])).toBe(0);
    expect(()=>scoreCosine([0,0],[0,0])).toThrow();
    expect(()=>scoreCosine([1],[1,0])).toThrow();
  });
  it("rejects remote/credentialed model URLs and missing packages before any request",async()=>{
    await expect(verifyQuality({base:"https://external.example/v1",packageId:"not-used"})).rejects.toThrow("本机");
    await expect(verifyQuality({base:"http://key@127.0.0.1:1234/v1",packageId:"not-used"})).rejects.toThrow("本机");
    await expect(verifyQuality()).rejects.toThrow("明确指定");
    await expect(verifyQuality({packageId:"../../invalid"})).rejects.toThrow("ID无效");
    await expect(verifyQuality({packageId:"no-such-semantic-test-package"})).rejects.toThrow();
  });
});
