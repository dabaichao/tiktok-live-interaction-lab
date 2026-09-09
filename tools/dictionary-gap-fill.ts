import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ConceptDictionary } from "../src/dictionary/ConceptDictionary.js";
import { DictionaryGapFillClient, missingLabelsForLanguage } from "../src/dictionary/DictionaryGapFill.js";
import type { DictionaryLanguage } from "../src/dictionary/types.js";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"] as const;
}));
const language = (args.get("language") ?? "vi") as DictionaryLanguage;
const limit = Math.max(0, Number(args.get("limit") ?? "0") || 0);
const dictionary = ConceptDictionary.default();
const missing = missingLabelsForLanguage(dictionary.snapshot.concepts, language);
const selected = limit > 0 ? missing.slice(0, limit) : missing;
const client = new DictionaryGapFillClient({ model: args.get("model") ?? undefined });

if (!client.status().configured) {
  console.error("未配置 HINT_LLM_API_KEY；本工具只生成候选提案，不会修改已发布词典。");
  process.exitCode = 2;
} else {
  const proposals = await client.propose({ language, concepts: selected });
  const outputDir = resolve(process.env.DATA_DIR ?? "data", "dictionary-proposals");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `${language}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  for (const proposal of proposals) appendFileSync(outputPath, `${JSON.stringify(proposal)}\n`, "utf8");
  console.log(JSON.stringify({ language, requestedConcepts: selected.length, proposals: proposals.length, outputPath, model: client.status().model }, null, 2));
}

