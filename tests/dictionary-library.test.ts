import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DictionaryLibraryService } from "../src/dictionary/DictionaryLibraryService.js";

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
      concepts: [{ conceptId: "food.apple", senseKey: "apple", category: "food", definitions: { "zh-Hans": "水果的一种" }, labels: { "zh-Hans": "苹果" }, isAnswerable: true, isGuessable: true, status: "approved", aliases: [] }],
    };
    await service.importPackage({ filename: "questions.json", packageType: "question-bank", content: JSON.stringify(snapshot) });
    const view = await service.view();
    expect(view.wordlistCount).toBe(1);
    expect(view.questionBankCount).toBe(1);
    expect(view.packageCount).toBe(2);

    const supplements = await service.addSupplements({ language: "zh-Hans", words: ["苹果", "香蕉", "香蕉"], sourceModel: "minimax-m3" });
    expect(supplements.accepted).toBe(1);
    expect(supplements.duplicates).toBe(2);
    expect((await service.view()).supplementCount).toBe(1);
  });
});
