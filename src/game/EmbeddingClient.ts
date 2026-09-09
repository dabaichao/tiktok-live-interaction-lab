export interface EmbeddingClientOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface EmbeddingStatus {
  mode: "embedding" | "unavailable";
  baseUrl: string;
  model: string;
  dimensions?: number;
  lastError?: string;
}

type EmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: unknown }>;
};

export class EmbeddingClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, Promise<number[]>>();
  private dimensions?: number;
  private lastError?: string;

  constructor(options: EmbeddingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.EMBEDDING_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "");
    this.model = options.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-qwen3-embedding-0.6b";
    this.apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.EMBEDDING_TIMEOUT_MS ?? 8000);
  }

  status(): EmbeddingStatus {
    return { mode: this.lastError ? "unavailable" : "embedding", baseUrl: this.baseUrl, model: this.model, dimensions: this.dimensions, lastError: this.lastError };
  }

  async embed(input: string): Promise<number[]> {
    const normalized = input.trim().toLowerCase();
    const cached = this.cache.get(normalized);
    if (cached) return cached;
    const request = this.request(normalized);
    this.cache.set(normalized, request);
    try {
      return await request;
    } catch (error) {
      this.cache.delete(normalized);
      throw error;
    }
  }

  private async request(input: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: [input] }),
        signal: controller.signal,
      });
      const body = await response.json() as EmbeddingResponse & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? `Embedding HTTP ${response.status}`);
      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Embedding response did not contain a numeric vector");
      this.dimensions = embedding.length;
      this.lastError = undefined;
      return embedding as number[];
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
