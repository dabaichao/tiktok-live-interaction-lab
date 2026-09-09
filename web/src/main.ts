import "./style.css";

type EventType = "chat" | "gift" | "gift_progress" | "like" | "join" | "follow" | "share" | "room_stats" | "stream_end" | "social" | "unknown";
type EventRecord = {
  schemaVersion: 1; eventId: string; sessionId: string; sequence: number; source: string; type: EventType;
  receivedAt: number; platformTimestamp?: number; originalSource?: string; originalReceivedAt?: number;
  user?: { id?: string; uniqueId?: string; nickname?: string; avatarUrl?: string };
  payload: Record<string, unknown>; raw?: unknown; debug?: { decoded?: unknown; eventName?: string };
};

const eventTypes: Array<{ type: EventType; label: string }> = [
  { type: "chat", label: "聊天" }, { type: "gift", label: "礼物" }, { type: "like", label: "点赞" },
  { type: "join", label: "加入" }, { type: "follow", label: "关注" }, { type: "share", label: "分享" }, { type: "room_stats", label: "房间" },
];
const eventTypeLabels: Record<string, string> = {
  chat: "聊天", gift: "礼物", gift_progress: "礼物进度", like: "点赞", join: "加入", follow: "关注", share: "分享",
  room_stats: "房间统计", stream_end: "直播结束", social: "社交", unknown: "未知",
};
const sourceLabels: Record<string, string> = { tiktok: "TikTok", replay: "回放", simulator: "模拟器" };
const statusLabels: Record<string, string> = { idle: "待机", connecting: "连接中", connected: "已连接", disconnected: "已断开", offline: "已下线", error: "错误" };
const replayStateLabels: Record<string, string> = { idle: "待机", playing: "播放中", paused: "已暂停", stopped: "已停止", completed: "已完成" };
const events: EventRecord[] = [];
const filters = new Set(eventTypes.map(({ type }) => type));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const eventList = $("eventList");
const filterBar = $("filterBar");
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

function api(path: string, options: RequestInit = {}): Promise<any> {
  return fetch(`/api${path}`, { headers: { "content-type": "application/json" }, ...options }).then(async (response) => {
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error?.message ?? "Request failed");
    return body.data;
  });
}

function post(path: string, body?: unknown): Promise<any> {
  return api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

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
  if (event.type === "gift" || event.type === "gift_progress") return `${String(payload.giftName ?? payload.giftId ?? "gift")} ×${String(payload.count ?? 1)}`;
  if (event.type === "room_stats") return `${String(payload.viewerCount ?? "—")} viewers`;
  return "";
}

function renderEvents(): void {
  const visible = events.filter((event) => filters.has(event.type === "gift_progress" ? "gift" : event.type as EventType));
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
    const avatarHtml = event.user?.avatarUrl ? `<img class="user-avatar" src="${escapeHtml(event.user.avatarUrl)}" loading="lazy" alt="" />` : "";
    row.innerHTML = `<span class="event-time">${formatTime(event.receivedAt)}</span><span class="event-type">${eventTypeLabels[event.type] ?? event.type}</span><span class="event-user">${avatarHtml}<span>${escapeHtml(displayUser(event))}</span></span><span class="event-summary">${escapeHtml(displaySummary(event))}</span><span class="event-seq">#${event.sequence}</span>`;
    row.addEventListener("click", () => inspect(event));
    eventList.append(row);
  }
}

function addEvent(event: EventRecord): void {
  // Keep the in-memory queue newest-first so the event stream renders the latest event at the top.
  events.unshift(event);
  while (events.length > 1000) events.pop();
  renderEvents();
}

function inspect(event: EventRecord): void {
  $("selectedEventLabel").textContent = `${eventTypeLabels[event.type] ?? event.type} #${event.sequence}`;
  $("normalizedOutput").textContent = JSON.stringify(event, null, 2);
  $("rawOutput").textContent = JSON.stringify(event.raw ?? event.debug?.decoded ?? { message: "当前事件没有附加原始或解码数据。" }, null, 2);
}

function updateStatus(data: any): void {
  const source = data.sources?.tiktok ?? {};
  const status = String(source.status ?? "idle");
  $("statusText").textContent = statusLabels[status] ?? status;
  $("statusDot").className = `status-dot ${status}`;
  $("roomId").textContent = source.roomId ?? "—";
  const errorEl = $("errorText");
  if (status === "error" && source.error) {
    errorEl.hidden = false;
    errorEl.textContent = `连接失败：${source.error}`;
  } else if (status === "connected" || status === "idle") {
    if (errorEl.textContent.startsWith("连接失败：")) errorEl.hidden = true;
  }
  const duration = Number(data.stats?.connectedDurationSec ?? 0);
  $("duration").textContent = `${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
  $("recordingBadge").textContent = data.recording ? "录制中" : "未录制";
  $("recordingBadge").className = `recording-badge ${data.recording ? "active" : ""}`;
  $("recordButton").toggleAttribute("disabled", Boolean(data.recording));
  $("stopRecordButton").toggleAttribute("disabled", !data.recording);
  const stats = data.stats ?? {};
  for (const [id, value] of [["statChat", stats.chat], ["statGift", stats.gift], ["statLike", stats.like], ["statJoin", stats.join], ["statFollow", stats.follow], ["statShare", stats.share]]) $(id).textContent = String(value ?? 0);
  $("eventsPerSec").textContent = String(stats.eventsPerSec ?? 0);
  $("viewerCount").textContent = stats.viewerCount === undefined ? "—" : String(stats.viewerCount);
  $("totalLikes").textContent = stats.totalLikes === undefined ? "—" : String(stats.totalLikes);
  const replay = data.replay ?? {};
  $("replayState").textContent = replayStateLabels[String(replay.state ?? "idle")] ?? String(replay.state ?? "idle");
  $("replayProgress").textContent = `${replay.index ?? 0} / ${replay.total ?? 0}`;
  $("debugBadge").textContent = data.debug?.enabled ? "开启" : "关闭";
  if (data.debug?.latestDecoded !== undefined) $("debugOutput").textContent = JSON.stringify(data.debug.latestDecoded, null, 2);
}

async function refreshStatus(): Promise<void> {
  try { updateStatus(await api("/status")); } catch (error) { showError(error); }
}

async function refreshSessions(): Promise<void> {
  try {
    const sessions = await api("/sessions");
    const select = $("sessionSelect") as HTMLSelectElement;
    select.innerHTML = sessions.length ? sessions.map((session: any) => `<option value="${session.sessionId}">${new Date(session.startedAt).toLocaleString()} · ${sourceLabels[session.source] ?? session.source} · ${session.eventCount} 个事件</option>`).join("") : `<option value="">暂无录制会话</option>`;
  } catch (error) { showError(error); }
}

function showError(error: unknown): void {
  const el = $("errorText");
  el.hidden = false;
  el.textContent = error instanceof Error ? error.message : String(error);
  window.setTimeout(() => { el.hidden = true; }, 5000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

$("connectButton").addEventListener("click", async () => {
  try { await post("/connect", { username: ($("username") as HTMLInputElement).value }); await refreshStatus(); } catch (error) { showError(error); }
});
$("disconnectButton").addEventListener("click", async () => {
  try { await post("/disconnect"); await refreshStatus(); } catch (error) { showError(error); }
});
$("recordButton").addEventListener("click", async () => {
  try { await post("/recording/start"); await refreshStatus(); } catch (error) { showError(error); }
});
$("stopRecordButton").addEventListener("click", async () => {
  try { await post("/recording/stop"); await refreshStatus(); await refreshSessions(); } catch (error) { showError(error); }
});
$("clearButton").addEventListener("click", () => { events.length = 0; renderEvents(); });
$("replayPlayButton").addEventListener("click", async () => {
  try {
    const speedValue = ($("speedSelect") as HTMLSelectElement).value;
    const speed = speedValue === "MAX" ? "MAX" : Number(speedValue);
    await post("/replay/start", { sessionId: ($("sessionSelect") as HTMLSelectElement).value, speed });
    await refreshStatus();
  } catch (error) { showError(error); }
});
$("replayPauseButton").addEventListener("click", async () => { try { await post("/replay/pause"); await refreshStatus(); } catch (error) { showError(error); } });
$("replayStopButton").addEventListener("click", async () => { try { await post("/replay/stop"); await refreshStatus(); } catch (error) { showError(error); } });
$("replayRestartButton").addEventListener("click", async () => { try { await post("/replay/restart"); await refreshStatus(); } catch (error) { showError(error); } });

for (const button of document.querySelectorAll<HTMLButtonElement>(".simulator-action")) {
  button.addEventListener("click", async () => {
    const type = button.dataset.sim as string;
    const user = { uniqueId: ($("simUser") as HTMLInputElement).value, nickname: ($("simUser") as HTMLInputElement).value };
    const message: Record<string, unknown> = { type, user };
    if (type === "chat") message.text = ($("simText") as HTMLInputElement).value;
    if (type === "like") message.count = 8;
    if (type === "gift") Object.assign(message, { giftId: ($("simGiftId") as HTMLInputElement).value, giftName: ($("simGiftName") as HTMLInputElement).value, count: Number(($("simGiftCount") as HTMLInputElement).value), giftType: 0, repeatEnd: true, diamondCount: Number(($("simDiamondCount") as HTMLInputElement).value) });
    try { await post("/simulate", message); } catch (error) { showError(error); }
  });
}

function connectSocket(path: string, statusId: string, onMessage: (data: any) => void): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.hostname}:8765${path}`);
  socket.addEventListener("open", () => { $(statusId).textContent = `${path.includes("actions") ? "动作" : "事件"} WS：已连接`; $(statusId).className = "connection-pill connected"; });
  socket.addEventListener("close", () => { $(statusId).textContent = `${path.includes("actions") ? "动作" : "事件"} WS：已断开`; $(statusId).className = "connection-pill muted"; window.setTimeout(() => connectSocket(path, statusId, onMessage), 1500); });
  socket.addEventListener("error", () => socket.close());
  socket.addEventListener("message", (event) => { try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed frames */ } });
}

connectSocket("/events", "wsEventStatus", (message) => { if (message.op === "event") addEvent(message.event); if (message.op === "debug") $("debugOutput").textContent = JSON.stringify(message.data, null, 2); });
connectSocket("/actions", "wsActionStatus", (message) => { if (message.op === "action") { const action = message.action; $("selectedEventLabel").textContent = `动作：${action.action}`; } });
void refreshStatus();
void refreshSessions();
window.setInterval(() => void refreshStatus(), 1000);
window.setInterval(() => void refreshSessions(), 5000);
