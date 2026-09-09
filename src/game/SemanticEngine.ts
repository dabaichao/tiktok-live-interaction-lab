import { ConceptDictionary } from "../dictionary/ConceptDictionary.js";
import type { DictionaryLanguage, ResolveResult } from "../dictionary/types.js";
import { EmbeddingClient, type EmbeddingClientOptions, type EmbeddingStatus } from "./EmbeddingClient.js";

export type SemanticBucket = "correct" | "hot" | "warm" | "cold";
export type SimilarityMode = "exact" | "embedding" | "heuristic";

export interface SemanticEvaluation {
  normalizedGuess: string;
  rawCosine: number;
  displayScore: number;
  rank: number;
  bucket: SemanticBucket;
  isCorrect: boolean;
  similarityMode: SimilarityMode;
}

export interface GuessValidation {
  ok: boolean;
  normalizedGuess: string;
  reason?: "empty" | "not_word";
}

export interface SemanticEngineOptions extends EmbeddingClientOptions {
  dictionary?: ConceptDictionary;
  language?: DictionaryLanguage;
}

const CATEGORY_THEMES: Record<string, string> = {
  nature: "自然与环境",
  people: "人物与关系",
  travel: "交通与旅行",
  emotion: "情绪与状态",
  time: "时间与季节",
  culture: "文化与娱乐",
  work: "工作与成长",
  food: "食物与味觉",
  technology: "科技与互联网",
  sports: "运动与竞技",
  household_items: "日用品",
};

export class SemanticEngine {
  readonly dictionary: ConceptDictionary;
  readonly language: DictionaryLanguage;
  private readonly embedding: EmbeddingClient;

  constructor(options: SemanticEngineOptions = {}) {
    this.dictionary = options.dictionary ?? ConceptDictionary.default();
    this.language = options.language ?? process.env.SEMANTIC_LANGUAGE ?? this.dictionary.snapshot.defaultLanguage;
    this.embedding = new EmbeddingClient(options);
  }

  get answerPool(): string[] {
    return this.dictionary.answerWords(this.language);
  }

  embeddingStatus(): EmbeddingStatus {
    return this.embedding.status();
  }

  dictionaryStatus(): ReturnType<ConceptDictionary["stats"]> & { language: DictionaryLanguage } {
    return { ...this.dictionary.stats(), language: this.language };
  }

  resolve(input: string): ResolveResult {
    return this.dictionary.resolve(input, this.language);
  }

  randomCandidate(exclude?: string): string {
    const normalizedExclude = exclude ? this.normalize(exclude) : undefined;
    const candidates = this.dictionary.guessWords(this.language).filter((word) => this.normalize(word) !== normalizedExclude);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? this.answerPool[0] ?? "word";
  }

  themeFor(answer: string): string {
    const category = this.dictionary.categoryFor(answer, this.language);
    return CATEGORY_THEMES[category ?? ""] ?? "日常高频词";
  }

  normalize(input: string): string {
    return this.dictionary.normalizeSurface(input);
  }

  validate(input: string): GuessValidation {
    const normalizedGuess = this.normalize(input);
    if (!normalizedGuess) return { ok: false, normalizedGuess, reason: "empty" };
    // Unknown live-chat terms remain accepted in the current open-input mode.
    // The resolver is available for strict published modes and gap review.
    if (normalizedGuess.length > 160 || !/[\p{L}]/u.test(normalizedGuess)) return { ok: false, normalizedGuess, reason: "not_word" };
    return { ok: true, normalizedGuess };
  }

  evaluate(answer: string, guess: string): SemanticEvaluation {
    const normalizedAnswer = this.normalize(answer);
    const normalizedGuess = this.normalize(guess);
    if (this.isSameConcept(normalizedAnswer, normalizedGuess)) return this.correctResult(normalizedGuess);
    return this.fromCosine(normalizedAnswer, normalizedGuess, this.heuristicCosine(normalizedAnswer, normalizedGuess), "heuristic");
  }

  async evaluateWithEmbedding(answer: string, guess: string): Promise<SemanticEvaluation> {
    const normalizedAnswer = this.normalize(answer);
    const normalizedGuess = this.normalize(guess);
    if (this.isSameConcept(normalizedAnswer, normalizedGuess)) return this.correctResult(normalizedGuess);
    try {
      const [answerVector, guessVector] = await Promise.all([this.embedding.embed(normalizedAnswer), this.embedding.embed(normalizedGuess)]);
      return this.fromCosine(normalizedAnswer, normalizedGuess, cosine(answerVector, guessVector), "embedding");
    } catch {
      return this.evaluate(normalizedAnswer, normalizedGuess);
    }
  }

  private isSameConcept(answer: string, guess: string): boolean {
    const answerResult = this.resolve(answer);
    const guessResult = this.resolve(guess);
    return answerResult.status === "resolved" && guessResult.status === "resolved" && answerResult.conceptId === guessResult.conceptId;
  }

  private correctResult(normalizedGuess: string): SemanticEvaluation {
    return { normalizedGuess, rawCosine: 1, displayScore: 100, rank: 1, bucket: "correct", isCorrect: true, similarityMode: "exact" };
  }

  private fromCosine(_answer: string, normalizedGuess: string, cosineValue: number, similarityMode: SimilarityMode): SemanticEvaluation {
    const rawCosine = Math.max(-1, Math.min(1, cosineValue));
    const displayScore = Math.max(0, Math.min(99.9, Math.round(Math.max(0, rawCosine) * 1000) / 10));
    const rank = Math.max(1, Math.min(5000, Math.round(1 + Math.pow(100 - displayScore, 1.35) * 2.2)));
    const bucket: SemanticBucket = rank <= 100 ? "hot" : rank <= 1000 ? "warm" : "cold";
    return { normalizedGuess, rawCosine, displayScore, rank, bucket, isCorrect: false, similarityMode };
  }

  private heuristicCosine(answer: string, normalizedGuess: string): number {
    const groupScore = this.groupSimilarity(answer, normalizedGuess);
    const lexicalScore = this.lexicalSimilarity(answer, normalizedGuess);
    return Math.max(0, Math.min(0.999, groupScore * 0.82 + lexicalScore * 0.18));
  }

  private groupSimilarity(answer: string, guess: string): number {
    const answerResult = this.resolve(answer);
    const guessResult = this.resolve(guess);
    if (answerResult.status === "resolved" && guessResult.status === "resolved" && answerResult.concept.category === guessResult.concept.category) return 0.86;
    return 0.12;
  }

  private lexicalSimilarity(answer: string, guess: string): number {
    const answerChars = new Set(answer);
    const guessChars = new Set(guess);
    const intersection = [...guessChars].filter((char) => answerChars.has(char)).length;
    const union = new Set([...answerChars, ...guessChars]).size;
    const prefix = [...answer].findIndex((char, index) => guess[index] !== char);
    const prefixRatio = prefix < 0 ? 1 : prefix / Math.max(answer.length, guess.length);
    return Math.max(0, Math.min(1, (intersection / Math.max(1, union)) * 0.72 + prefixRatio * 0.28));
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions do not match");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) throw new Error("Embedding vector has zero magnitude");
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

