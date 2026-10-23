import type { IncomingMessage, ServerResponse } from "node:http";
import { request as secureRequest } from "node:https";
import type { Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { DouyinCookieJar } from "./DouyinCookieJar.js";
import { isLocalAdminRequest } from "./LocalAccess.js";
import { DouyinCredentialStore } from "./DouyinCredentialStore.js";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

interface WebcastHandshakeDiagnostics {
  signaturePresent: boolean;
  signatureLength: number;
  msTokenPresent: boolean;
  identity: string;
  userUniqueIdPresent: boolean;
  userUniqueIdLength: number;
  roomIdMatchesUserId: boolean;
  cookieAttached: boolean;
}

export interface WebcastTransportDiagnostics {
  state: string;
  frames: number;
  lastFrameAt: number;
  handshake?: WebcastHandshakeDiagnostics;
}

export class DouyinWebcastProxy {
  private readonly clients = new Set<WebSocket>();
  private readonly targets = new Set<WebSocket>();
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly cookies = new DouyinCookieJar();
  private transport: WebcastTransportDiagnostics = { state: "idle", frames: 0, lastFrameAt: 0 };
  private credentialVersion = 0;
  private expiresAt?: number;
  private invalidReason?: "expired" | "rejected";
  private readonly transportCallbacks = new Set<(state: WebcastTransportDiagnostics) => void>();
  constructor(private readonly credentialStore?: DouyinCredentialStore, private readonly options: { createTarget?: (url: string, options: WebSocket.ClientOptions) => WebSocket; canOpenBridge?: () => boolean } = {}) {}

  onTransportState(callback: (state: WebcastTransportDiagnostics) => void): void { this.transportCallbacks.add(callback); }
  private changeTransport(transport: WebcastTransportDiagnostics, state: string): void {
    if (transport !== this.transport || transport.state === state) return;
    transport.state = state;
    for (const callback of this.transportCallbacks) callback({ ...transport });
  }

  async restoreCredentials(): Promise<void> {
    const restored = await this.credentialStore?.load();
    if (restored) { this.cookies.setUserCookie(restored.cookie); this.expiresAt = restored.expiresAt; }
    else if (this.credentialStore?.status().state === "expired") this.invalidReason = "expired";
  }

  async setCookie(cookie: string, expiresAt?: number): Promise<void> {
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("登录态已到期，请重新扫码。");
    this.cookies.setUserCookie(cookie);
    this.credentialVersion++; this.expiresAt = expiresAt; this.invalidReason = undefined;
    if (this.cookies.status().hasLoginSession) await this.credentialStore?.save(this.cookies.header(), expiresAt);
    else await this.credentialStore?.clear();
  }

  diagnostics() {
    this.checkExpiry();
    const persistence = this.credentialStore?.status();
    return { cookie: { ...this.cookies.status(), validation: this.invalidReason || "unverified",
      storage: persistence && ["saved", "restored"].includes(persistence.state) ? "encrypted-local" : "memory",
      ...(persistence ? { persistence } : {}) }, transport: { ...this.transport } };
  }
  async flushCredentials(): Promise<void> { await this.credentialStore?.flush(); }
  private checkExpiry(): void {
    if (this.expiresAt !== undefined && this.expiresAt <= Date.now()) this.invalidateCredentials("expired");
  }
  private invalidateCredentials(reason: "expired" | "rejected"): void {
    this.credentialVersion++; this.cookies.clear(); this.expiresAt = undefined; this.invalidReason = reason;
    this.disconnectClients();
    void this.credentialStore?.clear(reason).catch(() => undefined);
  }
  private acceptResponseCookies(cookies: string[], version: number, status?: number): void {
    // An old room request cannot restore credentials after logout/account switch.
    if (version !== this.credentialVersion) return;
    this.checkExpiry();
    if (version !== this.credentialVersion) return;
    if (status === 401 && this.cookies.status().hasLoginSession) { this.invalidateCredentials("rejected"); return; }
    const before = this.cookies.header(), hadLogin = this.cookies.status().hasLoginSession;
    this.cookies.acceptUpstreamCookies(cookies);
    if (hadLogin && !this.cookies.status().hasLoginSession) { this.invalidateCredentials("expired"); return; }
    if (before !== this.cookies.header() && this.cookies.status().hasLoginSession) {
      void this.credentialStore?.save(this.cookies.header(), this.expiresAt).catch(() => undefined);
    }
  }

  async fetchGiftCatalog(roomId:string):Promise<Array<{id:string;name:string;icon:string;price?:number}>> {
    if(!/^\d{5,30}$/.test(roomId)) throw new Error("尚未解析真实房间 ID，请先连接直播间。");
    this.checkExpiry();
    const version = this.credentialVersion;
    // Fixed upstream only; never accept a caller-provided URL or expose cookies.
    const path=`/webcast/gift/list/?device_platform=webapp&aid=6383&room_id=${roomId}`;
    const body=await new Promise<string>((resolve,reject)=>{
      const upstream=secureRequest({hostname:"live.douyin.com",port:443,path,method:"GET",headers:{"user-agent":DESKTOP_UA,referer:"https://live.douyin.com/",cookie:this.cookies.header(),"accept-encoding":"identity"}},res=>{
        this.acceptResponseCookies(res.headers["set-cookie"] || [], version, res.statusCode);
        if(res.statusCode!==200) {res.resume();reject(new Error("平台礼物目录暂不可用，请稍后同步；仍可使用实收或导入礼物。"));return;}
        const chunks:Buffer[]=[];let size=0;
        res.on("data",(data:Buffer)=>{size+=data.length;if(size>8*1024*1024){upstream.destroy();reject(new Error("礼物目录响应过大，已停止读取。"));return;}chunks.push(data);});
        res.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error",()=>reject(new Error("礼物目录响应中断。")));
      });
      upstream.setTimeout(15000,()=>upstream.destroy(new Error("timeout")));
      upstream.on("error",()=>reject(new Error("礼物目录请求失败，请检查网络或重新登录；已收录礼物仍保留。")));
      upstream.end();
    });
    return parsePlatformGiftCatalog(body);
  }
  disconnectClients(state = "idle"): void {
    // Invalidate the former transport before its asynchronous close callbacks.
    this.transport = { ...this.transport, state };
    for (const socket of this.clients) socket.close(1000, "本地后台断开连接");
    for (const socket of this.targets) socket.close();
    const sockets = [...this.clients, ...this.targets];
    const timeout = setTimeout(() => { for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 2000);
    timeout.unref();
  }

  async clearCookie(): Promise<void> {
    this.credentialVersion++; this.disconnectClients(); this.cookies.clear(); this.expiresAt = undefined; this.invalidReason = undefined;
    await this.credentialStore?.clear();
  }

  handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (!isLocalAdminRequest(request)) { response.writeHead(403).end(); return; }
    const suffix = (request.url || "/").replace(/^\/dylive/, "");
    const target = new URL(suffix || "/", "https://live.douyin.com");
    if (request.method !== "GET" || target.origin !== "https://live.douyin.com" || !/^\/(?:[a-zA-Z0-9_-]{5,40}\/?|webcast\/im\/fetch\/?)$/.test(target.pathname)) {
      response.writeHead(400).end("不允许的抖音代理路径"); return;
    }
    // Never forward localhost cookies or return upstream Set-Cookie to the browser.
    this.checkExpiry();
    const version = this.credentialVersion;
    const headers = { host: target.hostname, "user-agent": DESKTOP_UA, referer: "https://live.douyin.com/", cookie: this.cookies.header(), accept: "*/*", "accept-encoding": "identity" };
    const upstream = secureRequest({ hostname: target.hostname, port: 443, path: `${target.pathname}${target.search}`, method: "GET", headers }, (upstreamResponse) => {
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.on("aborted", () => response.destroy());
      if (response.destroyed) { upstreamResponse.destroy(); return; }
      this.acceptResponseCookies(upstreamResponse.headers["set-cookie"] || [], version, upstreamResponse.statusCode);
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders["set-cookie"];
      responseHeaders["cache-control"] = "no-store";
      response.writeHead(upstreamResponse.statusCode || 200, responseHeaders);
      upstreamResponse.pipe(response);
    });
    upstream.setTimeout(20000, () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "抖音网页请求转发失败，请检查网络后重试。" }));
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  }

  attach(httpServer: HttpServer): void {
    this.server.on("connection", (client, request) => {
      // A stale renderer must not reopen the upstream socket after lease
      // expiry, stop, or stream end. Recheck after the HTTP upgrade boundary.
      if (this.options.canOpenBridge && !this.options.canOpenBridge()) { client.close(1008, "Webcast 会话已结束，请重新连接"); return; }
      this.checkExpiry();
      this.clients.add(client);
      const path = (request.url || "").replace(/^\/socket/, "");
      const cookieAttached = this.cookies.status().hasLoginSession;
      const handshake = summarizeWebcastHandshake(path, cookieAttached);
      const transport: WebcastTransportDiagnostics = { state: "connecting", frames: 0, lastFrameAt: 0, handshake };
      this.transport = transport;
      const targetUrl = `wss://webcast5-ws-web-lf.douyin.com${path}`;
      const target = (this.options.createTarget ?? ((url, options) => new WebSocket(url, options)))(targetUrl, { headers: { "user-agent": DESKTOP_UA, origin: "https://live.douyin.com", referer: "https://live.douyin.com/", cookie: this.cookies.header() }, perMessageDeflate: false, handshakeTimeout: 20000 });
      this.targets.add(target);
      target.on("open", () => { this.changeTransport(transport, "connected"); });
      client.on("message", (data) => { if (target.readyState === WebSocket.OPEN) target.send(data); });
      target.on("message", (data) => {
        transport.frames += 1; transport.lastFrameAt = Date.now();
        if (client.bufferedAmount > 4 * 1024 * 1024) { this.changeTransport(transport, "error"); client.terminate(); target.close(); return; }
        if (client.readyState === WebSocket.OPEN) client.send(data, error => { if (error) client.terminate(); });
      });
      client.on("close", () => { if (transport.state !== "error") this.changeTransport(transport, "disconnected"); target.close(); });
      target.on("close", (code) => { if (transport.state !== "error") this.changeTransport(transport, "disconnected"); client.close(code === 1005 || code === 1006 ? 1000 : code, "抖音上游连接关闭"); });
      client.on("error", () => target.close());
      target.on("error", () => { this.changeTransport(transport, "error"); client.close(1011, "抖音 Webcast 上游连接失败"); });
      const cleanup = () => { this.clients.delete(client); this.targets.delete(target); };
      client.once("close", cleanup);
      target.once("close", cleanup);
    });
    httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      if (!pathname.startsWith("/socket/")) return;
      if (!isLocalAdminRequest(request) || pathname !== "/socket/webcast/im/push/v2/") { socket.destroy(); return; }
      if (this.options.canOpenBridge && !this.options.canOpenBridge()) { socket.destroy(); return; }
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    });
  }

  close(): void {
    // Service shutdown is not logout. Keep the encrypted cache across restarts.
    this.credentialVersion++; this.disconnectClients(); this.cookies.clear();
    this.server.close();
  }
}

export function summarizeWebcastHandshake(path:string,cookieAttached:boolean):WebcastHandshakeDiagnostics {
  let url:URL;
  try {url=new URL(path,"wss://webcast.invalid");}
  catch {url=new URL("wss://webcast.invalid/");}
  const signature=url.searchParams.get("signature")??"";
  const roomId=url.searchParams.get("room_id")??"";
  const userUniqueId=url.searchParams.get("user_unique_id")??"";
  const rawIdentity=url.searchParams.get("identity")??"";
  const identity=/^[a-zA-Z0-9_-]{0,32}$/.test(rawIdentity)?rawIdentity:"other";
  return {
    signaturePresent:signature.length>0,
    signatureLength:Math.min(signature.length,10_000),
    msTokenPresent:Boolean(url.searchParams.get("msToken")),
    identity,
    userUniqueIdPresent:userUniqueId.length>0,
    userUniqueIdLength:Math.min(userUniqueId.length,10_000),
    roomIdMatchesUserId:Boolean(roomId)&&roomId===userUniqueId,
    cookieAttached,
  };
}

export function parsePlatformGiftCatalog(body:string):Array<{id:string;name:string;icon:string;price?:number}> {
  let data:any;
  try {data=JSON.parse(body);}catch{throw new Error("平台未返回可解析的礼物目录，可能需要登录或接口已变化。");}
  if(!data || typeof data!=="object")throw new Error("平台未返回有效礼物目录。");
  if(data.status_code!==undefined && data.status_code!==0) throw new Error("平台拒绝了礼物目录请求，请确认登录态。");
  const gifts=data.data?.gifts;
  if(!Array.isArray(gifts)||!gifts.length) throw new Error("平台暂未返回礼物列表；实收礼物不等于完整目录。");
  const result=gifts.slice(0,10000).flatMap((gift:any)=>{
    if(!gift || !["string","number"].includes(typeof gift.id)||!gift.name) return [];
    if(typeof gift.id==="number"&&!Number.isSafeInteger(gift.id)) return [];
    const price=Number(gift.diamond_count);
    return [{id:String(gift.id),name:String(gift.name).slice(0,100),icon:String(gift.image?.url_list?.[0]??""),...(Number.isFinite(price)&&price>=0?{price}:{})}];
  });
  if(!result.length) throw new Error("平台礼物字段已变化，暂不能建立目录。");
  return result;
}
