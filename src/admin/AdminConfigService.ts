import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";

const languageSchema = z.enum(["en", "vi", "zh-Hans"]);

export const adminConfigSchema = z.object({
  tiktok: z.object({
    username: z.string().max(100),
    autoReconnect: z.boolean(),
    extendedGiftInfo: z.boolean(),
  }),
  game: z.object({
    language: languageSchema,
    answer: z.string().max(160),
    dictionaryPackageId: z.string().min(1).max(160),
    roundDurationMs: z.number().int().min(30_000).max(3_600_000),
    settlementDurationMs: z.number().int().min(100).max(120_000),
    tickIntervalMs: z.number().int().min(100).max(10_000),
    likesPerHint: z.number().int().min(1).max(1_000_000),
    giftWordsMultiplier: z.number().int().min(1).max(100),
    giftExtraTimeMs: z.number().int().min(0).max(3_600_000),
    allowUnknownInputs: z.boolean(),
    allowLocalGiftFallback: z.boolean(),
  }),
  embedding: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(500).max(120_000),
  }),
  llm: z.object({
    baseUrl: z.string().url(),
    routingMode: z.enum(["preferred-fallback", "fixed"]),
    preferredModel: z.string().min(1).max(200),
    fallbackModels: z.array(z.string().min(1).max(200)).max(20),
    fixedModel: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(1_000).max(180_000),
    batchSize: z.number().int().min(1).max(100),
  }),
  observability: z.object({
    debug: z.boolean(),
    storeRawEvents: z.boolean(),
    eventBufferLimit: z.number().int().min(100).max(10_000),
  }),
});

export type AdminConfig = z.infer<typeof adminConfigSchema>;
export type AdminConfigPatch = z.input<typeof adminConfigSchema>;

export interface AdminConfigView {
  config: AdminConfig;
  secrets: {
    embeddingApiKeyConfigured: boolean;
    hintLlmApiKeyConfigured: boolean;
  };
  persistence: {
    path: string;
    source: "file" | "environment";
  };
  effects: {
    requiresRestart: boolean;
    requiresReconnect: boolean;
  };
}

export class AdminConfigService {
  private config: AdminConfig;
  private source: "file" | "environment" = "environment";
  private lastEffects = { requiresRestart: false, requiresReconnect: false };
  private updates: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string, initialConfig?: AdminConfig) {
    this.config = initialConfig ? structuredClone(initialConfig) : defaultsFromEnvironment();
  }

  async load(): Promise<void> {
    const path = this.filePath();
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      this.config = adminConfigSchema.parse(migrateLegacyConfig(deepMerge(this.config, parsed), parsed));
      this.source = "file";
    } catch {
      this.config = adminConfigSchema.parse(this.config);
    }
  }

  loadSync(): void {
    const path = this.filePath();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      this.config = adminConfigSchema.parse(migrateLegacyConfig(deepMerge(this.config, parsed), parsed));
      this.source = "file";
    } catch {
      this.config = adminConfigSchema.parse(this.config);
    }
  }

  get current(): AdminConfig {
    return structuredClone(this.config);
  }

  /** Apply settings already durably stored by an independent operator service. */
  applyPersistedConfig(config: AdminConfig): void {
    this.config = adminConfigSchema.parse(config);
  }

  view(): AdminConfigView {
    return {
      config: this.current,
      secrets: {
        embeddingApiKeyConfigured: Boolean(process.env.EMBEDDING_API_KEY),
        hintLlmApiKeyConfigured: Boolean(process.env.HINT_LLM_API_KEY),
      },
      persistence: { path: this.filePath(), source: this.source },
      effects: { ...this.lastEffects },
    };
  }

  async update(patch: unknown): Promise<AdminConfigView> {
    const job = this.updates.catch(() => undefined).then(() => this.commitUpdate(patch));
    this.updates = job.catch(() => undefined);
    return job;
  }

  private async commitUpdate(patch: unknown): Promise<AdminConfigView> {
    const previous = this.config;
    const candidate = adminConfigSchema.parse(deepMerge(previous, patch));
    await mkdir(dirname(this.filePath()), { recursive: true });
    const temp = `${this.filePath()}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(candidate, null, 2), "utf8"); await rename(temp, this.filePath()); }
    finally { await unlink(temp).catch(() => undefined); }
    this.config = candidate;
    this.lastEffects = {
      requiresRestart: previous.game.language !== this.config.game.language || previous.game.dictionaryPackageId !== this.config.game.dictionaryPackageId || previous.game.tickIntervalMs !== this.config.game.tickIntervalMs || previous.embedding.baseUrl !== this.config.embedding.baseUrl || previous.embedding.model !== this.config.embedding.model || previous.llm.baseUrl !== this.config.llm.baseUrl || previous.llm.routingMode !== this.config.llm.routingMode || previous.llm.preferredModel !== this.config.llm.preferredModel || previous.llm.fixedModel !== this.config.llm.fixedModel || previous.llm.fallbackModels.join(",") !== this.config.llm.fallbackModels.join(",") || previous.observability.debug !== this.config.observability.debug || previous.observability.storeRawEvents !== this.config.observability.storeRawEvents,
      requiresReconnect: previous.tiktok.autoReconnect !== this.config.tiktok.autoReconnect || previous.tiktok.extendedGiftInfo !== this.config.tiktok.extendedGiftInfo,
    };
    this.source = "file";
    return this.view();
  }

  filePath(): string {
    return join(this.dataDir, "admin-config.json");
  }
}

function defaultsFromEnvironment(): AdminConfig {
  return {
    tiktok: {
      username: "",
      autoReconnect: true,
      extendedGiftInfo: true,
    },
    game: {
      language: parseLanguage(process.env.SEMANTIC_LANGUAGE),
      answer: process.env.SEMANTIC_ANSWER ?? "苹果",
      dictionaryPackageId: "builtin:multi_core_v1",
      roundDurationMs: numberEnv("SEMANTIC_ROUND_DURATION_MS", 240_000),
      settlementDurationMs: numberEnv("SEMANTIC_SETTLEMENT_MS", 5_000),
      tickIntervalMs: numberEnv("SEMANTIC_TICK_INTERVAL_MS", 1_000),
      likesPerHint: 1_000,
      giftWordsMultiplier: 10,
      giftExtraTimeMs: 30_000,
      allowUnknownInputs: true,
      allowLocalGiftFallback: false,
    },
    embedding: {
      baseUrl: process.env.EMBEDDING_BASE_URL ?? "http://127.0.0.1:1234/v1",
      model: process.env.EMBEDDING_MODEL ?? "text-embedding-qwen3-embedding-0.6b",
      timeoutMs: numberEnv("EMBEDDING_TIMEOUT_MS", 8_000),
    },
    llm: {
      baseUrl: process.env.HINT_LLM_BASE_URL ?? "https://www.ai68.asia/v1",
      routingMode: "preferred-fallback",
      preferredModel: process.env.HINT_LLM_MODEL ?? "hy3",
      fallbackModels: parseModels(process.env.HINT_LLM_FALLBACK_MODELS),
      fixedModel: process.env.HINT_LLM_FIXED_MODEL ?? process.env.HINT_LLM_MODEL ?? "hy3",
      timeoutMs: numberEnv("HINT_LLM_TIMEOUT_MS", 45_000),
      batchSize: numberEnv("DICTIONARY_GAP_FILL_BATCH_SIZE", 100),
    },
    observability: {
      debug: process.env.DEBUG === "true" || process.env.DEBUG === "1",
      storeRawEvents: process.env.STORE_RAW_EVENTS === "true" || process.env.STORE_RAW_EVENTS === "1",
      eventBufferLimit: 1_000,
    },
  };
}

function parseLanguage(value: string | undefined): AdminConfig["game"]["language"] {
  return value === "en" || value === "vi" ? value : "zh-Hans";
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function parseModels(value: string | undefined): string[] {
  return (value ?? "minimax-m3,deepseek-v4-flash").split(",").map((model) => model.trim()).filter(Boolean).slice(0, 20);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = merged[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) merged[key] = deepMerge(current, value);
    else merged[key] = value;
  }
  return merged as T;
}

function migrateLegacyConfig(merged: AdminConfig, persisted: unknown): AdminConfig {
  if (!persisted || typeof persisted !== "object") return merged;
  const raw = persisted as Record<string, unknown>;
  const rawLlm = raw.llm && typeof raw.llm === "object" ? raw.llm as Record<string, unknown> : undefined;
  const mergedLlm = merged.llm as AdminConfig["llm"];
  if (rawLlm && typeof rawLlm.model === "string" && !rawLlm.preferredModel) {
    mergedLlm.preferredModel = rawLlm.model;
    if (!rawLlm.fixedModel) mergedLlm.fixedModel = rawLlm.model;
  }
  return merged;
}
