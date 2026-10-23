// Read-only real-model comparison. Never writes game configuration or live events.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SemanticEngine } from "../dist/game/SemanticEngine.js";
import { EmbeddingClient } from "../dist/game/EmbeddingClient.js";
import { DictionaryLibraryService } from "../dist/dictionary/DictionaryLibraryService.js";
import { ConceptDictionary } from "../dist/dictionary/ConceptDictionary.js";
import { expandedQualityCases } from "./semantic-quality-cases.mjs";

// Predeclared development checks across categories, lengths and polysemous surfaces.
// A relation is about the intended question sense, not a claimed universal score.
export const qualityCases = [
  { answer:"苹果", related:["香蕉","葡萄","水果"], unrelated:["电脑","手机","键盘"] },
  { answer:"电脑", related:["键盘","鼠标","手机"], unrelated:["香蕉","森林","河流"] },
  { answer:"游艇", related:["轮船","帆船","海洋"], unrelated:["香蕉","枕头","铅笔"] },
  { answer:"蝴蝶", related:["昆虫","蜜蜂","飞蛾"], unrelated:["电脑","列车","饭店"] },
  { answer:"鲸鱼", related:["海豚","海洋","鲨鱼"], unrelated:["钥匙","枕头","键盘"] },
  { answer:"面包", related:["蛋糕","小麦","早餐"], unrelated:["键盘","火车","雷电"] },
  { answer:"蛋糕", related:["甜点","奶油","面包"], unrelated:["手机","火车","山谷"] },
  { answer:"雨伞", related:["雨衣","下雨","遮雨"], unrelated:["香蕉","键盘","医生"] },
  { answer:"钥匙", related:["门锁","开锁","锁孔"], unrelated:["香蕉","海洋","雷电"] },
  { answer:"相机", related:["摄影","镜头","照片"], unrelated:["香蕉","枕头","河流"] },
  { answer:"篮球", related:["球场","投篮","运动"], unrelated:["枕头","键盘","蜂蜜"] },
  { answer:"地铁", related:["列车","车站","交通"], unrelated:["蜂蜜","蝴蝶","枕头"] },
  { answer:"医生", related:["医院","护士","医疗"], unrelated:["香蕉","雷电","钥匙"] },
  { answer:"老师", related:["学校","教学","学生"], unrelated:["蜂蜜","鲸鱼","雷电"] },
  { answer:"花瓣", related:["花朵","花蕊","鲜花"], unrelated:["键盘","火车","相机"] },
  { answer:"钟表", related:["时间","时钟","手表"], unrelated:["香蕉","蝴蝶","海洋"] },
  { answer:"水", related:["河","海","雨"], unrelated:["锁","猫","车"] },
  { answer:"洗发水", related:["护发素","洗头液","沐浴露"], unrelated:["打印机","自行车","望远镜"] },
  { answer:"老虎", related:["狮子","豹子","猛兽"], unrelated:["手机","枕头","地铁"] },
  { answer:"筷子", related:["餐具","吃饭","竹筷"], unrelated:["键盘","雷电","机场"] },
  { answer:"勺子", related:["汤匙","餐具","舀汤"], unrelated:["手机","蝴蝶","地铁"] },
  { answer:"广场", related:["公园","空地","集会"], unrelated:["键盘","香蕉","枕头"] },
  { answer:"超市", related:["商店","购物","零售"], unrelated:["雷电","蝴蝶","河流"] },
  { answer:"市场", related:["商场","交易","集市"], unrelated:["雨伞","键盘","海洋"] },
  { answer:"邮局", related:["邮政","邮寄","信件"], unrelated:["键盘","香蕉","鲸鱼"] },
  { answer:"烘焙", related:["面包","糕点","烤箱"], unrelated:["钥匙","雷电","地铁"] },
  { answer:"书法", related:["毛笔","汉字","墨水"], unrelated:["鲸鱼","地铁","钥匙"] },
  { answer:"厨师", related:["厨房","烹饪","餐厅"], unrelated:["枕头","雷电","电脑"] },
  { answer:"农夫", related:["农民","种田","农耕"], unrelated:["地铁","键盘","钥匙"] },
];

export function scoreCosine(a,b) {
  if(!a.length||a.length!==b.length)throw new Error("向量维度不一致。");
  const scaleA=Math.max(...a.map(Math.abs)),scaleB=Math.max(...b.map(Math.abs));
  if(!scaleA||!scaleB)throw new Error("零向量不可评分。");
  let dot=0,normA=0,normB=0;
  for(let i=0;i<a.length;i++){const x=a[i]/scaleA,y=b[i]/scaleB;dot+=x*y;normA+=x*x;normB+=y*y;}
  const raw=dot/Math.sqrt(normA*normB);
  if(!Number.isFinite(raw))throw new Error("评分不是有效有限值。");
  return Math.min(99.9,Math.max(0,Math.round(raw*1000)/10));
}

export function relationResult(scores) {
  const related=scores.filter(s=>s.relation==="related").map(s=>s.score);
  const unrelated=scores.filter(s=>s.relation==="unrelated").map(s=>s.score);
  if(!related.length||!unrelated.length||scores.some(s=>!Number.isFinite(s.score)))throw new Error("关系测试必须包含有效的相关和无关分数。");
  return {passed:Math.min(...related)>Math.max(...unrelated),margin:Math.round((Math.min(...related)-Math.max(...unrelated))*10)/10};
}

export function guardedCheckSummary(results, answerCount) {
  const failedAnswers = results.filter(result => !result.withGuard.passed).map(result => result.answer);
  const allSelectedGuardedChecksPassed = results.length > 0 && failedAnswers.length === 0;
  return { failedAnswers, allSelectedGuardedChecksPassed,
    fullPoolGuardedChecksPassed: allSelectedGuardedChecksPassed && results.length === answerCount };
}

export function selectQualityCases(cases, answerPool, requireCoverage = false) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 1000) throw new Error("关系标签数量无效。");
  const seen = new Set(), pool = new Set(answerPool);
  for (const sample of cases) {
    if (typeof sample?.answer !== "string" || !/^\p{Script=Han}{1,4}$/u.test(sample.answer) || seen.has(sample.answer)) throw new Error("题目标签无效或重复。");
    seen.add(sample.answer);
    if (!Array.isArray(sample.related) || !Array.isArray(sample.unrelated) || sample.related.length !== 3 || sample.unrelated.length !== 3) throw new Error("每题须有三条相关及三条无关对照。");
    const words = [...sample.related, ...sample.unrelated];
    if (new Set(words).size !== 6 || words.some(word => typeof word !== "string" || !/^\p{Script=Han}+$/u.test(word) || [...word].length !== [...sample.answer].length || word === sample.answer)) throw new Error("猜词标签字数、去重或答案自引用无效。");
  }
  const uncovered = answerPool.filter(answer => !seen.has(answer));
  const absent = cases.filter(sample => !pool.has(sample.answer)).map(sample => sample.answer);
  if (requireCoverage && (uncovered.length || absent.length)) throw new Error(`全库标签与实际题库不一致：缺少${uncovered.length}题，多出${absent.length}题。`);
  const selected = cases.filter(sample => pool.has(sample.answer));
  if (!selected.length) throw new Error("没有可以验证的题目。");
  return { selected, uncovered, absent, answerCount: answerPool.length, coverageComplete: uncovered.length === 0 };
}

export async function verifyQuality({base="http://127.0.0.1:1234/v1",model="text-embedding-qwen3-embedding-0.6b",packageId,outputRoot=resolve(import.meta.dirname,"../.runtime/semantic-quality"),cases=qualityCases,requireCoverage=false,onProgress}={}) {
  const url=new URL(base);
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error("独立验证只允许无凭据的本机向量服务。");
  if(!packageId)throw new Error("请明确指定要检查的词库包，不自动改变正式词库。");
  if(!/^[a-zA-Z0-9_.:-]{1,160}$/.test(packageId))throw new Error("词库包ID无效。");
  const dataRoot=resolve(import.meta.dirname,"../data");
  // Do not let the production library's default fallback mislabel this audit.
  const dictionary=packageId==="builtin:multi_core_v1"?new DictionaryLibraryService(dataRoot,packageId).loadActive():
    new ConceptDictionary({snapshot:JSON.parse(await readFile(join(dataRoot,"dictionary-library",`${packageId}.json`),"utf8")).snapshot});
  const baseline=new SemanticEngine({dictionary,language:"zh-Hans",baseUrl:base,model,apiKey:""});
  const guarded=new SemanticEngine({dictionary,language:"zh-Hans",baseUrl:base,model,apiKey:"",useReviewedDefinitions:true});
  const coverage=selectQualityCases(cases,baseline.answerPool,requireCoverage);
  // Validate all labels before any inference; a truncated run is not all-pool coverage.
  for (const sample of coverage.selected) {
    for (const guess of [...sample.related,...sample.unrelated]) {
      if (!baseline.validate(guess,[...sample.answer].length).ok) throw new Error(`测试字数无效：${sample.answer}/${guess}`);
    }
    const targetConcept=dictionary.resolve(sample.answer,"zh-Hans");
    for (const guess of sample.unrelated) {
      const other=dictionary.resolve(guess,"zh-Hans");
      if (targetConcept.status==="resolved"&&other.status==="resolved"&&targetConcept.conceptId===other.conceptId) throw new Error(`无关标签与答案同概念：${sample.answer}/${guess}`);
    }
  }
  const probe=new EmbeddingClient({baseUrl:base,model,apiKey:"",timeoutMs:8000});
  const started=performance.now(),results=[];
  for(const sample of coverage.selected) {
    const concept=dictionary.resolve(sample.answer,"zh-Hans");
    const definition=concept.status==="resolved"?concept.concept.definitions["zh-Hans"]?.trim():undefined;
    const input=definition?`${sample.answer}。${definition}`:sample.answer;
    const target=await probe.embed(input),scores=[];
    for(const [relation,words] of [["related",sample.related],["unrelated",sample.unrelated]]) {
      for(const guess of words) {
        if(!baseline.validate(guess,[...sample.answer].length).ok)throw new Error(`测试字数无效：${sample.answer}/${guess}`);
        const raw=await baseline.evaluateWithEmbedding(sample.answer,guess);
        if(!["embedding","exact"].includes(raw.similarityMode))throw new Error("真实向量不可用；本地回退不能当语义质量通过。");
        const vector=await probe.embed(guess),protectedResult=await guarded.evaluateWithEmbedding(sample.answer,guess);
        if(!["embedding","exact"].includes(protectedResult.similarityMode))throw new Error("具体义项策略回退，不能当真实向量通过。");
        scores.push({guess,relation,surfaceScore:raw.displayScore,definitionScore:scoreCosine(target,vector),guardedScore:protectedResult.displayScore,exactConcept:raw.similarityMode==="exact"});
      }
    }
    const surface=relationResult(scores.map(s=>({relation:s.relation,score:s.surfaceScore})));
    const withDefinition=relationResult(scores.map(s=>({relation:s.relation,score:s.definitionScore})));
    const withGuard=relationResult(scores.map(s=>({relation:s.relation,score:s.guardedScore})));
    results.push({answer:sample.answer,definition:definition??null,contextInput:input,guardedInput:guarded.embeddingInputFor(sample.answer),surface,withDefinition,withGuard,scores});
    onProgress?.({completed:results.length,total:coverage.selected.length});
  }
  const report={at:new Date().toISOString(),readOnly:true,realEmbeddings:true,liveEventsInjected:false,productionScoringChanged:false,packageId,model,dimensions:probe.status().dimensions,elapsedMs:Math.round(performance.now()-started),groups:results.length,comparisons:results.reduce((n,r)=>n+r.scores.length,0),answerCount:coverage.answerCount,coverageComplete:coverage.coverageComplete,uncoveredAnswers:coverage.uncovered,absentCases:coverage.absent,labelFingerprint:createHash("sha256").update(JSON.stringify(coverage.selected)).digest("hex"),labelReview:"开发期预设词义对照，非独立专家审核",exactConceptComparisons:results.reduce((n,r)=>n+r.scores.filter(s=>s.exactConcept).length,0),surfacePassed:results.filter(r=>r.surface.passed).length,definitionPassed:results.filter(r=>r.withDefinition.passed).length,guardedPassed:results.filter(r=>r.withGuard.passed).length,...guardedCheckSummary(results,coverage.answerCount),regressions:results.filter(r=>r.surface.passed&&!r.withDefinition.passed).map(r=>r.answer),guardedRegressions:results.filter(r=>r.surface.passed&&!r.withGuard.passed).map(r=>r.answer),results,limits:"每题三相关/三无关的预设标签；覆盖全部题目不等于所有词对已校准或模型吞吐验收。同概念按生产精确命中规则计分并单独计数；每个词另取真实向量，不用本地回退。候选方案只改变答案输入，不给猜词附加谜底类别。"};
  const directory=join(outputRoot,`${Date.now()}-${randomUUID().slice(0,8)}`);await mkdir(directory,{recursive:true});
  const output=join(directory,"comparison.json");await writeFile(output,JSON.stringify(report,null,2),"utf8");
  return {output,...report};
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.dirname,"verify-semantic-quality.mjs")) {
  try {
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i++){
      if(args[i]==="--all"){options["--all"]=true;continue;}
      if(!["--base","--model","--package"].includes(args[i])||!args[i+1])throw new Error("参数不正确。");options[args[i]]=args[++i];
    }
    const result=await verifyQuality({base:options["--base"],model:options["--model"],packageId:options["--package"],cases:options["--all"]?expandedQualityCases:qualityCases,requireCoverage:options["--all"]===true,onProgress:p=>{if(p.completed%10===0||p.completed===p.total)console.error(`已验证 ${p.completed}/${p.total} 题（独立本机向量，未注入直播）`);}});
    const {results,...summary}=result;console.log(JSON.stringify(summary,null,2));
  }catch(error){console.error(error instanceof Error?error.message:"语义对照未完成。");process.exitCode=1;}
}
