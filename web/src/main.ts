import "./style.css";
import { escapeHtml, formatDuration, formatNumber, setStatusBadge } from "./components";

type EventType = "chat" | "gift" | "gift_progress" | "like" | "join" | "follow" | "share" | "room_stats" | "stream_end" | "social" | "unknown";
type EventRecord = {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  sequence: number;
  source: string;
  type: EventType;
  receivedAt: number;
  platformTimestamp?: number;
  originalSource?: string;
  originalReceivedAt?: number;
  user?: { id?: string; uniqueId?: string; nickname?: string; avatarUrl?: string };
  payload: Record<string, unknown>;
  raw?: unknown;
  debug?: { decoded?: unknown; eventName?: string };
};

const eventTypes: Array<{ type: EventType; label: string }> = [
  { type: "chat", label: "聊天" }, { type: "gift", label: "礼物" }, { type: "like", label: "点赞" },
  { type: "join", label: "加入" }, { type: "follow", label: "关注" }, { type: "share", label: "分享" }, { type: "room_stats", label: "房间" },
];
const eventTypeLabels: Record<string, string> = { chat: "聊天", gift: "礼物", gift_progress: "礼物进度", like: "点赞", join: "加入", follow: "关注", share: "分享", room_stats: "房间统计", stream_end: "直播结束", social: "社交", unknown: "未知" };
const sourceLabels: Record<string, string> = { tiktok: "TikTok", replay: "回放", simulator: "模拟器" };
const statusLabels: Record<string, string> = { idle: "待机", connecting: "连接中", connected: "已连接", disconnected: "已断开", offline: "已下线", error: "错误" };
const replayStateLabels: Record<string, string> = { idle: "待机", playing: "播放中", paused: "已暂停", stopped: "已停止", completed: "已完成" };
const languageLabels: Record<string, string> = { en: "English", vi: "Tiếng Việt", "zh-Hans": "简体中文" };
const events: EventRecord[] = [];
const filters = new Set(eventTypes.map(({ type }) => type));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let latestStatus: any;
let latestConfig: any;
let latestGameSnapshot: any;
let refreshTimer: number | undefined;
let websocketPort = 8765;

const api = async (path: string, options: RequestInit = {}): Promise<any> => {
  const response = await fetch(`/api${path}`, { headers: { "content-type": "application/json", ...(options.headers ?? {}) }, ...options });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let body: any = {};
  if (contentType.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("后台返回的 JSON 无法解析，请重启后台服务后再试");
    }
  } else if (/^\s*<(?:!doctype\s+html|html)\b/i.test(text)) {
    throw new Error("后台接口尚未加载，请重启服务后再打开管理后台");
  } else {
    throw new Error(`服务器返回了无法识别的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || body.ok === false) throw new Error(body.error?.message ?? `请求失败（${response.status}）`);
  if (body.data === undefined) throw new Error("后台接口没有返回数据，请重启后台服务后再试");
  return body.data;
};
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (path: string, body: unknown) => api(path, { method: "PATCH", body: JSON.stringify(body) });

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function displayUser(event: EventRecord): string {
  return event.user?.nickname || event.user?.uniqueId || event.user?.id || "—";
}

function displaySummary(event: EventRecord): string {
  const payload = event.payload ?? {};
  if (event.type === "chat") return String(payload.text || payload.content || "");
  if (event.type === "like") return `+${String(payload.count ?? 0)}`;
  if (event.type === "gift" || event.type === "gift_progress") return `${String(payload.giftName ?? payload.giftId ?? "礼物")} ×${String(payload.count ?? 1)}`;
  if (event.type === "room_stats") return `${String(payload.viewerCount ?? "—")} 观众`;
  return "";
}

function toast(message: string, tone: "success" | "error" | "info" = "info"): void {
  const root = $("toastRoot");
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.textContent = message;
  root.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function localizedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/Cannot read properties of undefined.*wordlistCount/i.test(raw)) return "词库接口没有返回数据，请重启后台服务后再刷新。";
  if (/Failed to fetch|NetworkError|fetch failed/i.test(raw)) return "无法连接后台服务，请确认服务已启动。";
  if (/Unexpected token|JSON/i.test(raw)) return "后台返回格式异常，请重启服务后再试。";
  return raw;
}

function showError(error: unknown): void {
  const message = localizedError(error);
  const errorEl = $("errorText");
  if (errorEl) { errorEl.hidden = false; errorEl.textContent = message; }
  toast(message, "error");
}

function setView(view: string): void {
  document.querySelectorAll<HTMLElement>(".admin-view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
}

document.querySelectorAll<HTMLButtonElement>(".nav-item, .nav-jump").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view ?? "overview")));

function renderFilters(): void {
  const filterBar = $("filterBar");
  filterBar.innerHTML = "";
  for (const { type, label } of eventTypes) {
    const labelEl = document.createElement("label");
    labelEl.className = "filter-option";
    labelEl.innerHTML = `<input type="checkbox" checked data-filter="${type}"><span>${label}</span>`;
    labelEl.querySelector("input")!.addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      input.checked ? filters.add(type) : filters.delete(type);
      renderEvents();
    });
    filterBar.append(labelEl);
  }
}

function renderEvents(): void {
  const visible = events.filter((event) => filters.has(event.type === "gift_progress" ? "gift" : event.type as EventType));
  const eventList = $("eventList");
  if (visible.length === 0) {
    eventList.className = "event-list empty-state";
    eventList.textContent = "当前筛选条件下没有事件。";
    return;
  }
  eventList.className = "event-list";
  eventList.innerHTML = "";
  for (const event of visible) {
    const row = document.createElement("button");
    row.className = `event-row type-${event.type}`;
    const avatar = event.user?.avatarUrl ? `<img class="user-avatar" src="${escapeHtml(event.user.avatarUrl)}" loading="lazy" alt="" />` : `<span class="user-avatar fallback-avatar">${escapeHtml(displayUser(event).slice(0, 1))}</span>`;
    row.innerHTML = `<span class="event-time">${formatTime(event.receivedAt)}</span><span class="event-type">${eventTypeLabels[event.type] ?? event.type}</span><span class="event-user">${avatar}<span>${escapeHtml(displayUser(event))}</span></span><span class="event-summary">${escapeHtml(displaySummary(event))}</span><span class="event-source">${sourceLabels[event.source] ?? event.source}</span><span class="event-seq">#${event.sequence}</span>`;
    row.addEventListener("click", () => inspectEvent(event));
    eventList.append(row);
  }
}

function renderRecentActivity(): void {
  const container = $("recentActivity");
  const recent = events.slice(0, 6);
  if (recent.length === 0) { container.className = "activity-list empty-state"; container.textContent = "等待 TikTok 事件…"; return; }
  container.className = "activity-list";
  container.innerHTML = recent.map((event) => `<div class="activity-row"><span class="activity-dot type-${event.type}"></span><div><strong>${escapeHtml(displayUser(event))}</strong><span>${eventTypeLabels[event.type] ?? event.type} ${escapeHtml(displaySummary(event))}</span></div><time>${formatTime(event.receivedAt)}</time></div>`).join("");
}

function addEvent(event: EventRecord): void {
  events.unshift(event);
  while (events.length > Number(latestConfig?.config?.observability?.eventBufferLimit ?? 1000)) events.pop();
  renderEvents();
  renderRecentActivity();
  $("latestActivity").textContent = `${eventTypeLabels[event.type] ?? event.type} · ${displayUser(event)}`;
}

function inspectEvent(event: EventRecord): void {
  $("selectedEventLabel").textContent = `${eventTypeLabels[event.type] ?? event.type} #${event.sequence}`;
  $("normalizedOutput").textContent = JSON.stringify(event, null, 2);
  $("rawOutput").textContent = JSON.stringify(event.raw ?? event.debug?.decoded ?? { message: "当前事件没有附加原始或解码数据。" }, null, 2);
}

function sourceTone(status: string): "live" | "success" | "warning" | "danger" | "muted" {
  if (status === "connected") return "live";
  if (status === "connecting") return "warning";
  if (status === "error") return "danger";
  return "muted";
}

function updateStatus(data: any): void {
  latestStatus = data;
  websocketPort = Number(data.runtime?.websocketPort ?? websocketPort);
  const source = data.sources?.tiktok ?? {};
  const status = String(source.status ?? "idle");
  const label = statusLabels[status] ?? status;
  $("statusText").textContent = label;
  $("sidebarStatusText").textContent = label;
  $("sidebarUsername").textContent = source.username ? `@${source.username}` : "未选择直播间";
  $("sidebarRoomId").textContent = `Room ID ${source.roomId ?? "—"}`;
  $("roomId").textContent = source.roomId ?? "—";
  $("statusDot").className = `status-dot ${status}`;
  $("sidebarStatusDot").className = `status-dot ${status}`;
  setStatusBadge($("overviewLiveBadge"), label, sourceTone(status));
  setStatusBadge($("healthBadge"), status === "connected" ? "连接健康" : label, sourceTone(status));
  const errorEl = $("errorText");
  if (status === "error" && source.error) { errorEl.hidden = false; errorEl.textContent = `连接失败：${source.error}`; } else if (status === "connected" || status === "idle") errorEl.hidden = true;
  const duration = Number(data.stats?.connectedDurationSec ?? 0);
  $("duration").textContent = formatDuration(duration);
  const stats = data.stats ?? {};
  for (const [id, value] of [["statChat", stats.chat], ["statGift", stats.gift], ["statLike", stats.like], ["viewerCount", stats.viewerCount], ["eventsPerSec", stats.eventsPerSec], ["totalLikes", stats.totalLikes]]) $(id).textContent = value === undefined ? "—" : formatNumber(value);
  $("giftInfoHealth").textContent = source.message?.includes("扩展礼物") ? "已降级基础字段" : status === "connected" ? "可用/已连接" : "—";
  $("reconnectHealth").textContent = latestConfig?.config?.tiktok?.autoReconnect ? "已开启" : "已关闭";
  const replay = data.replay ?? {};
  setStatusBadge($("replayState"), replayStateLabels[String(replay.state ?? "idle")] ?? String(replay.state ?? "idle"), replay.state === "playing" ? "live" : "muted");
  $("replayProgress").textContent = `${replay.index ?? 0} / ${replay.total ?? 0}`;
  $("recordingBadge").textContent = data.recording ? "录制中" : "未录制";
  $("recordingBadge").className = `status-badge ${data.recording ? "danger" : "muted"}`;
  $("recordButton").toggleAttribute("disabled", Boolean(data.recording));
  $("stopRecordButton").toggleAttribute("disabled", !data.recording);
  $("configCurrentRoom").textContent = source.roomId ?? "—";
  $("configGiftInfo").textContent = source.message ?? "基础状态正常";
  $("securityRawEvents").textContent = data.debug?.enabled ? "调试开启" : "未保存/关闭";
}

function updateGameSnapshot(message: any): void {
  latestGameSnapshot = message;
  const room = message.room ?? {};
  const round = message.round ?? {};
  const metrics = message.metrics ?? {};
  $("summaryWordlist").textContent = room.wordlistId ?? "—";
  $("summaryLanguage").textContent = languageLabels[room.language] ?? room.language ?? "—";
  $("summaryRound").textContent = round.roundNo ? `第 ${round.roundNo} 局` : "—";
  $("summaryGuesses").textContent = formatNumber(metrics.validGuesses ?? 0);
  $("summaryModel").textContent = `${message.embedding?.model ?? "Embedding"} · ${message.hintModel?.configured ? `${message.hintModel.model} 已配置` : "模型 key 未配置"}`;
  const snapshot = $("gameSnapshot");
  snapshot.innerHTML = [["轮次", round.roundNo ? `第 ${round.roundNo} 局` : "—"], ["有效猜词", formatNumber(metrics.validGuesses ?? 0)], ["参与人数", formatNumber(metrics.uniqueGuessers ?? 0)], ["提示数", formatNumber(message.hintsUnlocked ?? 0)]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function setValue(id: string, value: unknown): void { const element = $(id) as HTMLInputElement | HTMLSelectElement; if (element.type === "checkbox") (element as HTMLInputElement).checked = Boolean(value); else element.value = String(value ?? ""); }

function fillConfig(view: any): void {
  latestConfig = view;
  const config = view.config;
  setValue("cfgGameLanguage", config.game.language); setValue("cfgDictionaryPackage", config.game.dictionaryPackageId); setValue("cfgAnswer", config.game.answer);
  setValue("cfgRoundDuration", Number(config.game.roundDurationMs) / 1000); setValue("cfgSettlementDuration", Number(config.game.settlementDurationMs) / 1000); setValue("cfgLikesPerHint", config.game.likesPerHint); setValue("cfgGiftWordsMultiplier", config.game.giftWordsMultiplier); setValue("cfgGiftExtraTime", Number(config.game.giftExtraTimeMs) / 1000); setValue("cfgTickInterval", config.game.tickIntervalMs); setValue("cfgAllowUnknown", config.game.allowUnknownInputs); setValue("cfgAllowFallback", config.game.allowLocalGiftFallback);
  setValue("cfgTikTokUsername", config.tiktok.username); setValue("username", config.tiktok.username); setValue("cfgAutoReconnect", config.tiktok.autoReconnect); setValue("cfgExtendedGift", config.tiktok.extendedGiftInfo);
  setValue("cfgEmbeddingBaseUrl", config.embedding.baseUrl); setValue("cfgEmbeddingModel", config.embedding.model); setValue("cfgEmbeddingTimeout", config.embedding.timeoutMs);
  setValue("cfgHintBaseUrl", config.llm.baseUrl); setValue("cfgLlmRoutingMode", config.llm.routingMode); setValue("cfgPreferredModel", config.llm.preferredModel); setValue("cfgFallbackModels", config.llm.fallbackModels.join(",")); setValue("cfgFixedModel", config.llm.fixedModel); setValue("cfgHintTimeout", config.llm.timeoutMs); setValue("cfgBatchSize", config.llm.batchSize);
  setValue("cfgEventLimit", config.observability.eventBufferLimit); setValue("cfgDebug", config.observability.debug); setValue("cfgStoreRaw", config.observability.storeRawEvents);
  $("embeddingKeyStatus").textContent = view.secrets.embeddingApiKeyConfigured ? "已配置" : "未配置";
  $("hintKeyStatus").textContent = view.secrets.hintLlmApiKeyConfigured ? "已配置" : "未配置";
  $("activeHintModel").textContent = latestGameSnapshot?.hintModel?.lastModelUsed ?? latestGameSnapshot?.hintModel?.model ?? config.llm.preferredModel;
  $("dictionaryMissing").textContent = latestGameSnapshot?.room?.dictionary ? Object.values(latestGameSnapshot.room.dictionary.missingLabelsByLanguage ?? {}).join(" / ") : "—";
  $("runtimeInfo").innerHTML = `<div><span>配置来源</span><strong>${view.persistence.source === "file" ? "本地持久化" : "环境变量默认"}</strong></div><div><span>配置文件</span><strong>${escapeHtml(view.persistence.path)}</strong></div><div><span>Embedding</span><strong>${escapeHtml(config.embedding.model)}</strong></div><div><span>模型路由</span><strong>${config.llm.routingMode === "fixed" ? `固定 ${escapeHtml(config.llm.fixedModel)}` : `首选 ${escapeHtml(config.llm.preferredModel)} · ${config.llm.fallbackModels.length} 个兜底`}</strong></div>`;
}

async function refreshStatus(): Promise<void> { try { updateStatus(await api("/status")); } catch (error) { showError(error); } }
async function refreshConfig(): Promise<void> { try { fillConfig(await api("/admin/config")); } catch (error) { showError(error); } }
async function refreshDictionaries(): Promise<void> {
  try {
    const library = await api("/dictionaries");
    if (!library || typeof library !== "object") throw new Error("词库接口没有返回数据，请重启后台服务后再刷新。");
    $("wordlistCount").textContent = formatNumber(library.wordlistCount);
    $("questionBankCount").textContent = formatNumber(library.questionBankCount);
    $("supplementCount").textContent = formatNumber(library.supplementCount);
    $("activeDictionaryId").textContent = library.activePackageId ?? "—";
    const select = $("cfgDictionaryPackage") as HTMLSelectElement;
    select.innerHTML = library.packages.map((item: any) => `<option value="${escapeHtml(item.packageId)}">${escapeHtml(item.wordlistId)} · ${item.packageType === "question-bank" ? "题目库" : "词库"} · ${item.stats?.concepts ?? 0} 项</option>`).join("");
    if (latestConfig?.config?.game?.dictionaryPackageId) setValue("cfgDictionaryPackage", latestConfig.config.game.dictionaryPackageId);
    const list = $("dictionaryPackageList");
    list.className = library.packages.length ? "package-list" : "package-list empty-state";
    list.innerHTML = library.packages.length ? library.packages.map((item: any) => `<div class="package-row"><div><strong>${escapeHtml(item.wordlistId)}</strong><span>${item.packageType === "question-bank" ? "题目库" : "词库"} · ${escapeHtml(item.release)} · ${item.stats?.concepts ?? 0} 个概念</span></div><b>${item.active ? "当前" : "可激活"}</b></div>`).join("") : "暂无已上传词库。";
  } catch (error) { showError(error); }
}
async function refreshSessions(): Promise<void> {
  try {
    const sessions = await api("/sessions");
    const select = $("sessionSelect") as HTMLSelectElement;
    select.innerHTML = sessions.length ? sessions.map((session: any) => `<option value="${escapeHtml(session.sessionId)}">${new Date(session.startedAt).toLocaleString()} · ${sourceLabels[session.source] ?? session.source} · ${session.eventCount} 个事件</option>`).join("") : `<option value="">暂无录制会话</option>`;
  } catch (error) { showError(error); }
}

async function refreshAll(): Promise<void> { await Promise.all([refreshStatus(), refreshConfig(), refreshSessions(), refreshDictionaries()]); }

async function saveConfig(): Promise<void> {
  const patchValue = {
    tiktok: { username: ($("cfgTikTokUsername") as HTMLInputElement).value.trim(), autoReconnect: ($("cfgAutoReconnect") as HTMLInputElement).checked, extendedGiftInfo: ($("cfgExtendedGift") as HTMLInputElement).checked },
    game: { language: ($("cfgGameLanguage") as HTMLSelectElement).value, dictionaryPackageId: ($("cfgDictionaryPackage") as HTMLSelectElement).value, answer: ($("cfgAnswer") as HTMLInputElement).value.trim(), roundDurationMs: Math.round(Number(($('cfgRoundDuration') as HTMLInputElement).value) * 1000), settlementDurationMs: Math.round(Number(($('cfgSettlementDuration') as HTMLInputElement).value) * 1000), tickIntervalMs: Number(($('cfgTickInterval') as HTMLInputElement).value), likesPerHint: Number(($('cfgLikesPerHint') as HTMLInputElement).value), giftWordsMultiplier: Number(($('cfgGiftWordsMultiplier') as HTMLInputElement).value), giftExtraTimeMs: Math.round(Number(($('cfgGiftExtraTime') as HTMLInputElement).value) * 1000), allowUnknownInputs: ($('cfgAllowUnknown') as HTMLInputElement).checked, allowLocalGiftFallback: ($('cfgAllowFallback') as HTMLInputElement).checked },
    embedding: { baseUrl: ($("cfgEmbeddingBaseUrl") as HTMLInputElement).value.trim(), model: ($("cfgEmbeddingModel") as HTMLInputElement).value.trim(), timeoutMs: Number(($('cfgEmbeddingTimeout') as HTMLInputElement).value) },
    llm: { baseUrl: ($("cfgHintBaseUrl") as HTMLInputElement).value.trim(), routingMode: ($("cfgLlmRoutingMode") as HTMLSelectElement).value, preferredModel: ($("cfgPreferredModel") as HTMLInputElement).value.trim(), fallbackModels: ($("cfgFallbackModels") as HTMLInputElement).value.split(",").map((value) => value.trim()).filter(Boolean), fixedModel: ($("cfgFixedModel") as HTMLInputElement).value.trim(), timeoutMs: Number(($('cfgHintTimeout') as HTMLInputElement).value), batchSize: Number(($('cfgBatchSize') as HTMLInputElement).value) },
    observability: { debug: ($('cfgDebug') as HTMLInputElement).checked, storeRawEvents: ($('cfgStoreRaw') as HTMLInputElement).checked, eventBufferLimit: Number(($('cfgEventLimit') as HTMLInputElement).value) },
  };
  try {
    const result = await patch("/admin/config", patchValue);
    fillConfig(result);
    const effects = result.effects ?? {};
    const message = effects.requiresRestart ? "已保存；模型、语言或调试配置将在重启后生效" : effects.requiresReconnect ? "已保存；连接策略将在下次连接时生效" : "已保存并生效";
    $("configSaveMessage").textContent = message;
    setStatusBadge($("configEffectBadge"), effects.requiresRestart ? "需要重启" : effects.requiresReconnect ? "需重新连接" : "已生效", effects.requiresRestart ? "warning" : "success");
    toast(message, "success");
  } catch (error) { showError(error); }
}

async function resolveDictionary(): Promise<void> {
  const text = ($("dictionaryText") as HTMLInputElement).value.trim();
  const language = ($("dictionaryLanguage") as HTMLSelectElement).value;
  if (!text) return;
  try { $("dictionaryResult").textContent = JSON.stringify(await api(`/dictionary/resolve?text=${encodeURIComponent(text)}&language=${encodeURIComponent(language)}`), null, 2); } catch (error) { showError(error); }
}

async function uploadDictionary(): Promise<void> {
  const input = $("dictionaryFile") as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) { toast("请先选择 JSON 词库包", "info"); return; }
  try {
    const result = await api("/dictionaries/import", { method: "POST", body: JSON.stringify({ filename: file.name, packageType: ($("dictionaryPackageType") as HTMLSelectElement).value, content: await file.text() }) });
    $("dictionaryPackageResult").textContent = JSON.stringify(result, null, 2);
    toast("词库包已校验并保存", "success");
    await refreshDictionaries();
  } catch (error) { showError(error); }
}

async function saveSupplements(): Promise<void> {
  const words = ($("supplementWords") as HTMLInputElement).value.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean);
  if (!words.length) { toast("请输入需要去重的补充词", "info"); return; }
  try {
    const result = await api("/dictionaries/supplements", { method: "POST", body: JSON.stringify({ language: ($("cfgGameLanguage") as HTMLSelectElement).value, words, sourceModel: latestGameSnapshot?.hintModel?.lastModelUsed ?? latestGameSnapshot?.hintModel?.model ?? "unknown" }) });
    $("dictionaryPackageResult").textContent = JSON.stringify(result, null, 2);
    ($("supplementWords") as HTMLInputElement).value = "";
    toast(`已接收 ${result.accepted} 个新词，重复 ${result.duplicates} 个`, "success");
    await refreshDictionaries();
  } catch (error) { showError(error); }
}

$("adminConfigForm").addEventListener("submit", (event) => { event.preventDefault(); void saveConfig(); });
$("reloadConfigButton").addEventListener("click", () => void refreshConfig());
$("resolveDictionaryButton").addEventListener("click", () => void resolveDictionary());
$("refreshDictionariesButton").addEventListener("click", () => void refreshDictionaries());
$("uploadDictionaryButton").addEventListener("click", () => void uploadDictionary());
$("saveSupplementsButton").addEventListener("click", () => void saveSupplements());
$("refreshButton").addEventListener("click", () => void refreshAll());
$("connectButton").addEventListener("click", async () => { try { const username = ($("username") as HTMLInputElement).value.trim(); await post("/connect", { username }); toast("TikTok 连接请求已发送", "success"); await refreshStatus(); } catch (error) { showError(error); } });
$("disconnectButton").addEventListener("click", async () => { try { await post("/disconnect"); toast("已断开 TikTok 连接", "info"); await refreshStatus(); } catch (error) { showError(error); } });
$("recordButton").addEventListener("click", async () => { try { await post("/recording/start"); toast("事件录制已开始", "success"); await refreshStatus(); } catch (error) { showError(error); } });
$("stopRecordButton").addEventListener("click", async () => { try { await post("/recording/stop"); toast("事件录制已停止", "info"); await refreshStatus(); await refreshSessions(); } catch (error) { showError(error); } });
$("clearButton").addEventListener("click", async () => {
  try {
    await post("/events/clear");
    events.length = 0;
    renderEvents();
    renderRecentActivity();
    toast("已清空服务端事件缓存", "info");
  } catch (error) { showError(error); }
});
$("replayPlayButton").addEventListener("click", async () => { try { const speedValue = ($("speedSelect") as HTMLSelectElement).value; await post("/replay/start", { sessionId: ($("sessionSelect") as HTMLSelectElement).value, speed: speedValue === "MAX" ? "MAX" : Number(speedValue) }); await refreshStatus(); } catch (error) { showError(error); } });
$("replayPauseButton").addEventListener("click", async () => { try { await post("/replay/pause"); await refreshStatus(); } catch (error) { showError(error); } });
$("replayStopButton").addEventListener("click", async () => { try { await post("/replay/stop"); await refreshStatus(); } catch (error) { showError(error); } });
$("replayRestartButton").addEventListener("click", async () => { try { await post("/replay/restart"); await refreshStatus(); } catch (error) { showError(error); } });

for (const button of document.querySelectorAll<HTMLButtonElement>(".simulator-action")) {
  button.addEventListener("click", async () => {
    const type = button.dataset.sim as string;
    const userName = ($("simUser") as HTMLInputElement).value;
    const message: Record<string, unknown> = { type, user: { uniqueId: userName, nickname: userName } };
    if (type === "chat") message.text = ($("simText") as HTMLInputElement).value;
    if (type === "like") message.count = 8;
    if (type === "gift") Object.assign(message, { giftId: ($("simGiftId") as HTMLInputElement).value, giftName: ($("simGiftName") as HTMLInputElement).value, count: Number(($('simGiftCount') as HTMLInputElement).value), diamondCount: Number(($('simDiamondCount') as HTMLInputElement).value), repeatEnd: true });
    try { await post("/simulate", message); toast(`模拟${eventTypeLabels[type] ?? type}已发送`, "success"); } catch (error) { showError(error); }
  });
}

function connectWebSocket(path: string, onMessage: (message: any) => void, statusId: string): void {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.hostname}:${websocketPort}${path}`);
  socket.addEventListener("open", () => { $(statusId).textContent = `${path.includes("events") ? "事件" : "动作"} WS：已连接`; $(statusId).className = "connection-pill success"; });
  socket.addEventListener("message", (event) => { try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed UI message */ } });
  socket.addEventListener("close", () => { $(statusId).textContent = `${path.includes("events") ? "事件" : "动作"} WS：断开`; $(statusId).className = "connection-pill muted"; window.setTimeout(() => connectWebSocket(path, onMessage, statusId), 1500); });
  socket.addEventListener("error", () => socket.close());
}

renderFilters();
connectWebSocket("/events", (message) => { if (message?.op === "event" && message.event?.eventId) addEvent(message.event); else if (message?.eventId) addEvent(message); }, "wsEventStatus");
connectWebSocket("/actions", () => undefined, "wsActionStatus");
function connectGameSocket(): void {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const gameSocket = new WebSocket(`${protocol}://${window.location.hostname}:${websocketPort}/word-game`);
  gameSocket.addEventListener("message", (event) => { try { updateGameSnapshot(JSON.parse(event.data)); } catch { /* ignore */ } });
  gameSocket.addEventListener("close", () => window.setTimeout(connectGameSocket, 1500));
}
connectGameSocket();
void refreshAll();
refreshTimer = window.setInterval(() => void refreshStatus(), 2000);
window.addEventListener("beforeunload", () => { if (refreshTimer) window.clearInterval(refreshTimer); });
