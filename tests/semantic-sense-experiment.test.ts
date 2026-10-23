import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { prepareExperiment, senseFingerprint, canonical, localEndpoint } from "../tools/verify-semantic-senses.mjs";

const sha = (x:any)=>createHash("sha256").update(x).digest("hex");
function fixture() {
  const cases=[{answer:"彩虹",related:["七彩","雨后","光谱"],unrelated:["键盘","枕头","地铁"]}];
  const baseBytes=Buffer.from(JSON.stringify({schemaVersion:1,wordlistId:"test",defaultLanguage:"zh-Hans",languages:["zh-Hans","en"],release:"test",concepts:[
    {conceptId:"rainbow",senseKey:"rainbow",category:"nature",labels:{"zh-Hans":"彩虹",en:"rainbow"},definitions:{"zh-Hans":"与自然世界有关的事物"},status:"approved",isAnswerable:true,aliases:[]}
  ]}));
  const baselineBytes=Buffer.from(JSON.stringify({realEmbeddings:true,labelFingerprint:sha(JSON.stringify(cases)),results:[{
    answer:"彩虹",scores:cases.flatMap(c=>[...c.related.map(guess=>({guess,relation:"related"})),...c.unrelated.map(guess=>({guess,relation:"unrelated"}))])
  }]}));
  const row={conceptId:"rainbow",word:"彩虹",definition:"阳光经过空气中的水滴后呈现的弧形多色光带",sourceModel:"hy3",auditModel:"deepseek-v4.1-flash",verdict:"approve",auditFingerprint:""};
  row.auditFingerprint=senseFingerprint(row,sha(baseBytes));
  const review={schemaVersion:1,kind:"isolated-semantic-senses",productionChanged:false,binding:{baseFileHash:sha(baseBytes),baselineFileHash:sha(baselineBytes),
    labelFingerprint:sha(JSON.stringify(cases)),targets:[{conceptId:"rainbow",word:"彩虹",senseKey:"rainbow",englishLabel:"rainbow",category:"nature",originalDirection:"与自然世界有关的事物"}]},senses:[row]};
  return {baseBytes,baselineBytes,review,cases};
}

describe("isolated precise-sense experiment",()=>{
  it("only modifies an in-memory copy and preserves fixed labels",()=>{
    const f=fixture(),before=JSON.stringify(f);
    const p=prepareExperiment(f);
    expect(JSON.stringify(f)).toBe(before);
    expect(p.changed).toEqual(["彩虹"]);
    expect(p.original.resolve("彩虹","zh-Hans").concept.definitions["zh-Hans"]).toBe("与自然世界有关的事物");
    expect(p.candidate.resolve("彩虹","zh-Hans").concept.definitions["zh-Hans"]).toContain("水滴");
    expect(p.selected).toEqual(f.cases);
  });
  it("rejects stale hashes, labels or source words before inference",()=>{
    for(const name of ["baseFileHash","baselineFileHash","labelFingerprint"]) {
      const f=fixture();f.review.binding[name]="bad";
      expect(()=>prepareExperiment(f)).toThrow();
    }
    const f=fixture();f.cases[0].related[0]="天空";
    expect(()=>prepareExperiment(f)).toThrow("指纹");
  });
  it("cannot trust a candidate modified after independent review",()=>{
    const f=fixture();f.review.senses[0].definition+="未经审查";
    expect(()=>prepareExperiment(f)).toThrow("审核后");
  });
  it("does not infer with rejected, unresolved or missing candidates",()=>{
    const rejected=fixture();rejected.review.senses[0].verdict="reject";
    expect(()=>prepareExperiment(rejected)).toThrow("没有已审");
    const unresolved=fixture();unresolved.review.senses[0].definition=null;
    expect(()=>prepareExperiment(unresolved)).toThrow("没有已审");
    const missing=fixture();missing.review.senses=[];
    expect(()=>prepareExperiment(missing)).toThrow("缺失");
  });
  it("rejects swapped concepts, duplicate targets and duplicate candidates",()=>{
    const swapped=fixture();swapped.review.binding.targets[0].englishLabel="computer";
    expect(()=>prepareExperiment(swapped)).toThrow("原题");
    const duplicate=fixture();duplicate.review.binding.targets.push(duplicate.review.binding.targets[0]);
    expect(()=>prepareExperiment(duplicate)).toThrow("重复");
    const candidate=fixture();candidate.review.senses.push(candidate.review.senses[0]);
    expect(()=>prepareExperiment(candidate)).toThrow("重复");
  });
  it("does not run identical category templates to accumulate apparent passes",()=>{
    const f=fixture();f.review.senses[0].definition="与自然世界有关的事物";
    f.review.senses[0].auditFingerprint=senseFingerprint(f.review.senses[0],f.review.binding.baseFileHash);
    expect(()=>prepareExperiment(f)).toThrow();
  });
  it("canonical fingerprint matches Python sorted Unicode JSON",()=>{
    expect(canonical({b:"彩虹",a:null})).toBe('{"a":null,"b":"彩虹"}');
  });
  it("allows only credential-free loopback inference",()=>{
    expect(()=>localEndpoint("http://127.0.0.1:1234/v1")).not.toThrow();
    for(const url of ["https://external.example/v1","http://key@127.0.0.1:1234/v1","http://127.0.0.1:1234/v1?key=secret"]) expect(()=>localEndpoint(url)).toThrow("本机");
  });
});
