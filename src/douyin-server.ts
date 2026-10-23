import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { z } from "zod";
import { AdminConfigService, adminConfigSchema } from "./admin/AdminConfigService.js";
import { EventBus } from "./core/EventBus.js";
import type { NormalizedLiveEvent } from "./core/events.js";
import { Normalizer } from "./core/Normalizer.js";
import { SessionManager } from "./core/SessionManager.js";
import { DictionaryLibraryService } from "./dictionary/DictionaryLibraryService.js";
import { SemanticGameGateway } from "./game/SemanticGameGateway.js";
import { SemanticGameService } from "./game/SemanticGameService.js";
import { DouyinWebcastProxy } from "./douyin/DouyinWebcastProxy.js";
import { DouyinLoginService } from "./douyin/DouyinLoginService.js";
import { DouyinCredentialStore } from "./douyin/DouyinCredentialStore.js";
import { DouyinOperations, presentationSettingsSchema } from "./douyin/DouyinOperations.js";
import { DouyinGiftGate } from "./douyin/DouyinGiftGate.js";
import { buildDouyinEventStream } from "./douyin/DouyinEventStream.js";
import { rulesSchema, defaultRules, matchRule, planInteraction } from "./game/InteractionRules.js";
import { buildWebcastBrowserBundle } from "./douyin/WebcastBrowserBundle.js";
import { isLocalAdminRequest } from "./douyin/LocalAccess.js";
import { DouyinSource, type DouyinConnectConfig, type DouyinGiftCatalogEntry } from "./sources/DouyinSource.js";
import { DouyinWebcastSource, parseDouyinWebRid, type WebcastBridgeMessage } from "./sources/DouyinWebcastSource.js";
import type { LiveEventSource, SourceEvent, SourceStatus } from "./sources/LiveEventSource.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logger = pino({ level: process.env.DEBUG === "true" || process.env.DEBUG === "1" ? "debug" : "info" });

interface StartBody {
  roomId?: string;
  appId?: string;
  accessToken?: string;
  pushSecret?: string;
  giftCatalog?: Record<string, DouyinGiftCatalogEntry>;
}

interface WebcastStartBody {
  url?: string;
  webRid?: string;
  cookie?: string;
}

export class DouyinInteractionLab {
  private readonly officialSource = new DouyinSource();
  private readonly webcastSource = new DouyinWebcastSource();
  private normalizer = new Normalizer({ storeRawEvents: process.env.STORE_RAW_EVENTS === "true" });
  private readonly sessions = new SessionManager();
  private readonly eventBus = new EventBus();
  private readonly adminConfig: AdminConfigService;
  private readonly gateway: SemanticGameGateway;
  private readonly game: SemanticGameService;
  readonly operations: DouyinOperations;
  private readonly giftGate = new DouyinGiftGate();
  private readonly dataDir:string;
  private currentRoomKey = "unconnected";
  private status: SourceStatus = { source: "douyin", status: "idle" };
  private readonly counts: Record<string, number> = {};
  private readonly recentEvents: NormalizedLiveEvent[] = [];
  private roomId?: string;
  private appId?: string;
  private connectionMode: "official" | "webcast" | "none" = "none";
  private webcastEnded?: () => void;
  onWebcastEnded(callback: () => void): void { this.webcastEnded = callback; }
  private webcastBridgeExpired?: () => void;
  onWebcastBridgeExpired(callback: () => void): void { this.webcastBridgeExpired = callback; }
  hasActiveWebcastBridge(): boolean { return this.connectionMode === "webcast" && this.webcastSource.hasActiveBridge(); }

  constructor() {
    const dataDir = resolve(process.env.DATA_DIR ?? join(projectRoot, "data"));
    this.dataDir=dataDir;
    const legacy=new AdminConfigService(dataDir);legacy.loadSync();
    this.operations=new DouyinOperations(join(dataDir,"douyin"));
    this.adminConfig = new AdminConfigService(join(dataDir,"douyin"),this.operations.gameConfig??legacy.current);
    if(!this.operations.gameConfig)this.adminConfig.loadSync();
    const dictionaryLibrary = new DictionaryLibraryService(dataDir, this.adminConfig.current.game.dictionaryPackageId);
    this.gateway = new SemanticGameGateway(logger, () => this.game.snapshot(),{allowedOrigins:[`http://127.0.0.1:${process.env.DOUYIN_PORT??3002}`,`http://localhost:${process.env.DOUYIN_PORT??3002}`,`http://[::1]:${process.env.DOUYIN_PORT??3002}`]});
    this.game = new SemanticGameService(this.gateway, this.adminConfig, dictionaryLibrary.loadActive(),{presentation:()=>this.operations.presentation,carryGiftWords:true,useReviewedDefinitions:true});
    this.bindSource(this.officialSource, "official");
    this.bindSource(this.webcastSource, "webcast");
    this.webcastSource.onBridgeExpired(() => {
      if (this.connectionMode !== "webcast") return;
      this.game.invalidateInteractions();
      this.webcastBridgeExpired?.();
    });
    this.eventBus.subscribe((event) => {
      const roomKey=this.currentRoomKey;
      this.operations.observe(roomKey,event);
      if(!this.giftGate.accept(event)) return;
      if(["gift","like","follow","share"].includes(event.type)) {
        try {
          const plan=this.operations.plan(this.operations.inputFor(event,roomKey),`${roomKey}:${event.user?.id??event.user?.uniqueId??"anonymous"}`);
          // Unconfigured social activity still belongs in the live event stream,
          // but it is not an execution and must not flood the effect ledger.
          const producedEffect=plan.randomWords>0||plan.extraTimeMs>0||plan.hints>0;
          const explicitlyDisplayOnly=Boolean(plan.ruleId)&&plan.quantity>0;
          if(producedEffect||explicitlyDisplayOnly) {
            const record=this.operations.record(event,roomKey,plan);
            void this.game.applyInteraction(event,plan,progress=>this.operations.update(record,progress));
          } else void this.game.applyInteraction(event,plan,()=>{});
        } catch {
          const plan=planInteraction(undefined,{trigger:event.type as "gift"|"like"|"follow"|"share",quantity:0});
          const record=this.operations.record(event,roomKey,plan);
          this.operations.update(record,{status:"failed",message:"互动数量或规则计算超出安全范围，本条未执行，后续互动不受影响。"});
        }
      } else this.game.handleEvent(event);
    });
  }

  init(): void {
    this.game.start();
  }

  attachWebSocket(server: ReturnType<typeof createServer>): void {
    this.gateway.attach(server);
  }

  async start(input: StartBody): Promise<unknown> {
    const config: DouyinConnectConfig = {
      roomId: input.roomId?.trim() || process.env.DOUYIN_ROOM_ID || "",
      appId: input.appId?.trim() || process.env.DOUYIN_APP_ID || "",
      accessToken: input.accessToken?.trim() || process.env.DOUYIN_ACCESS_TOKEN || "",
      pushSecret: input.pushSecret?.trim() || process.env.DOUYIN_PUSH_SECRET || "",
      giftCatalog: input.giftCatalog || readGiftCatalogFromEnv(),
    };
    if(!config.roomId||!config.appId||!config.accessToken||!config.pushSecret)throw new Error("官方通道需要房间 ID、AppID、Access Token 和推送密钥；当前连接未更改。");
    await this.webcastSource.disconnect();
    this.connectionMode = "official";
    this.sessions.end("douyin");
    this.sessions.start("douyin", { roomId: config.roomId, username: `Douyin:${config.roomId}` });
    this.roomId = config.roomId;
    this.appId = config.appId;
    this.switchRoom(`official:${config.roomId}`);
    await this.officialSource.connect(config);
    return this.view();
  }

  async startWebcast(input: WebcastStartBody): Promise<unknown> {
    if (this.officialSource.isConnected()) await this.officialSource.disconnect();
    this.connectionMode = "webcast";
    this.sessions.end("douyin");
    await this.webcastSource.connect({ url: input.url, webRid: input.webRid });
    const connection = this.webcastSource.connectionInstructions();
    this.sessions.start("douyin", { username: `DouyinWebcast:${connection.webRid}` });
    this.roomId = undefined;
    this.appId = undefined;
    this.switchRoom(`webcast:${connection.webRid}`);
    this.operations.rememberRoom(connection.webRid,connection.webRid);
    return { ...this.view(), connection };
  }

  updateWebcastState(token: string, state: Parameters<DouyinWebcastSource["updateState"]>[1]): unknown {
    this.webcastSource.updateState(token, state);
    if (state.roomId) this.roomId = state.roomId;
    if(state.title) {const webRid=this.webcastSource.diagnostics().webRid;if(webRid)this.operations.rememberRoom(webRid,state.title);}
    return this.view();
  }

  acceptWebcastMessages(token: string, messages: WebcastBridgeMessage[]): unknown {
    return this.webcastSource.acceptMessages(token, messages);
  }

  updateWebcastDiagnostics(token: string, diagnostics: unknown): void {
    this.webcastSource.updateDiagnostics(token, diagnostics);
  }

  updateWebcastTransport(state: string): void {
    if (this.connectionMode !== "webcast" || !["disconnected", "error"].includes(state)) return;
    this.game.invalidateInteractions();
    this.webcastSource.transportState(state as "disconnected" | "error", "直播数据通道已断开，请重新连接；登录缓存和本场积分仍保留。");
  }

  async stop(): Promise<unknown> {
    this.game.invalidateInteractions();
    if (this.connectionMode === "official") await this.officialSource.disconnect();
    if (this.connectionMode === "webcast") await this.webcastSource.disconnect();
    this.connectionMode = "none";
    this.sessions.end("douyin");
    return this.view();
  }

  restartGame(): unknown {
    return this.game.restartRound();
  }

  get roomKey():string {return this.currentRoomKey;}
  get catalogRoomId():string|undefined {return this.roomId;}
  private switchRoom(key:string):void {
    this.game.invalidateInteractions();
    this.normalizer=new Normalizer({storeRawEvents:process.env.STORE_RAW_EVENTS==="true"});
    this.giftGate.clear();this.operations.resetCounters();
    if(this.currentRoomKey!==key) {
      this.currentRoomKey=key;
      for(const key of Object.keys(this.counts))delete this.counts[key];
      this.recentEvents.length=0;this.game.resetRoom();
    }
  }
  async operatorView():Promise<unknown> {
    const library=new DictionaryLibraryService(this.dataDir,this.adminConfig.current.game.dictionaryPackageId);
    return { ...this.operations.view(this.currentRoomKey),interactions:this.game.interactionDiagnostics(),eventStream:this.eventStreamView(),config:this.adminConfig.current,library:await library.view(),game:this.game.snapshot() };
  }
  eventStreamView() {return buildDouyinEventStream(this.recentEvents,this.counts);}
  gameControl(action:"start"|"pause"|"resume"|"next") {if(action==="start"||action==="next")this.operations.resetCounters();return this.game.control(action);}
  async saveGame(input:unknown):Promise<unknown> {
    const schema=z.object({revision:z.number().int(),game:adminConfigSchema.shape.game.partial().optional(),llm:adminConfigSchema.shape.llm.partial().optional(),embedding:adminConfigSchema.shape.embedding.partial().optional(),presentation:presentationSettingsSchema.optional()}).strict();
    const parsed=schema.parse(input);
    const {revision,...patch}=parsed;
    const presentation=patch.presentation??this.operations.presentation;
    const current=this.adminConfig.current;
    const candidate=adminConfigSchema.parse({...current,game:{...current.game,...patch.game},llm:{...current.llm,...patch.llm},embedding:{...current.embedding,...patch.embedding}});
    const library=new DictionaryLibraryService(this.dataDir,candidate.game.dictionaryPackageId);
    const view=await library.view();
    if(!view.packages.some(p=>p.packageId===candidate.game.dictionaryPackageId))throw new Error("请选择存在的词库包。");
    const dictionary=library.loadActive();
    if(!dictionary.answerWords(candidate.game.language).length)throw new Error("此题库在所选语言下没有题目。");
    const answer=dictionary.normalizeSurface(candidate.game.answer);
    if(answer&&!dictionary.answerWords(candidate.game.language).includes(answer))throw new Error("指定答案不在所选题库中，请先导入或选择已有题目。");
    if(presentation?.directionHint && !answer)throw new Error("自定义方向提示仅用于固定答案，题库轮换时请留空。");
    if(presentation?.directionHint && answer && presentation.directionHint.includes(answer))throw new Error("方向提示不能直接包含答案。");
    candidate.game.answer=answer;
    await this.operations.saveGame(candidate,presentation,revision);
    this.adminConfig.applyPersistedConfig(candidate);
    this.operations.resetCounters();this.game.reconfigure(dictionary);
    return this.operatorView();
  }
  async importDictionary(input:unknown) {
    const data=z.object({filename:z.string().max(200),packageType:z.enum(["wordlist","question-bank"]),content:z.string().max(10000000)}).parse(input);
    return new DictionaryLibraryService(this.dataDir,this.adminConfig.current.game.dictionaryPackageId).importPackage(data);
  }

  acceptPush(request: Request, rawBody: Buffer): unknown {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, value]));
    return this.officialSource.acceptPush(headers, rawBody.toString("utf8"));
  }

  view(): Record<string, unknown> {
    const connected = this.connectionMode === "official" ? this.officialSource.isConnected() : this.connectionMode === "webcast" ? this.webcastSource.isConnected() : false;
    const diagnostics = this.officialSource.diagnostics();
    const webcastDiagnostics = this.webcastSource.diagnostics();
    return {
      platform: "douyin",
      sources: { douyin: this.status },
      activeSource: connected ? "douyin" : "none",
      connectionMode: this.connectionMode,
      roomId: this.roomId,
      appId: this.appId,
      stats: {
        chat: this.counts.chat ?? 0,
        gift: this.counts.gift ?? 0,
        like: this.counts.like ?? 0,
        acceptedCallbacks: diagnostics.acceptedCallbacks,
        duplicateMessages: diagnostics.duplicateMessages,
        filteredTestMessages: diagnostics.filteredTestMessages,
        webcastMessages: webcastDiagnostics.acceptedMessages,
      },
      douyin: {
        ...diagnostics,
        callbackPath: "/api/douyin/events",
        pushSecretConfigured: Boolean(process.env.DOUYIN_PUSH_SECRET),
        accessTokenConfigured: Boolean(process.env.DOUYIN_ACCESS_TOKEN),
        official: diagnostics,
        webcast: webcastDiagnostics,
      },
      runtime: {
        httpPort: Number(process.env.DOUYIN_PORT ?? 3002),
        websocketPort: Number(process.env.DOUYIN_WS_PORT ?? 8767),
        recentEventCount: this.recentEvents.length,
        gameDelivery: this.gateway.diagnostics(),
        interactions: this.game.interactionDiagnostics(),
        memory: process.memoryUsage(),
        uptimeSeconds: Math.floor(process.uptime()),
      },
      game: this.game.snapshot(),
    };
  }

  recent(limit = 50): NormalizedLiveEvent[] {
    return this.recentEvents.slice(0, Math.max(1, Math.min(200, limit)));
  }

  close(): void {
    this.webcastSource.close();
    this.game.stop();
    this.gateway.close();
  }

  private bindSource(source: LiveEventSource, mode: "official" | "webcast"): void {
    source.onStatus((status) => {
      if (this.connectionMode !== mode && status.status !== "connecting") return;
      this.status = status;
      if (status.roomId) this.sessions.update("douyin", { roomId: status.roomId });
    });
    source.onEvent((sourceEvent: SourceEvent) => {
      if (this.connectionMode !== mode) return;
      const { session, sequence } = this.sessions.nextSequence("douyin");
      const event = this.normalizer.normalize(sourceEvent, "douyin", session.sessionId, sequence);
      this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
      this.recentEvents.unshift(event);
      if (this.recentEvents.length > 200) this.recentEvents.length = 200;
      this.eventBus.emit(event);
      if (mode === "webcast" && event.type === "stream_end") {
        this.game.invalidateInteractions();
        this.webcastEnded?.();
      }
    });
  }
}

function readGiftCatalogFromEnv(): Record<string, DouyinGiftCatalogEntry> {
  try {
    const parsed = JSON.parse(process.env.DOUYIN_GIFT_CATALOG_JSON || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, DouyinGiftCatalogEntry> : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  // Build once before starting timers/listeners; never expose npm bare imports.
  const webcastBrowserBundle = await buildWebcastBrowserBundle(projectRoot);
  const lab = new DouyinInteractionLab();
  const credentialStore = new DouyinCredentialStore(join(process.env.DATA_DIR ?? join(projectRoot, "data"), "douyin", "login.dpapi.json"));
  const webcastProxy = new DouyinWebcastProxy(credentialStore, { canOpenBridge: () => lab.hasActiveWebcastBridge() });
  lab.onWebcastEnded(() => webcastProxy.disconnectClients("disconnected"));
  lab.onWebcastBridgeExpired(() => webcastProxy.disconnectClients("disconnected"));
  webcastProxy.onTransportState(state => lab.updateWebcastTransport(state.state));
  await webcastProxy.restoreCredentials();
  const login = new DouyinLoginService({ projectRoot, acceptCookie: (cookie, expiresAt) => webcastProxy.setCookie(cookie, expiresAt) });
  if (webcastProxy.diagnostics().cookie.hasLoginSession) login.restored();
  lab.init();
  const app = express();
  let connectionQueue: Promise<unknown> = Promise.resolve();
  const mutateConnection = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = connectionQueue.then(operation);
    connectionQueue = result.catch(() => undefined);
    return result;
  };
  const view = () => {
    const status = lab.view();
    return { ...status, douyin: { ...(status.douyin as Record<string, unknown>), webcastConnection: webcastProxy.diagnostics(), login: login.status() } };
  };

  app.post("/api/douyin/events", express.raw({ type: "application/json", limit: "2mb" }), (request, response) => {
    try {
      const result = lab.acceptPush(request, Buffer.isBuffer(request.body) ? request.body : Buffer.from(""));
      response.status(200).json({ err_no: 0, err_msg: "ok", data: result });
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "douyin_callback_rejected");
      response.status(401).json({ err_no: 401, err_msg: errorMessage(error) });
    }
  });

  app.use(express.json({ limit: "12mb" }));
  // Official push callback is already mounted above. All operator writes and
  // answer-bearing settings below are loopback + same-origin only.
  app.use(["/api/douyin","/api/game"],(request,response,next)=>{
    response.set("Cache-Control","no-store");
    if(!isLocalAdminRequest(request)){response.status(403).json({error:"仅允许本机后台操作。"});return;}
    next();
  });
  app.use("/api/douyin/webcast", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (!isLocalAdminRequest(request)) { response.status(403).json({ error: "仅允许从本机抖音后台操作凭证和连接。" }); return; }
    next();
  });
  app.use("/dylive", (request, response) => webcastProxy.handleHttp(request, response));
  app.get("/api/status", (_request, response) => {
    const status = view();
    // Keep the top-level shape convenient for the Douyin admin while matching
    // the existing game client's { data: { runtime } } status contract.
    response.set("Cache-Control", "no-store").json({ ...status, data: status });
  });
  app.get("/api/events", (request, response) => response.json(lab.recent(Number(request.query.limit) || 50)));
  const operatorRoute = (handler:(request:Request)=>Promise<unknown>|unknown) => async(request:Request,response:Response)=>{
    try {response.json(await handler(request));}
    catch(error){response.status(400).json({error:error instanceof z.ZodError?"配置格式不正确，请检查数值、规则条件和必填字段。":errorMessage(error)});}
  };
  app.get("/api/douyin/operations",operatorRoute(()=>lab.operatorView()));
  app.get("/api/douyin/operations/events",operatorRoute(()=>lab.eventStreamView()));
  app.put("/api/douyin/operations/rules",operatorRoute(async request=>{
    await lab.operations.saveRules(request.body?.rules,Number(request.body?.revision));return lab.operatorView();
  }));
  app.post("/api/douyin/operations/rules/reset",operatorRoute(async request=>{
    await lab.operations.saveRules(defaultRules(),Number(request.body?.revision));return lab.operatorView();
  }));
  app.post("/api/douyin/operations/simulate",operatorRoute(request=>{
    const input=z.object({trigger:z.enum(["gift","like","follow","share"]),giftId:z.string().max(100).optional(),unitPrice:z.number().min(0).max(1e9).optional(),quantity:z.number().int().min(1).max(1000000),rules:rulesSchema.optional()}).parse(request.body);
    const rules=input.rules??lab.operations.rules;
    const rule=matchRule(rules,input);
    const normalized=input.trigger==="like"&&rule?{...input,quantity:Math.floor(input.quantity/rule.every)}:input;
    return {simulation:true,plan:planInteraction(rule,normalized),message:"隔离预演：不调用模型，不投递直播，不修改积分或执行记录。"};
  }));
  app.post("/api/douyin/operations/catalog/sync",operatorRoute(async()=>{
    const roomKey=lab.roomKey,roomId=lab.catalogRoomId;
    if(!roomId)throw new Error("请先连接直播间，取得真实房间 ID 后再同步。");
    const gifts=await webcastProxy.fetchGiftCatalog(roomId);
    if(roomKey!==lab.roomKey)throw new Error("直播间已切换，本次目录未写入新房间，请重新同步。");
    return lab.operations.mergeGifts(roomKey,gifts,"platform","已取得平台目录；未逐项验证当前房间可赠送资格，不保证完整性。");
  }));
  app.post("/api/douyin/operations/catalog/import",operatorRoute(request=>{
    if(lab.roomKey==="unconnected")throw new Error("请先选择直播间，再导入该房间礼物。");
    return lab.operations.mergeGifts(lab.roomKey,request.body?.gifts,"imported");
  }));
  app.put("/api/douyin/operations/game",operatorRoute(request=>lab.saveGame(request.body)));
  app.post("/api/douyin/operations/game/control",operatorRoute(request=>{
    const action=z.enum(["start","pause","resume","next"]).parse(request.body?.action);return {game:lab.gameControl(action)};
  }));
  app.post("/api/douyin/operations/dictionary/import",operatorRoute(request=>lab.importDictionary(request.body)));
  app.post("/api/douyin/start", async (request, response) => {
    try {
      response.json(await mutateConnection(async () => { login.cancel(); const result=await lab.start(request.body as StartBody); webcastProxy.disconnectClients(); return result; }));
    } catch (error) {
      response.status(502).json({ error: "抖音数据任务启动失败", message: errorMessage(error) });
    }
  });
  app.post("/api/douyin/webcast/login/start", (request, response) => {
    const automatic = request.body?.automatic === true;
    if (automatic && webcastProxy.diagnostics().cookie.hasLoginSession) {
      response.json({ login: login.status(), created: false });
      return;
    }
    response.json(login.start(automatic));
  });
  app.post("/api/douyin/webcast/login/cancel", (_request, response) => {
    response.json({ login: login.cancel() });
  });
  app.post("/api/douyin/webcast/start", async (request, response) => {
    try {
      response.json(await mutateConnection(async () => {
        const input = request.body as WebcastStartBody;
        if (!parseDouyinWebRid(String(input.webRid ?? input.url ?? ""))) throw new Error("请输入有效的抖音直播间链接或 web_rid。");
        if (input.cookie !== undefined && input.cookie !== "") { login.cancel(); await webcastProxy.setCookie(input.cookie); }
        webcastProxy.disconnectClients();
        return lab.startWebcast(input);
      }));
    } catch (error) {
      response.status(400).json({ error: "抖音 Webcast 快速连接初始化失败", message: errorMessage(error) });
    }
  });
  app.delete("/api/douyin/webcast/cookie", async (_request, response) => {
    try {
      response.json(await mutateConnection(async () => {
        login.cleared(); await lab.stop(); await webcastProxy.clearCookie();
        return { ok: true, message: "已清除本机加密登录缓存与内存登录态，并断开抖音连接。", ...view() };
      }));
    } catch { response.status(500).json({ error: "连接已断开，但保存的登录态未能清除，请检查本机目录权限后重试退出。" }); }
  });
  app.post("/api/douyin/webcast/diagnostics", (request, response) => {
    try {
      lab.updateWebcastDiagnostics(request.body?.sessionToken || "", request.body?.diagnostics);
      response.json({ ok: true });
    } catch { response.status(401).json({ error: "诊断会话已失效，请重新连接。" }); }
  });
  app.post("/api/douyin/webcast/state", (request, response) => {
    try {
      const body = request.body as { sessionToken?: string; state?: Parameters<DouyinWebcastSource["updateState"]>[1] };
      response.json(lab.updateWebcastState(body.sessionToken || "", body.state || {}));
    } catch (error) {
      response.status(401).json({ error: "Webcast 状态更新失败", message: errorMessage(error) });
    }
  });
  app.post("/api/douyin/webcast/events", (request, response) => {
    try {
      const body = request.body as { sessionToken?: string; messages?: WebcastBridgeMessage[] };
      response.json(lab.acceptWebcastMessages(body.sessionToken || "", Array.isArray(body.messages) ? body.messages : []));
    } catch (error) {
      response.status(401).json({ error: "Webcast 消息接收失败", message: errorMessage(error) });
    }
  });
  app.post("/api/douyin/stop", async (_request, response) => {
    try {
      response.json(await mutateConnection(async () => {
        login.cancel(); webcastProxy.disconnectClients(); await lab.stop(); return view();
      }));
    } catch (error) {
      response.status(502).json({ error: "抖音数据任务停止失败", message: errorMessage(error) });
    }
  });
  app.post("/api/game/start", (_request, response) => response.json({ ok: true, game: lab.restartGame() }));

  app.use("/douyin-admin", express.static(join(projectRoot, "tools", "douyin-admin")));
  app.get("/vendor/dycast/index.mjs", (_request, response) => {
    response.set("Cache-Control", "no-cache").type("application/javascript").send(webcastBrowserBundle);
  });
  app.get("/vendor/dycast/mssdk.js", (_request, response) => response.sendFile(join(projectRoot, "node_modules", "@dycast", "core", "public", "mssdk.js")));
  app.use("/test-word-game", express.static(join(projectRoot, "tools", "test-word-game")));
  app.use("/douyin-split", express.static(join(projectRoot, "tools", "douyin-split")));
  app.get("/", (_request, response) => response.redirect("/douyin-admin/"));
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    // Parser errors can contain fragments of a credential-bearing request body.
    response.status(400).json({ error: "请求格式不正确，请检查输入后重试。" });
  });

  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.DOUYIN_PORT ?? 3002);
  const wsPort = Number(process.env.DOUYIN_WS_PORT ?? 8767);
  const httpServer = createServer(app);
  const wsServer = createServer();
  lab.attachWebSocket(wsServer);
  webcastProxy.attach(httpServer);
  await new Promise<void>((resolvePromise) => httpServer.listen(port, host, resolvePromise));
  await new Promise<void>((resolvePromise) => wsServer.listen(wsPort, host, resolvePromise));
  logger.info({ admin: `http://${host}:${port}/douyin-admin/`, game: `http://${host}:${port}/test-word-game/`, websocket: `ws://${host}:${wsPort}/word-game` }, "douyin_server_started");

  const shutdown = async () => {
    login.close();
    await lab.stop().catch(() => undefined);
    lab.close();
    await lab.operations.flush();
    webcastProxy.close();
    await webcastProxy.flushCredentials();
    await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
    await new Promise<void>((resolvePromise) => wsServer.close(() => resolvePromise()));
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) void main().catch((error) => {
  logger.error({ err: error }, "douyin_server_start_failed");
  process.exitCode = 1;
});
