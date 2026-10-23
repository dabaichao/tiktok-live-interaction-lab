import { ConceptDictionary } from "../dictionary/ConceptDictionary.js";
import type { DictionaryLanguage, ResolveResult } from "../dictionary/types.js";
import { EmbeddingClient, type EmbeddingClientOptions, type EmbeddingStatus } from "./EmbeddingClient.js";
import { roundGuessRejection } from "./GuessRules.js";

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
  reason?: "empty" | "not_word" | "length_mismatch";
}

export interface SemanticEngineOptions extends EmbeddingClientOptions {
  dictionary?: ConceptDictionary;
  language?: DictionaryLanguage;
  /** Use reviewed, specific Chinese question definitions; never copy them onto guesses. */
  useReviewedDefinitions?: boolean;
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

const CATEGORY_HINTS_ZH: Record<string, string> = {
  nature: "自然界或生物的一种",
  people: "人物或关系的一种",
  travel: "出行或交通的一种",
  emotion: "一种情绪或状态",
  time: "时间或季节的一种",
  culture: "文化或娱乐的一种",
  work: "工作或成长相关的一种",
  food: "食物或味觉相关的一种",
  technology: "科技或互联网相关的一种",
  sports: "运动或竞技相关的一种",
  household_items: "日常用品的一种",
};

const GENERIC_DEFINITIONS_ZH = new Set([
  ...Object.values(CATEGORY_HINTS_ZH),
  "生活中常见的一种事物", "生活中常见的一种食物", "日常生活中常用的物品",
  "与自然世界有关的事物", "与人或人群有关的事物", "与出行有关的事物",
  "与科技有关的事物", "与运动有关的事物", "与日常文化有关的事物", "与工作有关的人或事",
  "描述一种味觉感受", "日常生活中的一类食材", "与劳动或制作有关的活动", "与知识或技能有关的活动",
  "生活中常见的一种饮品",
]);

export class SemanticEngine {
  readonly dictionary: ConceptDictionary;
  readonly language: DictionaryLanguage;
  private readonly embedding: EmbeddingClient;
  private readonly useReviewedDefinitions: boolean;

  constructor(options: SemanticEngineOptions = {}) {
    this.dictionary = options.dictionary ?? ConceptDictionary.default();
    this.language = options.language ?? process.env.SEMANTIC_LANGUAGE ?? this.dictionary.snapshot.defaultLanguage;
    this.embedding = new EmbeddingClient(options);
    this.useReviewedDefinitions = options.useReviewedDefinitions === true && this.language === "zh-Hans";
  }

  get answerPool(): string[] {
    return this.dictionary.answerWords(this.language).filter(word => this.validate(word).ok && (this.language !== "zh-Hans" || /^\p{Script=Han}+$/u.test(word)) && this.resolve(word).status === "resolved");
  }

  embeddingStatus(): EmbeddingStatus & { answerContextMode: "surface" | "reviewed-when-specific" } {
    return { ...this.embedding.status(), answerContextMode: this.useReviewedDefinitions ? "reviewed-when-specific" : "surface" };
  }

  embeddingInputFor(answer: string): string {
    const surface = this.normalize(answer);
    if (!this.useReviewedDefinitions) return surface;
    const result = this.resolve(surface);
    if (result.status !== "resolved" || result.concept.status !== "approved" || !result.concept.isAnswerable) return surface;
    const definition = result.concept.definitions[this.language]?.normalize("NFKC").trim().replace(/[。.!！]+$/u, "");
    // Category templates are clues, not reviewed senses. Real-model checks show
    // that adding these can make unrelated weather closer than a profession.
    if (!definition || [...definition].length > 120 || GENERIC_DEFINITIONS_ZH.has(definition) ||
        /^与.{1,24}有关的(?:事物|人或事)$/u.test(definition)) return surface;
    return `${surface}。${definition}`;
  }

  dictionaryStatus(): ReturnType<ConceptDictionary["stats"]> & { language: DictionaryLanguage } {
    return { ...this.dictionary.stats(), language: this.language };
  }

  resolve(input: string): ResolveResult {
    return this.dictionary.resolve(input, this.language);
  }

  randomCandidate(exclude?: string, expectedLength?: number): string {
    const normalizedExclude = exclude ? this.normalize(exclude) : undefined;
    const valid = (word: string) => this.normalize(word) !== normalizedExclude && this.validate(word, expectedLength).ok;
    const globalCandidates = this.dictionary.guessWords(this.language).filter(valid);
    const relatedCandidates = exclude ? this.dictionary.relatedGuessWords(exclude, this.language).filter(valid) : [];
    // Favor reviewed question-linked words while retaining a broad fallback for busy rooms.
    const candidates = relatedCandidates.length > 0 && Math.random() < 0.6 ? relatedCandidates : globalCandidates;
    return candidates[Math.floor(Math.random() * candidates.length)] ?? "";
  }

  themeFor(answer: string): string {
    const category = this.dictionary.categoryFor(answer, this.language);
    return CATEGORY_THEMES[category ?? ""] ?? "日常高频词";
  }

  hintFor(answer: string): string {
    const result = this.resolve(answer);
    if (result.status === "resolved") {
      const definition = result.concept.definitions[this.language] ?? result.concept.definitions["zh-Hans"];
      if (definition) return definition;
      if (this.language === "zh-Hans") return CATEGORY_HINTS_ZH[result.concept.category] ?? "生活中常见的一种事物";
      return CATEGORY_THEMES[result.concept.category] ?? "常见词汇的一种";
    }
    return this.language === "zh-Hans" ? "生活中常见的一种事物" : "常见词汇的一种";
  }

  normalize(input: string): string {
    return this.dictionary.normalizeSurface(input);
  }

  validate(input: string, expectedLength?: number): GuessValidation {
    const normalizedGuess = this.normalize(input);
    if (!normalizedGuess) return { ok: false, normalizedGuess, reason: "empty" };
    // Vocabulary membership is separate from the round's required character count.
    if (normalizedGuess.length > 160 || !/[\p{L}]/u.test(normalizedGuess)) return { ok: false, normalizedGuess, reason: "not_word" };
    if (expectedLength !== undefined) {
      const reason = roundGuessRejection(normalizedGuess, expectedLength, this.language);
      if (reason) return { ok: false, normalizedGuess, reason };
    }
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
      const [answerVector, guessVector] = await Promise.all([this.embedding.embed(this.embeddingInputFor(normalizedAnswer)), this.embedding.embed(normalizedGuess)]);
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
    if(!Number.isFinite(cosineValue))throw new Error("Invalid cosine result");
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
  // Scale each vector independently to avoid overflow/underflow in products.
  const scaleA=a.reduce((max,value)=>Math.max(max,Math.abs(value)),0);
  const scaleB=b.reduce((max,value)=>Math.max(max,Math.abs(value)),0);
  if(!scaleA||!scaleB)throw new Error("Embedding vector has zero magnitude");
  for (let index = 0; index < a.length; index += 1) {
    const x=a[index]/scaleA,y=b[index]/scaleB;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) throw new Error("Embedding vector has zero magnitude");
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
