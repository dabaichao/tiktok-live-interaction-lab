export interface HintWordClientOptions {
  baseUrl?: string;
  model?: string;
  routingMode?: "preferred-fallback" | "fixed";
  preferredModel?: string;
  fallbackModels?: string[];
  fixedModel?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface HintContext {
  label: string;
  value: string;
}

export interface HintWordStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  routingMode: "preferred-fallback" | "fixed";
  models: string[];
  lastModelUsed?: string;
  timeoutMs: number;
  lastError?: string;
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  error?: { message?: string };
};

/**
 * Generates bonus candidate words through an OpenAI-compatible chat endpoint.
 * This client is deliberately fail-soft: an unavailable model must never stop
 * TikTok events or the local word-game fallback from being processed.
 */
export class HintWordClient {
  private readonly baseUrl: string;
  private readonly routingMode: "preferred-fallback" | "fixed";
  private readonly preferredModel: string;
  private readonly fallbackModels: string[];
  private readonly fixedModel: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private lastError?: string;
  private lastModelUsed?: string;

  constructor(options: HintWordClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.HINT_LLM_BASE_URL ?? "https://www.ai68.asia/v1").replace(/\/$/, "");
    const legacySingleModel = options.model !== undefined && options.routingMode === undefined && options.preferredModel === undefined && options.fallbackModels === undefined && options.fixedModel === undefined;
    this.routingMode = options.routingMode ?? (legacySingleModel ? "fixed" : "preferred-fallback");
    this.preferredModel = options.preferredModel ?? options.model ?? process.env.HINT_LLM_MODEL ?? "hy3";
    this.fallbackModels = uniqueModels(options.fallbackModels ?? (legacySingleModel ? [] : (process.env.HINT_LLM_FALLBACK_MODELS ?? "minimax-m3,deepseek-v4-flash").split(",")));
    this.fixedModel = options.fixedModel ?? process.env.HINT_LLM_FIXED_MODEL ?? this.preferredModel;
    this.apiKey = options.apiKey ?? process.env.HINT_LLM_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.HINT_LLM_TIMEOUT_MS ?? 45_000);
  }

  status(): HintWordStatus {
    return {
      configured: Boolean(this.apiKey),
      baseUrl: this.baseUrl,
      model: this.models()[0],
      routingMode: this.routingMode,
      models: this.models(),
      lastModelUsed: this.lastModelUsed,
      timeoutMs: this.timeoutMs,
      lastError: this.lastError,
    };
  }

  async generateWords(input: { count: number; hints: HintContext[]; phase?: string; language?: string; excludeWords?: string[] }): Promise<string[]> {
    if (!this.apiKey) return [];
    const count = Math.max(1, Math.min(2000, Math.floor(input.count)));
    const language = input.language ?? "en";
    const excluded = new Set((input.excludeWords ?? []).map((word) => this.normalizeWord(word)).filter(Boolean));
    let lastError = "Hint LLM returned no valid words";
    const output: string[] = [];
    const excludedForRequest = new Set(excluded);
    for (const model of this.models()) {
      const remaining = count - output.length;
      if (remaining <= 0) break;
      const words = await this.requestWords(model, { ...input, count: remaining }, excludedForRequest, (error) => { lastError = error; });
      for (const word of words) {
        if (output.includes(word)) continue;
        output.push(word);
        excludedForRequest.add(word);
        if (output.length >= count) break;
      }
    }
    if (output.length > 0) {
      this.lastError = undefined;
      return output.slice(0, count);
    }
    this.lastError = lastError;
    return [];
  }

  private async requestWords(model: string, input: { count: number; hints: HintContext[]; phase?: string; language?: string; excludeWords?: string[] }, excluded: Set<string>, onError: (message: string) => void): Promise<string[]> {
    const count = input.count;
    const language = input.language ?? "en";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: Math.min(8_000, Math.max(1_200, count * 16)),
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `You generate candidate ${language} words for a live semantic guessing game. You do not know the hidden answer and must never reveal or directly infer it. Return only valid JSON. The exact accepted schema is {"schemaVersion":1,"items":[{"word":"..."}]}. Each word must be a useful ${language} word or short phrase, never an explanation, hint label, answer, or numbered list.`,
              },
              {
                role: "user",
                content: JSON.stringify({
                  task: "Generate bonus candidate words for the live game.",
                  count,
                  language,
                  phase: input.phase ?? "unknown",
                  unlockedHints: input.hints,
                  excludeWords: [...excluded],
                  output: { schemaVersion: 1, items: [{ word: "example" }] },
                  ...(attempt > 0 ? { retryInstruction: "Return one compact JSON object only. Do not use Markdown fences or explanatory text." } : {}),
                }),
              },
            ],
          }),
          signal: controller.signal,
        });
        const body = await response.json() as ChatResponse;
        if (!response.ok) throw new Error(body.error?.message ?? `Hint LLM HTTP ${response.status}`);
        const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text;
        const words = this.parseWords(content, excluded);
        if (words.length === 0) throw new Error("Hint LLM returned no valid words");
        this.lastModelUsed = model;
        return words.slice(0, count);
      } catch (error) {
        onError(error instanceof Error ? `${model}: ${error.message}` : `${model}: ${String(error)}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    return [];
  }

  private models(): string[] {
    return this.routingMode === "fixed" ? uniqueModels([this.fixedModel]) : uniqueModels([this.preferredModel, ...this.fallbackModels]);
  }

  private parseWords(content: unknown, excluded = new Set<string>()): string[] {
    const text = this.contentToText(content);
    if (!text) return [];
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = this.parseJson(cleaned);
    if (!parsed) return [];
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : undefined;
    const rawItems = Array.isArray(record.items) ? record.items
      : Array.isArray(record.words) ? record.words
        : Array.isArray(record.candidates) ? record.candidates
          : data && Array.isArray(data.items) ? data.items
            : [];
    const words: string[] = [];
    for (const item of rawItems) {
      const itemRecord = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      const rawWord: string | undefined = typeof item === "string" ? item : typeof itemRecord?.word === "string" ? itemRecord.word
        : typeof itemRecord?.text === "string" ? itemRecord.text
          : typeof itemRecord?.phrase === "string" ? itemRecord.phrase
            : undefined;
      if (!rawWord) continue;
      const word = this.normalizeWord(rawWord);
      if (word.length === 0 || word.length > 160 || !/[\p{L}]/u.test(word) || excluded.has(word) || words.includes(word)) continue;
      words.push(word);
    }
    return words;
  }

  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") return String((part as Record<string, unknown>).text);
        return "";
      }).join("");
    }
    if (content && typeof content === "object") return JSON.stringify(content);
    return "";
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return undefined;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
  }

  private normalizeWord(word: string): string {
    return word.trim().toLowerCase().replace(/\s+/g, " ");
  }
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}
