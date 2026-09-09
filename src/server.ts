import "dotenv/config";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import pino from "pino";
import { AdminConfigService } from "./admin/AdminConfigService.js";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { ActionMapper, type RulesConfig } from "./actions/ActionMapper.js";
import { createApiRouter, errorHandler, ApiError, type LabController } from "./api/routes.js";
import { EventBus } from "./core/EventBus.js";
import type { NormalizedLiveEvent } from "./core/events.js";
import { Normalizer } from "./core/Normalizer.js";
import { SessionManager, type SessionMeta } from "./core/SessionManager.js";
import { Recorder } from "./recording/Recorder.js";
import { SessionReader } from "./recording/SessionReader.js";
import { ReplaySource, type ReplaySpeed } from "./sources/ReplaySource.js";
import type { SimulatorMessage } from "./sources/SimulatorSource.js";
import { SimulatorSource } from "./sources/SimulatorSource.js";
import type { SourceKind, SourceStatus } from "./sources/LiveEventSource.js";
import { TikTokSource } from "./sources/TikTokSource.js";
import { ActionGateway } from "./websocket/ActionGateway.js";
import { EventGateway } from "./websocket/EventGateway.js";
import { SemanticGameGateway } from "./game/SemanticGameGateway.js";
import { SemanticGameService } from "./game/SemanticGameService.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(projectRoot, "web");

const logger = pino({
  level: process.env.DEBUG === "true" || process.env.DEBUG === "1" ? "debug" : "info",
});

const statusDefaults: Record<SourceKind, SourceStatus> = {
  tiktok: { source: "tiktok", status: "idle" },
  replay: { source: "replay", status: "idle" },
  simulator: { source: "simulator", status: "idle" },
};

class InteractionLab implements LabController {
  private readonly eventBus = new EventBus();
  private readonly sessions = new SessionManager();
  private readonly tiktok = new TikTokSource();
  private readonly replay = new ReplaySource();
  private readonly simulator = new SimulatorSource();
  private readonly normalizer: Normalizer;
  private readonly recorder: Recorder;
  private readonly reader: SessionReader;
  private readonly mapper: ActionMapper;
  private readonly eventGateway: EventGateway;
  private readonly actionGateway: ActionGateway;
  private readonly semanticGateway: SemanticGameGateway;
  private readonly semanticGame!: SemanticGameService;
  private readonly adminConfig: AdminConfigService;
  private readonly statuses: Record<SourceKind, SourceStatus> = structuredClone(statusDefaults);
  private readonly counts: Record<string, number> = {};
  private readonly eventTimes: number[] = [];
  private latestDebug: unknown;
  private currentTikTokUsername?: string;
  private readonly dataDir: string;

  constructor() {
    this.dataDir = resolve(process.env.DATA_DIR ?? join(projectRoot, "data"));
    this.adminConfig = new AdminConfigService(this.dataDir);
    this.adminConfig.loadSync();
    const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
    this.normalizer = new Normalizer({
      debug,
      storeRawEvents: process.env.STORE_RAW_EVENTS === "true" || process.env.STORE_RAW_EVENTS === "1",
    });
    this.recorder = new Recorder({ dataDir: this.dataDir });
    this.reader = new SessionReader(this.dataDir);
    this.mapper = new ActionMapper(loadRulesSync());
    this.eventGateway = new EventGateway(logger);
    this.actionGateway = new ActionGateway(logger);
    this.semanticGateway = new SemanticGameGateway(logger, () => this.semanticGame.snapshot());
    this.semanticGame = new SemanticGameService(this.semanticGateway, this.adminConfig);

    this.bindSource(this.tiktok, "tiktok");
    this.bindSource(this.replay, "replay");
    this.bindSource(this.simulator, "simulator");
    this.eventBus.subscribe((event) => {
      this.eventGateway.broadcastEvent(event);
      if (this.recorder.isRecording && this.recorder.session?.sessionId === event.sessionId) void this.recorder.append(event);
      this.semanticGame.handleEvent(event);
      for (const action of this.mapper.map(event)) {
        this.actionGateway.broadcastAction(action);
        logger.debug({ action: action.action, sourceEventId: action.sourceEventId }, "action_emitted");
      }
    });
  }

  async init(): Promise<void> {
    await this.simulator.connect();
    this.semanticGame.start();
  }

  async connect(username: string): Promise<unknown> {
    if (this.tiktok.isConnected()) await this.tiktok.disconnect();
    this.sessions.end("tiktok");
    this.currentTikTokUsername = username.replace(/^@/, "");
    await this.adminConfig.update({ tiktok: { username: this.currentTikTokUsername } });
    this.sessions.start("tiktok", { username: this.currentTikTokUsername });
    logger.info({ source: "tiktok", username: this.currentTikTokUsername }, "source_connect");
    try {
      const config = this.adminConfig.current;
      await this.tiktok.connect({ username: this.currentTikTokUsername, autoReconnect: config.tiktok.autoReconnect, enableExtendedGiftInfo: config.tiktok.extendedGiftInfo, debug: config.observability.debug, storeRawEvents: config.observability.storeRawEvents });
    } catch (error) {
      this.sessions.end("tiktok");
      throw new ApiError("SOURCE_CONNECT_FAILED", error instanceof Error ? error.message : String(error), 502);
    }
    return this.status();
  }

  async disconnect(): Promise<unknown> {
    await this.tiktok.disconnect();
    this.sessions.end("tiktok");
    return this.status();
  }

  async startRecording(): Promise<unknown> {
    if (this.recorder.isRecording) throw new ApiError("RECORDING_ACTIVE", "A recording is already active");
    const meta = this.recordingMeta();
    await this.recorder.start(meta);
    logger.info({ sessionId: meta.sessionId, source: meta.source }, "recording_started");
    return { recording: true, session: meta };
  }

  async stopRecording(): Promise<unknown> {
    const meta = await this.recorder.stop();
    if (meta) logger.info({ sessionId: meta.sessionId }, "recording_stopped");
    return { recording: false, session: meta };
  }

  async listSessions(): Promise<unknown> {
    return this.reader.list();
  }

  async startReplay(sessionId: string, speed: ReplaySpeed): Promise<unknown> {
    if (!(await this.reader.exists(sessionId))) throw new ApiError("SESSION_NOT_FOUND", `Session ${sessionId} was not found`, 404);
    this.replay.stop();
    await this.replay.disconnect();
    this.sessions.end("replay");
    const events = await this.reader.read(sessionId);
    const meta = this.sessions.start("replay", { username: `Replay:${sessionId}` });
    this.replay.load(events, speed);
    await this.replay.connect({ speed });
    this.replay.play();
    logger.info({ sessionId, speed }, "replay_started");
    return { ...this.replay.getState(), session: meta };
  }

  pauseReplay(): unknown {
    this.replay.pause();
    return this.replay.getState();
  }

  resumeReplay(): unknown {
    this.replay.resume();
    return this.replay.getState();
  }

  stopReplay(): unknown {
    this.replay.stop();
    logger.info({}, "replay_stopped");
    return this.replay.getState();
  }

  restartReplay(): unknown {
    this.replay.restart();
    logger.info({}, "replay_started");
    return this.replay.getState();
  }

  simulate(message: SimulatorMessage): unknown {
    if (!this.simulator.isConnected()) void this.simulator.connect();
    this.simulator.send(message);
    return { accepted: true, type: message.type };
  }

  status(): unknown {
    const now = Date.now();
    while (this.eventTimes[0] !== undefined && this.eventTimes[0] < now - 1000) this.eventTimes.shift();
    const tiktokStatus = this.statuses.tiktok;
    return {
      sources: this.statuses,
      activeSource: this.activeSource(),
      username: this.currentTikTokUsername,
      roomId: tiktokStatus.roomId,
      recording: this.recorder.isRecording,
      recordingSessionId: this.recorder.session?.sessionId,
      replay: this.replay.getState(),
      stats: {
        chat: this.counts.chat ?? 0,
        gift: this.counts.gift ?? 0,
        like: this.counts.like ?? 0,
        join: this.counts.join ?? 0,
        follow: this.counts.follow ?? 0,
        share: this.counts.share ?? 0,
        eventsPerSec: this.eventTimes.length,
        connectedDurationSec: tiktokStatus.connectedAt ? Math.max(0, Math.floor((now - tiktokStatus.connectedAt) / 1000)) : 0,
        viewerCount: this.counts.viewerCount,
        totalLikes: this.counts.totalLikes,
      },
      debug: {
        enabled: process.env.DEBUG === "true" || process.env.DEBUG === "1",
        latestDecoded: this.latestDebug,
      },
      adminConfig: this.adminConfig.view(),
    };
  }

  adminConfigView(): unknown {
    return this.adminConfig.view();
  }

  async updateAdminConfig(patch: unknown): Promise<unknown> {
    return this.adminConfig.update(patch);
  }

  dictionaryStatus(): unknown {
    return this.semanticGame.dictionaryStatus();
  }

  resolveDictionaryWord(text: string, language?: string): unknown {
    return this.semanticGame.resolveDictionaryWord(text, language);
  }

  attachWebSockets(wsServer: HttpServer): void {
    this.eventGateway.attach(wsServer);
    this.actionGateway.attach(wsServer);
    this.semanticGateway.attach(wsServer);
  }

  close(): void {
    this.semanticGame.stop();
    this.eventGateway.close();
    this.actionGateway.close();
    this.semanticGateway.close();
  }

  private bindSource(source: { onEvent: (callback: (event: import("./sources/LiveEventSource.js").SourceEvent) => void) => void; onStatus: (callback: (status: SourceStatus) => void) => void }, sourceKind: SourceKind): void {
    source.onStatus((status) => {
      this.statuses[sourceKind] = { ...this.statuses[sourceKind], ...status };
      if (status.status !== "error") this.statuses[sourceKind].error = undefined;
      if (status.status === "disconnected" || status.status === "offline") {
        this.statuses[sourceKind].connectedAt = undefined;
        if (sourceKind === "tiktok") this.statuses[sourceKind].roomId = undefined;
      }
      if (status.roomId) this.sessions.update(sourceKind, { roomId: status.roomId });
      if (status.status === "connected") logger.info({ source: sourceKind, roomId: status.roomId }, "source_connected");
      else if (status.status === "disconnected" || status.status === "offline") logger.info({ source: sourceKind }, "source_disconnected");
      else if (status.status === "error") logger.warn({ source: sourceKind, error: status.error }, "source_error");
    });
    source.onEvent((sourceEvent) => {
      if (sourceEvent.debug) {
        this.latestDebug = sourceEvent.decoded ?? sourceEvent.data;
        this.eventGateway.broadcastDebug({ source: sourceKind, eventName: sourceEvent.type, data: this.latestDebug });
        return;
      }
      const { session, sequence } = this.sessions.nextSequence(sourceKind);
      const event = this.normalizer.normalize(sourceEvent, sourceKind, session.sessionId, sequence);
      this.observe(event);
      this.eventBus.emit(event);
      logger.debug({ source: sourceKind, type: event.type, sequence: event.sequence }, "event_received");
    });
  }

  private observe(event: NormalizedLiveEvent): void {
    this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
    this.eventTimes.push(Date.now());
    if (event.type === "room_stats") {
      if (typeof event.payload.viewerCount === "number") this.counts.viewerCount = event.payload.viewerCount;
      if (typeof event.payload.totalLikes === "number") this.counts.totalLikes = event.payload.totalLikes;
    }
  }

  private recordingMeta(): SessionMeta {
    const active = this.tiktok.isConnected() ? this.sessions.current("tiktok") : this.replay.isConnected() ? this.sessions.current("replay") : this.sessions.current("simulator");
    return active ?? this.sessions.start("simulator", { username: "Simulator" });
  }

  private activeSource(): SourceKind | "none" {
    if (this.statuses.tiktok.status === "connected") return "tiktok";
    if (this.replay.getState().state === "playing" || this.replay.getState().state === "paused") return "replay";
    if (this.statuses.simulator.status === "connected") return "simulator";
    return "none";
  }
}

function loadRulesSync(): RulesConfig {
  // Loaded synchronously at startup to keep the rule file a simple local configuration.
  const path = resolve(projectRoot, "config", "game-rules.json");
  return JSON.parse(readFileSync(path, "utf8")) as RulesConfig;
}

async function main(): Promise<void> {
  const lab = new InteractionLab();
  await lab.init();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createApiRouter(lab));
  app.use("/test-game-client", express.static(join(projectRoot, "tools", "test-game-client")));
  app.use("/test-word-game", express.static(join(projectRoot, "tools", "test-word-game")));
  app.use("/test-split", express.static(join(projectRoot, "tools", "test-split")));
  app.use(errorHandler);

  const isProduction = process.env.NODE_ENV === "production";
  let vite: ViteDevServer | undefined;
  if (isProduction) {
    app.use(express.static(join(projectRoot, "dist-web")));
    app.use((_req, res) => res.sendFile(join(projectRoot, "dist-web", "index.html")));
  } else {
    vite = await createViteServer({ root: webRoot, server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT ?? 3000);
  const wsPort = Number(process.env.WS_PORT ?? 8765);
  const host = process.env.HOST ?? "127.0.0.1";
  const httpServer = createServer(app);
  const wsServer = createServer();
  lab.attachWebSockets(wsServer);

  await new Promise<void>((resolvePromise) => httpServer.listen(port, host, resolvePromise));
  await new Promise<void>((resolvePromise) => wsServer.listen(wsPort, host, resolvePromise));
  logger.info({ http: `http://${host}:${port}`, websocket: `ws://${host}:${wsPort}` }, "server_started");

  const shutdown = async () => {
    await lab.stopRecording();
    await lab.disconnect();
    await lab.stopReplay();
    lab.close();
    await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
    await new Promise<void>((resolvePromise) => wsServer.close(() => resolvePromise()));
    await vite?.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main().catch((error) => {
  logger.error({ err: error }, "server_start_failed");
  process.exitCode = 1;
});
