export interface EmbeddingClientOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxCacheEntries?: number;
  retryDelayMs?: number;
}

export interface EmbeddingStatus {
  mode: "pending" | "embedding" | "unavailable";
  baseUrl: string;
  model: string;
  dimensions?: number;
  lastError?: string;
  cacheEntries: number;
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
  private retryAt = 0;
  private validationVersion = 0;
  private readonly maxCacheEntries: number;
  private readonly retryDelayMs: number;

  constructor(options: EmbeddingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.EMBEDDING_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "");
    this.model = options.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-qwen3-embedding-0.6b";
    this.apiKey = options.apiKey ?? process.env.EMBEDDING_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.EMBEDDING_TIMEOUT_MS ?? 8000);
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 2048);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 5000);
  }

  status(): EmbeddingStatus {
    return { mode: this.lastError ? "unavailable" : this.dimensions ? "embedding" : "pending", baseUrl: this.baseUrl, model: this.model, dimensions: this.dimensions, lastError: this.lastError, cacheEntries: this.cache.size };
  }

  async embed(input: string): Promise<number[]> {
    const normalized = input.trim().toLowerCase();
    const cached = this.cache.get(normalized);
    if (cached) { this.cache.delete(normalized); this.cache.set(normalized, cached); return cached; }
    // This protects an unavailable MODEL, not a viewer cooldown. All guesses
    // continue through the local scoring fallback instead of each waiting 8s.
    if (Date.now() < this.retryAt) throw new Error(this.lastError ?? "向量服务暂不可用，正在使用本地关联度计算。");
    const request = this.request(normalized);
    this.cache.set(normalized, request);
    while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
    try {
      return await request;
    } catch (error) {
      if (this.cache.get(normalized) === request) this.cache.delete(normalized);
      throw error;
    }
  }

  private async request(input: string): Promise<number[]> {
    const version=this.validationVersion;
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
      if (!response.ok) throw new Error(`向量服务请求失败（HTTP ${response.status}），已使用本地关联度计算。`);
      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > 65536 || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("向量服务未返回有效的数值向量，已使用本地关联度计算。");
      if (!embedding.some(value=>value!==0)) throw new Error("向量服务返回了零向量，已使用本地关联度计算。");
      if (this.dimensions!==undefined && this.dimensions!==embedding.length) throw new Error("向量服务返回的维度发生变化，已清理旧缓存并使用本地关联度计算。");
      if(version!==this.validationVersion)throw new Error("向量服务本批请求失效，已使用本地关联度计算。");
      this.dimensions = embedding.length;
      this.lastError = undefined;
      this.retryAt = 0;
      return embedding as number[];
    } catch (error) {
      if(version===this.validationVersion) {
        this.validationVersion++;
        this.cache.clear();this.dimensions=undefined;
        this.lastError = error instanceof Error && error.message.startsWith("向量服务") ? error.message : "向量服务连接失败或超时，已使用本地关联度计算。";
        this.retryAt = Date.now() + this.retryDelayMs;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
