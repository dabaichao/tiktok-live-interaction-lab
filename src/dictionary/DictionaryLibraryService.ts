import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConceptDictionary, type DictionaryStats } from "./ConceptDictionary.js";
import type { DictionaryLanguage, DictionarySnapshot } from "./types.js";

export type DictionaryPackageType = "wordlist" | "question-bank";

export interface DictionaryPackageView {
  packageId: string;
  packageType: DictionaryPackageType;
  wordlistId: string;
  release: string;
  languages: DictionaryLanguage[];
  sizeBytes: number;
  importedAt: string;
  stats: DictionaryStats;
  active: boolean;
  fileName: string;
}

export interface DictionaryLibraryView {
  packageCount: number;
  wordlistCount: number;
  questionBankCount: number;
  supplementCount: number;
  packages: DictionaryPackageView[];
  activePackageId: string;
  supplementFile: string;
}

interface StoredPackage {
  schemaVersion: 1;
  packageId: string;
  packageType: DictionaryPackageType;
  importedAt: string;
  snapshot: DictionarySnapshot;
}

interface SupplementEntry {
  supplementId: string;
  language: DictionaryLanguage;
  word: string;
  sourceModel: string;
  status: "pending";
  createdAt: string;
}

const PACKAGE_SCHEMA_VERSION = 1;
const DEFAULT_PACKAGE_ID = "builtin:multi_core_v1";

export class DictionaryLibraryService {
  private readonly libraryDir: string;
  private readonly supplementPath: string;

  constructor(private readonly dataDir: string, private readonly activePackageId = DEFAULT_PACKAGE_ID) {
    this.libraryDir = resolve(dataDir, "dictionary-library");
    this.supplementPath = join(this.libraryDir, "supplements.jsonl");
  }

  async view(): Promise<DictionaryLibraryView> {
    const packages = [this.builtinView(), ...(await this.uploadedViews())];
    const supplements = await this.readSupplements();
    const active = packages.some((item) => item.packageId === this.activePackageId) ? this.activePackageId : DEFAULT_PACKAGE_ID;
    return {
      packageCount: packages.length,
      wordlistCount: packages.filter((item) => item.packageType === "wordlist").length,
      questionBankCount: packages.filter((item) => item.packageType === "question-bank").length,
      supplementCount: supplements.length,
      packages: packages.map((item) => ({ ...item, active: item.packageId === active })),
      activePackageId: active,
      supplementFile: this.supplementPath,
    };
  }

  loadActive(): ConceptDictionary {
    if (this.activePackageId === DEFAULT_PACKAGE_ID) return ConceptDictionary.default();
    const filePath = join(this.libraryDir, `${safeFilePart(this.activePackageId)}.json`);
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return new ConceptDictionary({ snapshot: extractSnapshot(raw) });
    } catch {
      return ConceptDictionary.default();
    }
  }

  async importPackage(input: { filename: string; packageType: DictionaryPackageType; content: string }): Promise<DictionaryPackageView> {
    const raw = JSON.parse(input.content) as unknown;
    const snapshot = extractSnapshot(raw);
    const dictionary = new ConceptDictionary({ snapshot });
    const packageId = `${safeFilePart(snapshot.wordlistId)}_${Date.now().toString(36)}`;
    const importedAt = new Date().toISOString();
    const stored: StoredPackage = { schemaVersion: PACKAGE_SCHEMA_VERSION, packageId, packageType: input.packageType, importedAt, snapshot: dictionary.snapshot };
    await mkdir(this.libraryDir, { recursive: true });
    const fileName = `${packageId}.json`;
    const filePath = join(this.libraryDir, fileName);
    await writeFile(filePath, JSON.stringify(stored, null, 2), "utf8");
    const sizeBytes = Buffer.byteLength(JSON.stringify(stored), "utf8");
    return { packageId, packageType: input.packageType, wordlistId: dictionary.snapshot.wordlistId, release: dictionary.snapshot.release, languages: dictionary.snapshot.languages, sizeBytes, importedAt, stats: dictionary.stats(), active: false, fileName };
  }

  async addSupplements(input: { language: DictionaryLanguage; words: string[]; sourceModel: string }): Promise<{ accepted: number; duplicates: number; totalPending: number; entries: SupplementEntry[] }> {
    const existing = new Set<string>();
    const dictionaries = [ConceptDictionary.default()];
    for (const packageView of await this.uploadedViews()) {
      try {
        const raw = JSON.parse(await readFile(join(this.libraryDir, packageView.fileName), "utf8")) as unknown;
        dictionaries.push(new ConceptDictionary({ snapshot: extractSnapshot(raw) }));
      } catch { /* ignore a package that disappeared during the read */ }
    }
    for (const dictionary of dictionaries) {
      for (const concept of dictionary.snapshot.concepts) {
        for (const label of Object.values(concept.labels)) if (label) existing.add(key(input.language, label));
        for (const alias of concept.aliases) if (alias.lang === input.language) existing.add(key(input.language, alias.text));
      }
    }
    const pending = await this.readSupplements();
    for (const item of pending) existing.add(key(item.language, item.word));
    const entries: SupplementEntry[] = [];
    let duplicates = 0;
    for (const rawWord of input.words) {
      const word = normalizeWord(rawWord);
      if (!word || word.length > 160 || !/[\p{L}]/u.test(word)) continue;
      const normalizedKey = key(input.language, word);
      if (existing.has(normalizedKey)) { duplicates += 1; continue; }
      existing.add(normalizedKey);
      entries.push({ supplementId: `${Date.now().toString(36)}_${entries.length.toString(36)}`, language: input.language, word, sourceModel: input.sourceModel || "unknown", status: "pending", createdAt: new Date().toISOString() });
    }
    if (entries.length > 0) {
      await mkdir(this.libraryDir, { recursive: true });
      await writeFile(this.supplementPath, `${pending.concat(entries).map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    }
    return { accepted: entries.length, duplicates, totalPending: pending.length + entries.length, entries };
  }

  private builtinView(): DictionaryPackageView {
    const dictionary = ConceptDictionary.default();
    return { packageId: DEFAULT_PACKAGE_ID, packageType: "wordlist", wordlistId: dictionary.snapshot.wordlistId, release: dictionary.snapshot.release, languages: dictionary.snapshot.languages, sizeBytes: Buffer.byteLength(JSON.stringify(dictionary.snapshot), "utf8"), importedAt: dictionary.snapshot.release, stats: dictionary.stats(), active: this.activePackageId === DEFAULT_PACKAGE_ID, fileName: "data/dictionaries/multilingual_core_v1.json" };
  }

  private async uploadedViews(): Promise<DictionaryPackageView[]> {
    try {
      const entries = await readdir(this.libraryDir, { withFileTypes: true });
      const packages: DictionaryPackageView[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "supplements.json") continue;
        try {
          const filePath = join(this.libraryDir, entry.name);
          const raw = JSON.parse(await readFile(filePath, "utf8")) as StoredPackage;
          const snapshot = extractSnapshot(raw);
          const dictionary = new ConceptDictionary({ snapshot });
          const info = await stat(filePath);
          packages.push({ packageId: raw.packageId, packageType: raw.packageType, wordlistId: dictionary.snapshot.wordlistId, release: dictionary.snapshot.release, languages: dictionary.snapshot.languages, sizeBytes: info.size, importedAt: raw.importedAt, stats: dictionary.stats(), active: raw.packageId === this.activePackageId, fileName: entry.name });
        } catch { /* ignore invalid or incomplete package files */ }
      }
      return packages.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    } catch {
      return [];
    }
  }

  private async readSupplements(): Promise<SupplementEntry[]> {
    try {
      const text = await readFile(this.supplementPath, "utf8");
      return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SupplementEntry).filter((item) => item.status === "pending");
    } catch {
      return [];
    }
  }
}

function extractSnapshot(value: unknown): DictionarySnapshot {
  if (value && typeof value === "object" && "snapshot" in value) return (value as { snapshot: DictionarySnapshot }).snapshot;
  return value as DictionarySnapshot;
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid dictionary package id");
  return safe;
}

function normalizeWord(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function key(language: DictionaryLanguage, word: string): string {
  return `${language}:${normalizeWord(word).toLocaleLowerCase()}`;
}
