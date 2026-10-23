// Read-only, frozen-label experiment. Candidate definitions never enter a stored dictionary.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SemanticEngine } from "../dist/game/SemanticEngine.js";
import { EmbeddingClient } from "../dist/game/EmbeddingClient.js";
import { ConceptDictionary } from "../dist/dictionary/ConceptDictionary.js";
import { expandedQualityCases } from "./semantic-quality-cases.mjs";
import { selectQualityCases, relationResult, scoreCosine } from "./verify-semantic-quality.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function senseFingerprint(row,baseFileHash) {
  return sha(canonical({baseFileHash,conceptId:row.conceptId,word:row.word,definition:row.definition,sourceModel:row.sourceModel}));
}
export function localEndpoint(base) {
  const url = new URL(base);
  if (url.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) throw new Error("只允许无凭据本机向量服务。");
}
export function prepareExperiment({baseBytes,baselineBytes,review,cases=expandedQualityCases}) {
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  const base = JSON.parse(baseBytes.toString("utf8"));
  if (review?.schemaVersion!==1 || review.kind!=="isolated-semantic-senses" || review.productionChanged!==false ||
      review.binding?.baseFileHash!==sha(baseBytes) || review.binding?.baselineFileHash!==sha(baselineBytes) ||
      review.binding?.labelFingerprint!==baseline.labelFingerprint ||
      !Array.isArray(review.binding.targets) || !review.binding.targets.length || review.binding.targets.length>20 ||
      !Array.isArray(review.senses) || !Array.isArray(baseline.results) || baseline.realEmbeddings!==true) throw new Error("实验绑定或证据无效/已改变。");
  const original = new ConceptDictionary({snapshot:base.snapshot??base});
  const engine = new SemanticEngine({dictionary:original,language:"zh-Hans",apiKey:"",useReviewedDefinitions:true});
  const coverage = selectQualityCases(cases,engine.answerPool,true);
  if (sha(JSON.stringify(coverage.selected))!==baseline.labelFingerprint) throw new Error("原始标签指纹已改变。");
  const baselineByWord = new Map(baseline.results.map(r=>[r.answer,r]));
  if (baselineByWord.size!==baseline.results.length || baselineByWord.size!==coverage.selected.length) throw new Error("原始比较覆盖不一致。");
  for(const c of cases) {
    const row = baselineByWord.get(c.answer);
    if (!Array.isArray(row?.scores) || row.scores.length!==6) throw new Error("原始六词对照缺失。");
    for(const [relation,words] of [["related",c.related],["unrelated",c.unrelated]]) for(const guess of words) {
      if(row.scores.filter(s=>s.guess===guess&&s.relation===relation).length!==1) throw new Error("原始词对或标签已改变。");
    }
  }
  const copy = structuredClone(original.snapshot), approved=[],excluded=[],ids=new Set();
  const senses = new Map(review.senses.map(s=>[s.conceptId,s]));
  if(senses.size!==review.senses.length) throw new Error("候选释义重复。");
  for(const t of review.binding.targets) {
    if(typeof t?.conceptId!=="string"||ids.has(t.conceptId)) throw new Error("目标标识无效或重复。");
    ids.add(t.conceptId);
    const resolved = original.resolve(t.word,"zh-Hans");
    if(resolved.status!=="resolved"||resolved.conceptId!==t.conceptId||!engine.answerPool.includes(t.word)||
       t.englishLabel!==(resolved.concept.labels.en??null)||t.senseKey!==(resolved.concept.senseKey??null)||
       t.category!==resolved.concept.category||t.originalDirection!==(resolved.concept.definitions["zh-Hans"]??null)) throw new Error("实验义项与原题不符。");
    const s = senses.get(t.conceptId);
    if(!s||s.word!==t.word||s.sourceModel!=="hy3") throw new Error("候选缺失或换题。");
    if(s.definition===null){excluded.push({answer:t.word,reason:"generation-unresolved"});continue;}
    if(typeof s.definition!=="string"||[...s.definition].length<12||[...s.definition].length>90||
       /sk-[A-Za-z0-9]{8,}|Bearer\s|https?:\/\//u.test(s.definition)||
       s.auditModel!=="deepseek-v4.1-flash"||s.auditFingerprint!==senseFingerprint(s,review.binding.baseFileHash)||
       !["approve","reject"].includes(s.verdict)) throw new Error("释义未独立审核或审核后被改变。");
    if(s.verdict==="reject"){excluded.push({answer:t.word,reason:"independent-rejection"});continue;}
    copy.concepts.find(c=>c.conceptId===t.conceptId).definitions["zh-Hans"] = s.definition;
    approved.push(t.word);
  }
  if(senses.size!==ids.size||review.senses.some(s=>!ids.has(s.conceptId))) throw new Error("候选超出实验目标。");
  if(!approved.length) throw new Error("没有已审释义；不请求向量。");
  const candidate = new ConceptDictionary({snapshot:copy});
  const candidateEngine = new SemanticEngine({dictionary:candidate,language:"zh-Hans",apiKey:"",useReviewedDefinitions:true});
  for(const word of approved) if(candidateEngine.embeddingInputFor(word)===engine.embeddingInputFor(word)) throw new Error("候选没有提供具体义项，不重复基线请求。");
  const changed = engine.answerPool.filter(word=>engine.embeddingInputFor(word)!==candidateEngine.embeddingInputFor(word));
  if(changed.length!==approved.length||changed.some(word=>!approved.includes(word))||
     canonical(engine.answerPool)!==canonical(candidateEngine.answerPool)) throw new Error("答案池或目标外评分输入改变。");
  const selected = cases.filter(c=>approved.includes(c.answer));
  // Preserve controls that previously regressed with blanket category definitions.
  const controlWords = ["苹果","老师","枕头","医生","章鱼","围巾"].filter(w=>!approved.includes(w)&&engine.answerPool.includes(w));
  const controls = cases.filter(c=>controlWords.includes(c.answer));
  return {original,candidate,selected,controls,excluded,changed,baseline,answerCount:engine.answerPool.length};
}

async function boundedFile(path, maximum) {
  if(!path) throw new Error("明确提供基础库、原证据和实验审核文件。");
  const bytes = await readFile(path);
  if(bytes.length>maximum) throw new Error("输入超过实验大小限制。");
  return bytes;
}

export async function verifySenses({baseFile,baselineFile,reviewFile,base="http://127.0.0.1:1234/v1",model="text-embedding-qwen3-embedding-0.6b",outputRoot=resolve(import.meta.dirname,"../.runtime/semantic-senses"),onProgress}={}) {
  localEndpoint(base);
  const baseBytes = await boundedFile(baseFile,4_000_000), baselineBytes = await boundedFile(baselineFile,4_000_000);
  const reviewBytes = await boundedFile(reviewFile,1_000_000), review = JSON.parse(reviewBytes.toString("utf8"));
  const prepared = prepareExperiment({baseBytes,baselineBytes,review});
  const original = new SemanticEngine({dictionary:prepared.original,language:"zh-Hans",apiKey:"",useReviewedDefinitions:true});
  const candidate = new SemanticEngine({dictionary:prepared.candidate,language:"zh-Hans",apiKey:"",useReviewedDefinitions:true});
  const client = new EmbeddingClient({baseUrl:base,model,apiKey:"",timeoutMs:8000});
  const started=performance.now(),results=[];
  for(const sample of [...prepared.selected,...prepared.controls]) {
    const baselineInput=original.embeddingInputFor(sample.answer),experimentInput=candidate.embeddingInputFor(sample.answer);
    const a=await client.embed(baselineInput),b=baselineInput===experimentInput?a:await client.embed(experimentInput),scores=[];
    for(const [relation,words] of [["related",sample.related],["unrelated",sample.unrelated]]) for(const guess of words) {
      const same = original.resolve(guess);
      if(same.status==="resolved"&&same.conceptId===original.resolve(sample.answer).conceptId) throw new Error("同概念样本需要单独验收，不拿精确命中冒充向量。");
      const vector=await client.embed(guess);
      scores.push({guess,relation,baselineScore:scoreCosine(a,vector),experimentScore:scoreCosine(b,vector)});
    }
    results.push({answer:sample.answer,role:prepared.changed.includes(sample.answer)?"experiment":"unchanged-control",baselineInput,experimentInput,
      baseline:relationResult(scores.map(s=>({relation:s.relation,score:s.baselineScore}))),
      experiment:relationResult(scores.map(s=>({relation:s.relation,score:s.experimentScore}))),scores});
    onProgress?.({completed:results.length,total:prepared.selected.length+prepared.controls.length});
  }
  const experiments=results.filter(r=>r.role==="experiment"),controls=results.filter(r=>r.role==="unchanged-control");
  const report={at:new Date().toISOString(),kind:"isolated-semantic-sense-comparison",readOnly:true,realEmbeddings:true,
    productionScoringChanged:false,liveEventsInjected:false,imported:false,activated:false,baseFileHash:review.binding.baseFileHash,
    baselineFileHash:review.binding.baselineFileHash,reviewFileHash:sha(reviewBytes),labelFingerprint:review.binding.labelFingerprint,
    model,dimensions:client.status().dimensions,elapsedMs:Math.round(performance.now()-started),
    experiments:experiments.length,comparisons:results.reduce((n,r)=>n+r.scores.length,0),experimentPassed:experiments.filter(r=>r.experiment.passed).length,
    experimentFailed:experiments.filter(r=>!r.experiment.passed).map(r=>r.answer),
    regressions:experiments.filter(r=>r.baseline.passed&&!r.experiment.passed).map(r=>r.answer),
    marginWorsened:experiments.filter(r=>r.experiment.margin<r.baseline.margin).map(r=>r.answer),
    controls:controls.length,controlPassed:controls.filter(r=>r.experiment.passed).length,
    fullPoolCalibrationPassed:false,answerCount:prepared.answerCount,unchangedExperimentInputs:prepared.answerCount-prepared.changed.length,
    unchangedProductionInputs:prepared.answerCount,
    excluded:prepared.excluded,results,limits:"失败题选择后的探索性实验；固定六词标签未改。独立模型审核不是专家金标准；对照通过不等于全词库、生产请求或真实直播通过。"};
  // Detect source changes during inference, before saving a successful comparison.
  for(const [path,bytes] of [[baseFile,baseBytes],[baselineFile,baselineBytes],[reviewFile,reviewBytes]]) if(sha(await readFile(path))!==sha(bytes)) throw new Error("实验期间来源改变；不保存为有效结果。");
  const directory=join(outputRoot,`${Date.now()}-${randomUUID().slice(0,8)}`);await mkdir(directory,{recursive:true});
  const output=join(directory,"comparison.json");await writeFile(output,JSON.stringify(report,null,2),"utf8");
  return {output,...report};
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.dirname,"verify-semantic-senses.mjs")) {
  try {
    const args=process.argv.slice(2),values={};
    for(let i=0;i<args.length;i++) {
      if(!["--base-file","--baseline-file","--review-file","--base","--model"].includes(args[i])||!args[i+1]) throw new Error("参数不正确。");
      values[args[i]]=args[++i];
    }
    const r=await verifySenses({baseFile:values["--base-file"],baselineFile:values["--baseline-file"],reviewFile:values["--review-file"],
      base:values["--base"],model:values["--model"],onProgress:p=>console.error(`隔离释义 ${p.completed}/${p.total}`)});
    const {results,...summary}=r;console.log(JSON.stringify(summary,null,2));
  } catch(error) {console.error(error instanceof Error?error.message:"隔离实验失败。");process.exitCode=1;}
}
