import type { DictionaryConcept, DictionaryLanguage, ReviewStatus } from "./types.js";

export interface GapFillConceptInput {
  conceptId: string;
  category: string;
  canonicalEn: string;
  existingLabels: Partial<Record<DictionaryLanguage, string>>;
}

export interface DictionaryProposal {
  conceptId: string;
  lang: DictionaryLanguage;
  text: string;
  type: "translated" | "synonym" | "variant";
  exact: boolean;
  reviewStatus: ReviewStatus;
  sourceId: "llm";
  model: string;
}

export interface DictionaryGapFillClientOptions {
  baseUrl?: string;
  model?: string;
  routingMode?: "preferred-fallback" | "fixed";
  preferredModel?: string;
  fallbackModels?: string[];
  fixedModel?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxBatchSize?: number;
}

export interface DictionaryGapFillStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  routingMode: "preferred-fallback" | "fixed";
  models: string[];
  lastModelUsed?: string;
  timeoutMs: number;
  maxBatchSize: number;
  lastError?: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  error?: { message?: string };
}

const ALLOWED_LANGUAGES = new Set(["en", "vi", "zh-Hans"]);

/**
 * Offline-only dictionary proposal client. It never mutates the published
 * snapshot: callers must write proposals to a review file and approve them
 * explicitly before rebuilding the dictionary.
 */
export class DictionaryGapFillClient {
  private readonly baseUrl: string;
  private readonly routingMode: "preferred-fallback" | "fixed";
  private readonly preferredModel: string;
  private readonly fallbackModels: string[];
  private readonly fixedModel: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxBatchSize: number;
  private lastError?: string;
  private lastModelUsed?: string;

  constructor(options: DictionaryGapFillClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.HINT_LLM_BASE_URL ?? "https://www.ai68.asia/v1").replace(/\/$/, "");
    const legacySingleModel = options.model !== undefined && options.routingMode === undefined && options.preferredModel === undefined && options.fallbackModels === undefined && options.fixedModel === undefined;
    this.routingMode = options.routingMode ?? (legacySingleModel ? "fixed" : "preferred-fallback");
    this.preferredModel = options.preferredModel ?? options.model ?? process.env.HINT_LLM_MODEL ?? "hy3";
    this.fallbackModels = uniqueModels(options.fallbackModels ?? (legacySingleModel ? [] : (process.env.HINT_LLM_FALLBACK_MODELS ?? "minimax-m3,deepseek-v4-flash").split(",")));
    this.fixedModel = options.fixedModel ?? process.env.HINT_LLM_FIXED_MODEL ?? this.preferredModel;
    this.apiKey = options.apiKey ?? process.env.HINT_LLM_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.HINT_LLM_TIMEOUT_MS ?? 45_000);
    this.maxBatchSize = Math.max(1, Math.min(100, Math.floor(options.maxBatchSize ?? Number(process.env.DICTIONARY_GAP_FILL_BATCH_SIZE ?? 100))));
  }

  status(): DictionaryGapFillStatus {
    return { configured: Boolean(this.apiKey), baseUrl: this.baseUrl, model: this.models()[0], routingMode: this.routingMode, models: this.models(), lastModelUsed: this.lastModelUsed, timeoutMs: this.timeoutMs, maxBatchSize: this.maxBatchSize, lastError: this.lastError };
  }

  async propose(input: { language: DictionaryLanguage; concepts: GapFillConceptInput[] }): Promise<DictionaryProposal[]> {
    if (!ALLOWED_LANGUAGES.has(input.language)) throw new Error(`Unsupported dictionary language: ${input.language}`);
    if (!this.apiKey || input.concepts.length === 0) return [];
    const proposals: DictionaryProposal[] = [];
    for (let index = 0; index < input.concepts.length; index += this.maxBatchSize) {
      const batch = input.concepts.slice(index, index + this.maxBatchSize);
      let batchProposals: DictionaryProposal[] = [];
      for (const model of this.models()) {
        batchProposals = await this.proposeBatch(input.language, batch, model);
        if (batchProposals.length > 0) break;
      }
      proposals.push(...batchProposals);
    }
    return proposals;
  }

  private async proposeBatch(language: DictionaryLanguage, concepts: GapFillConceptInput[], model: string): Promise<DictionaryProposal[]> {
    const allowedConceptIds = new Set(concepts.map((concept) => concept.conceptId));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: Math.min(16_000, Math.max(2_000, concepts.length * 32)),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "You are an offline lexicon proposal generator. Return only compact JSON. Do not publish anything, do not invent concept IDs, and do not explain your answer. For each supplied concept, propose one common local-language label and at most three common aliases. Use the exact schema {\"schemaVersion\":1,\"language\":\"...\",\"items\":[{\"conceptId\":\"...\",\"label\":\"...\",\"aliases\":[\"...\"]}]}.",
            },
            {
              role: "user",
              content: JSON.stringify({
                task: "Fill missing labels for a reviewed multilingual live word-game dictionary.",
                language,
                rules: ["Use common contemporary live-chat wording.", "Do not include explanations, sensitive terms, brands, names, or multiple unrelated senses.", "All generated items remain pending human review."],
                concepts,
              }),
            },
          ],
        }),
        signal: controller.signal,
      });
      const body = await response.json() as ChatResponse;
      if (!response.ok) throw new Error(body.error?.message ?? `Dictionary gap-fill HTTP ${response.status}`);
      const proposals = this.parse(body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text, language, allowedConceptIds);
      if (proposals.length === 0) throw new Error("Dictionary gap-fill returned no valid proposals");
      this.lastError = undefined;
      this.lastModelUsed = model;
      return proposals;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  parse(content: unknown, language: DictionaryLanguage, allowedConceptIds: Set<string>): DictionaryProposal[] {
    const text = contentToText(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (!text) return [];
    const parsed = parseJson(text);
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const seen = new Set<string>();
    const output: DictionaryProposal[] = [];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      const conceptId = typeof item.conceptId === "string" ? item.conceptId.trim() : "";
      const label = normalizeText(typeof item.label === "string" ? item.label : "");
      if (!allowedConceptIds.has(conceptId) || !label || !isSafeSurface(label)) continue;
      this.addProposal(output, seen, conceptId, language, label, "translated", this.lastModelUsed ?? this.models()[0]);
      const aliases = Array.isArray(item.aliases) ? item.aliases : [];
      for (const rawAlias of aliases.slice(0, 3)) {
        const alias = normalizeText(typeof rawAlias === "string" ? rawAlias : "");
        if (alias && isSafeSurface(alias)) this.addProposal(output, seen, conceptId, language, alias, "synonym", this.lastModelUsed ?? this.models()[0]);
      }
    }
    return output;
  }

  private addProposal(output: DictionaryProposal[], seen: Set<string>, conceptId: string, lang: DictionaryLanguage, text: string, type: DictionaryProposal["type"], model: string): void {
    const key = `${conceptId}:${lang}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push({ conceptId, lang, text, type, exact: type !== "synonym", reviewStatus: "pending", sourceId: "llm", model });
  }

  private models(): string[] {
    return this.routingMode === "fixed" ? uniqueModels([this.fixedModel]) : uniqueModels([this.preferredModel, ...this.fallbackModels]);
  }
}

export function missingLabelsForLanguage(concepts: DictionaryConcept[], language: DictionaryLanguage): GapFillConceptInput[] {
  return concepts.filter((concept) => concept.status === "approved" && !concept.labels[language]).map((concept) => ({
    conceptId: concept.conceptId,
    category: concept.category,
    canonicalEn: concept.labels.en ?? concept.conceptId,
    existingLabels: concept.labels,
  }));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : typeof part === "string" ? part : "").join("");
  return content && typeof content === "object" ? JSON.stringify(content) : "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  }
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function isSafeSurface(text: string): boolean {
  return text.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(text) && /[\p{L}]/u.test(text);
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}
