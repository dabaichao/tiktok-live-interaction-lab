import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DictionaryLibraryService } from "../src/dictionary/DictionaryLibraryService.js";
import { ConceptDictionary } from "../src/dictionary/ConceptDictionary.js";

describe("DictionaryLibraryService", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("imports packages, counts package types, and de-duplicates supplements", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-dictionary-library-"));
    const service = new DictionaryLibraryService(directory);
    const snapshot = {
      schemaVersion: 1,
      wordlistId: "zh_test_v1",
      release: "test",
      defaultLanguage: "zh-Hans",
      languages: ["zh-Hans"],
      concepts: [{ conceptId: "food.banana", senseKey: "banana", category: "food", definitions: { "zh-Hans": "水果的一种" }, labels: { "zh-Hans": "香蕉" }, isAnswerable: true, isGuessable: true, status: "approved", aliases: [] }],
    };
    await service.importPackage({ filename: "questions.json", packageType: "question-bank", content: JSON.stringify(snapshot) });
    const view = await service.view();
    expect(view.wordlistCount).toBe(1);
    expect(view.questionBankCount).toBe(1);
    expect(view.packageCount).toBe(2);

    const supplements = await service.addSupplements({ language: "zh-Hans", words: ["苹果", "香蕉", "香蕉"], sourceModel: "minimax-m3" });
    expect(supplements.accepted).toBe(0);
    expect(supplements.duplicates).toBe(3);
    expect((await service.view()).supplementCount).toBe(0);
  });

  it("serializes supplement writes across separate service instances", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-dictionary-library-"));
    const first = new DictionaryLibraryService(directory), second = new DictionaryLibraryService(directory);
    await Promise.all([first.addSupplements({ language: "zh-Hans", words: ["审核甲", "审核同词"], sourceModel: "test" }), second.addSupplements({ language: "zh-Hans", words: ["审核乙", "审核同词"], sourceModel: "test" })]);
    expect((await first.view()).supplementCount).toBe(3);
    const lines = (await readFile(join(directory, "dictionary-library", "supplements.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(new Set(lines.map(x => x.word)).size).toBe(3);
  });

  it("refuses to overwrite a corrupt supplement file", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-dictionary-library-"));
    await mkdir(join(directory, "dictionary-library"));
    const path = join(directory, "dictionary-library", "supplements.jsonl"); await writeFile(path, "damaged-review-data");
    await expect(new DictionaryLibraryService(directory).addSupplements({ language: "zh-Hans", words: ["审核词"], sourceModel: "test" })).rejects.toThrow("原文件保留");
    expect(await readFile(path, "utf8")).toBe("damaged-review-data");
  });
  it("keeps simultaneous imports unique and loadable even with long wordlist IDs", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-dictionary-library-"));
    const service=new DictionaryLibraryService(directory);
    const snapshot={schemaVersion:1,wordlistId:"long_"+"a".repeat(90),release:"test",defaultLanguage:"zh-Hans",languages:["zh-Hans"],concepts:[{conceptId:"audit.unique",senseKey:"unique",category:"test",labels:{"zh-Hans":"审核"},isAnswerable:true,isGuessable:true,status:"approved",aliases:[]}]};
    const imports=await Promise.all(Array.from({length:10},()=>service.importPackage({filename:"test.json",packageType:"question-bank",content:JSON.stringify(snapshot)})));
    expect(new Set(imports.map(p=>p.packageId)).size).toBe(10);
    for(const item of imports)expect(new DictionaryLibraryService(directory,item.packageId).loadActive().answerWords("zh-Hans")).toEqual(["审核"]);
  });
  it("does not grow aliases when a published package is imported repeatedly", async () => {
    directory = await mkdtemp(join(tmpdir(), "semantic-dictionary-roundtrip-"));
    const original = ConceptDictionary.default();
    let dictionary = original;
    for (let round = 0; round < 3; round++) {
      const imported = await new DictionaryLibraryService(directory).importPackage({
        filename: "roundtrip.json", packageType: "question-bank", content: JSON.stringify(dictionary.snapshot),
      });
      const stored = JSON.parse(await readFile(join(directory, "dictionary-library", imported.fileName), "utf8"));
      expect(stored.snapshot).toEqual(JSON.parse(JSON.stringify(original.snapshot)));
      dictionary = new DictionaryLibraryService(directory, imported.packageId).loadActive();
      expect(dictionary.stats()).toEqual(original.stats());
      expect(dictionary.snapshot).toEqual(original.snapshot);
    }
  });
});
