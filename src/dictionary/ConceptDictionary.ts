import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { DictionaryAlias, DictionaryConcept, DictionaryLanguage, DictionarySnapshot, ResolveResult } from "./types.js";

export interface ConceptDictionaryOptions {
  filePath?: string;
  snapshot?: DictionarySnapshot;
}

export interface DictionaryStats {
  wordlistId: string;
  release: string;
  concepts: number;
  answerableConcepts: number;
  guessableConcepts: number;
  aliases: number;
  aliasesByLanguage: Record<string, number>;
  ambiguousKeys: number;
  missingLabelsByLanguage: Record<string, number>;
}

const DEFAULT_DICTIONARY_PATH = fileURLToPath(new URL("../../data/dictionaries/multilingual_core_v1.json", import.meta.url));

export class ConceptDictionary {
  readonly snapshot: DictionarySnapshot;
  private readonly concepts = new Map<string, DictionaryConcept>();
  private readonly aliasIndex = new Map<string, string[]>();

  constructor(options: ConceptDictionaryOptions = {}) {
    const raw = options.snapshot ?? JSON.parse(readFileSync(resolve(options.filePath ?? DEFAULT_DICTIONARY_PATH), "utf8")) as unknown;
    this.snapshot = validateSnapshot(raw);
    for (const concept of this.snapshot.concepts) {
      this.concepts.set(concept.conceptId, concept);
      for (const alias of this.approvedAliases(concept)) {
        const key = this.key(alias.lang, alias.text);
        const candidates = this.aliasIndex.get(key) ?? [];
        if (!candidates.includes(concept.conceptId)) candidates.push(concept.conceptId);
        this.aliasIndex.set(key, candidates);
      }
    }
  }

  static default(): ConceptDictionary {
    return new ConceptDictionary();
  }

  normalizeSurface(text: string): string {
    return text.normalize("NFKC").toLocaleLowerCase().trim().replace(/\s+/g, " ");
  }

  resolve(text: string, language = this.snapshot.defaultLanguage): ResolveResult {
    const normalizedKey = this.normalizeSurface(text);
    if (!normalizedKey) return { status: "unknown", language, normalizedKey };
    const candidates = this.aliasIndex.get(this.key(language, normalizedKey)) ?? [];
    if (candidates.length === 1) {
      const concept = this.concepts.get(candidates[0]);
      if (concept) return { status: "resolved", conceptId: concept.conceptId, concept, language, normalizedKey };
    }
    if (candidates.length > 1) return { status: "ambiguous", candidates: [...candidates], language, normalizedKey };
    return { status: "unknown", language, normalizedKey };
  }

  resolveAnyLanguage(text: string, preferredLanguage = this.snapshot.defaultLanguage): ResolveResult {
    const preferred = this.resolve(text, preferredLanguage);
    if (preferred.status !== "unknown") return preferred;
    for (const language of this.snapshot.languages) {
      if (language === preferredLanguage) continue;
      const result = this.resolve(text, language);
      if (result.status !== "unknown") return result;
    }
    return preferred;
  }

  getConcept(conceptId: string): DictionaryConcept | undefined {
    return this.concepts.get(conceptId);
  }

  conceptsFor(language = this.snapshot.defaultLanguage, mode: "answerable" | "guessable" = "guessable"): DictionaryConcept[] {
    return [...this.concepts.values()].filter((concept) => {
      if (concept.status !== "approved") return false;
      if (mode === "answerable" && !concept.isAnswerable) return false;
      if (mode === "guessable" && !concept.isGuessable) return false;
      return Boolean(this.labelFor(concept, language));
    });
  }

  answerWords(language = this.snapshot.defaultLanguage): string[] {
    return unique(this.conceptsFor(language, "answerable").map((concept) => this.labelFor(concept, language)).filter((value): value is string => Boolean(value)));
  }

  guessWords(language = this.snapshot.defaultLanguage): string[] {
    return unique(this.conceptsFor(language, "guessable").flatMap((concept) => {
      const label = this.labelFor(concept, language);
      const aliases = this.approvedAliases(concept).filter((alias) => alias.lang === language).map((alias) => alias.text);
      return [label, ...aliases].filter((value): value is string => Boolean(value));
    }));
  }

  relatedGuessWords(answer: string, language = this.snapshot.defaultLanguage): string[] {
    const key = this.normalizeSurface(answer);
    return unique(this.conceptsFor(language, "guessable")
      .filter((concept) => concept.relatedTo?.some((surface) => this.normalizeSurface(surface) === key))
      .flatMap((concept) => [this.labelFor(concept, language), ...this.approvedAliases(concept)
        .filter((alias) => alias.lang === language).map((alias) => alias.text)]
        .filter((value): value is string => Boolean(value))));
  }

  labelFor(concept: DictionaryConcept, language = this.snapshot.defaultLanguage): string | undefined {
    // A missing translation is a gap, not an answer in a different language.
    return concept.labels[language];
  }

  canonicalFor(conceptId: string, language = this.snapshot.defaultLanguage): string | undefined {
    const concept = this.concepts.get(conceptId);
    return concept ? this.labelFor(concept, language) : undefined;
  }

  categoryFor(text: string, language = this.snapshot.defaultLanguage): string | undefined {
    const resolved = this.resolve(text, language);
    return resolved.status === "resolved" ? resolved.concept.category : undefined;
  }

  stats(): DictionaryStats {
    const aliasesByLanguage: Record<string, number> = {};
    let aliases = 0;
    for (const concept of this.concepts.values()) {
      for (const alias of this.approvedAliases(concept)) {
        aliases += 1;
        aliasesByLanguage[alias.lang] = (aliasesByLanguage[alias.lang] ?? 0) + 1;
      }
    }
    const ambiguousKeys = [...this.aliasIndex.values()].filter((ids) => ids.length > 1).length;
    const missingLabelsByLanguage: Record<string, number> = {};
    for (const language of this.snapshot.languages) {
      missingLabelsByLanguage[language] = [...this.concepts.values()].filter((concept) => concept.status === "approved" && !concept.labels[language]).length;
    }
    return {
      wordlistId: this.snapshot.wordlistId,
      release: this.snapshot.release,
      concepts: this.concepts.size,
      answerableConcepts: this.conceptsFor(this.snapshot.defaultLanguage, "answerable").length,
      guessableConcepts: this.conceptsFor(this.snapshot.defaultLanguage, "guessable").length,
      aliases,
      aliasesByLanguage,
      ambiguousKeys,
      missingLabelsByLanguage,
    };
  }

  private approvedAliases(concept: DictionaryConcept): DictionaryAlias[] {
    return concept.aliases.filter((alias) => alias.reviewStatus === "approved" && alias.text.trim().length > 0);
  }

  private key(language: DictionaryLanguage, text: string): string {
    return `${language}:${this.normalizeSurface(text)}`;
  }
}

function validateSnapshot(value: unknown): DictionarySnapshot {
  if (!value || typeof value !== "object") throw new Error("Dictionary snapshot must be an object");
  const raw = value as Partial<DictionarySnapshot>;
  if (raw.schemaVersion !== 1 || typeof raw.wordlistId !== "string" || typeof raw.defaultLanguage !== "string" || !Array.isArray(raw.languages) || !Array.isArray(raw.concepts)) {
    throw new Error("Invalid dictionary snapshot metadata");
  }
  if (!raw.languages.length || raw.languages.some(language=>typeof language!=="string"||!language.trim()) || !raw.languages.includes(raw.defaultLanguage)) throw new Error("词库语言列表无效，必须包含默认语言。");
  const conceptIds=new Set<string>();
  const concepts = raw.concepts.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid dictionary concept");
    const concept = item as Partial<DictionaryConcept>;
    if (typeof concept.conceptId !== "string" || typeof concept.category !== "string" || typeof concept.labels !== "object" || concept.labels === null) throw new Error("Invalid dictionary concept fields");
    if (!concept.conceptId.trim() || conceptIds.has(concept.conceptId)) throw new Error("词库概念 ID 为空或重复，请先去重。");
    conceptIds.add(concept.conceptId);
    for(const record of [concept.labels,concept.definitions??{}]) {
      if(Array.isArray(record)||!record||typeof record!=="object"||Object.values(record).some(text=>typeof text!=="string")) throw new Error("词面与提示必须使用语言到文字的映射，不能是数字、数组或对象。");
    }
    if((concept.isAnswerable!==undefined&&typeof concept.isAnswerable!=="boolean")||(concept.isGuessable!==undefined&&typeof concept.isGuessable!=="boolean"))throw new Error("可出题与可猜词标记必须是布尔值。");
    if(concept.status!==undefined&&!["draft","approved","blocked","archived"].includes(concept.status))throw new Error("词库审核状态不正确。");
    const explicitAliases = Array.isArray(concept.aliases) ? concept.aliases : [];
    const labelAliases = Object.entries(concept.labels).map(([lang, text]) => ({ lang, text, type: "canonical", exact: true, reviewStatus: "approved" }));
    const aliases = [...labelAliases, ...explicitAliases];
    const seenAliases = new Set<string>();
    const normalizedAliases: DictionaryAlias[] = aliases.map((alias) => ({
      lang: String((alias as DictionaryAlias).lang),
      text: String((alias as DictionaryAlias).text),
      type: ((alias as DictionaryAlias).type ?? "canonical") as DictionaryAlias["type"],
      exact: (alias as DictionaryAlias).exact ?? true,
      reviewStatus: ((alias as DictionaryAlias).reviewStatus ?? "approved") as DictionaryAlias["reviewStatus"],
      sourceId: (alias as DictionaryAlias).sourceId,
      confidence: (alias as DictionaryAlias).confidence,
    })).filter((alias) => {
      // Published snapshots already contain label aliases. Reloading/importing
      // must not append them again; differing review/provenance stays intact.
      const identity = JSON.stringify(alias);
      if (seenAliases.has(identity)) return false;
      seenAliases.add(identity);
      return true;
    });
    return {
      conceptId: concept.conceptId,
      senseKey: concept.senseKey ?? concept.conceptId,
      category: concept.category,
      partOfSpeech: concept.partOfSpeech && typeof concept.partOfSpeech === "object" ? Object.fromEntries(Object.entries(concept.partOfSpeech).filter(([, label]) => typeof label === "string" && label.length <= 20)) : undefined,
      definitions: concept.definitions ?? {},
      labels: concept.labels,
      isAnswerable: concept.isAnswerable ?? true,
      isGuessable: concept.isGuessable ?? true,
      status: concept.status ?? "approved",
      relatedTo: Array.isArray(concept.relatedTo) ? [...new Set(concept.relatedTo.filter((surface): surface is string => typeof surface === "string" && surface.length <= 80))] : undefined,
      relationLevel: concept.relationLevel === "near" || concept.relationLevel === "medium" || concept.relationLevel === "wide" ? concept.relationLevel : undefined,
      aliases: normalizedAliases,
    } satisfies DictionaryConcept;
  });
  return {
    schemaVersion: 1,
    wordlistId: raw.wordlistId,
    release: raw.release ?? "unknown",
    defaultLanguage: raw.defaultLanguage,
    languages: raw.languages,
    concepts,
    sourceManifest: raw.sourceManifest,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
