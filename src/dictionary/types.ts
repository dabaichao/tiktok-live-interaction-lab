export type DictionaryLanguage = "en" | "vi" | "zh-Hans" | (string & {});

export type ConceptStatus = "draft" | "approved" | "blocked" | "archived";
export type AliasType = "canonical" | "synonym" | "variant" | "colloquial" | "translated";
export type ReviewStatus = "pending" | "approved" | "rejected";

export interface DictionaryAlias {
  lang: DictionaryLanguage;
  text: string;
  type: AliasType;
  exact: boolean;
  reviewStatus: ReviewStatus;
  sourceId?: string;
  confidence?: number;
}

export interface DictionaryConcept {
  conceptId: string;
  senseKey: string;
  category: string;
  partOfSpeech?: Partial<Record<DictionaryLanguage, string>>;
  definitions: Partial<Record<DictionaryLanguage, string>>;
  labels: Partial<Record<DictionaryLanguage, string>>;
  isAnswerable: boolean;
  isGuessable: boolean;
  status: ConceptStatus;
  aliases: DictionaryAlias[];
  /** Reviewed local guess candidates associated with a Chinese answer surface. */
  relatedTo?: string[];
  relationLevel?: "near" | "medium" | "wide";
}

export interface DictionarySnapshot {
  schemaVersion: 1;
  wordlistId: string;
  release: string;
  defaultLanguage: DictionaryLanguage;
  languages: DictionaryLanguage[];
  concepts: DictionaryConcept[];
  sourceManifest?: Array<{ sourceId: string; license: string; url?: string; retrievedAt?: string }>;
}

export type ResolveResult =
  | { status: "resolved"; conceptId: string; concept: DictionaryConcept; language: DictionaryLanguage; normalizedKey: string }
  | { status: "ambiguous"; candidates: string[]; language: DictionaryLanguage; normalizedKey: string }
  | { status: "unknown"; language: DictionaryLanguage; normalizedKey: string };
