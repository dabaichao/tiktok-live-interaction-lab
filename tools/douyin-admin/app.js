const $ = (id) => document.getElementById(id);
const taskLabels = { idle:"未启动", starting:"启动中", running:"运行中", stopping:"停止中", error:"异常" };
let webcastClient;
let webcastDelivery;
let webcastToken = "";
let restoredRoom = false;
let connectionGeneration = 0;
let autoLoginChecked = false;
let loginRequestPending = false;
let loginGeneration = 0;
let pendingLoginId = "";
let refreshing = false;
let quickMode = true;

function closeWebcastClient() {
  connectionGeneration++;
  const client = webcastClient;
  webcastClient = undefined;
  webcastToken = "";
  webcastDelivery?.cancel();
  webcastDelivery = undefined;
  client?.close?.();
}

function feedback(message, kind = "", target = "feedback") {
  $(target).textContent = message;
  $(target).className = `feedback ${kind}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers:{ "content-type":"application/json", ...(options.headers || {}) }, ...(typeof AbortSignal !== 'undefined' ? {signal:AbortSignal.timeout(20000)} : {}), ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || data.error || `请求失败（${response.status}）`); error.status = response.status; throw error; }
  return data;
}

function render(data) {
  const source = data.sources?.douyin || {};
  const connected = data.activeSource === "douyin";
  const mode = data.connectionMode;
  $("statusText").textContent = connected ? `已连接 ${mode === "webcast" ? "Webcast" : "官方通道"}` : source.status === "connecting" ? "连接中" : source.status === "error" ? "连接异常" : source.status === "disconnected" ? "直播数据已断开" : "未启动";
  $("statusDot").className = connected ? "running" : source.status === "error" ? "error" : "";
  $("modeText").textContent = mode === "webcast" ? "Webcast 快速连接" : mode === "official" ? "官方小玩法" : "等待连接";
  $("roomText").textContent = data.douyin?.webcast?.title || data.roomId || data.douyin?.webcast?.webRid || "—";
  const received = Number(data.stats?.webcastMessages || data.stats?.acceptedCallbacks || 0);
  $("messageText").textContent = received ? `已接收 ${received.toLocaleString()} 条` : "未接收";
  const tasks = data.douyin?.tasks || {};
  for (const type of ["live_comment","live_like","live_gift"]) {
    const task = tasks[type] || { status:"idle" };
    $(`task-${type}`).className = task.status === "running" ? "running" : task.status === "error" ? "error" : "";
    $(`taskText-${type}`).textContent = taskLabels[task.status] || task.status;
    $(`taskText-${type}`).title = task.error || task.taskId || "";
  }
  const stats = data.stats || {};
  $("chatCount").textContent = Number(stats.chat || 0).toLocaleString();
  $("likeCount").textContent = Number(stats.like || 0).toLocaleString();
  $("giftCount").textContent = Number(stats.gift || 0).toLocaleString();
  $("duplicateCount").textContent = Number(stats.duplicateMessages || data.douyin?.webcast?.duplicateMessages || 0).toLocaleString();
  const lastAt = mode === "webcast" ? data.douyin?.webcast?.lastMessageAt : data.douyin?.lastCallbackAt;
  $("lastCallback").textContent = lastAt ? `最后互动 ${new Date(lastAt).toLocaleTimeString()}` : "尚未收到互动";
  $("officialLastCallback").textContent = data.douyin?.lastCallbackAt ? `最后回调 ${new Date(data.douyin.lastCallbackAt).toLocaleTimeString()}` : "尚未收到回调";
  if (data.roomId && !$("roomId").value) $("roomId").value = data.roomId;
  if (data.appId && !$("appId").value) $("appId").value = data.appId;
  if (!restoredRoom) { if (!$("webcastRoom").value) $("webcastRoom").value = data.douyin?.webcast?.webRid || ''; restoredRoom = true; }
  renderWebcastDiagnostics(data);
  renderLogin(data.douyin?.login);
  const account = data.douyin?.webcastConnection?.cookie;
  $('loginPersistenceNotice').textContent = account?.persistence
    ? '记住登录已启用：使用 Windows 当前账号加密保存，重启自动恢复；保存是否成功以下方账号状态为准。'
    : '当前服务尚未启用加密登录缓存，请重启到新版后再扫码；旧版登录态仍只保存在本次运行内存。';
  const loginBusy = ['opening','waiting-user','syncing'].includes(data.douyin?.login?.phase);
  if(account?.hasLoginSession && !loginBusy) {
    const restored = account.persistence?.state === 'restored';
    $('loginTitle').textContent = restored ? '已恢复上次登录' : '登录态已获取';
    $('loginMessage').textContent = account.persistence?.message || '当前登录态保存在本机。停止数据、切换直播间不会退出账号。';
    $('loginStart').textContent = '重新扫码 / 更换账号';
  } else if (!loginBusy && account?.persistence && ['expired','rejected','error'].includes(account.persistence.state)) {
    $('loginTitle').textContent = '需要重新登录';
    $('loginMessage').textContent = account.persistence.message;
    $('loginStart').textContent = '重新扫码登录';
  }
  globalThis.douyinOperations?.onStatus(data);
}

function renderLogin(login) {
  if (!login) return;
  const titles = { idle:'抖音登录助手', opening:'正在打开登录窗口', 'waiting-user':'等待你扫码确认', syncing:'正在同步登录态', ready:'登录态已获取', cancelled:'登录已取消', expired:'扫码等待超时', error:'登录助手暂不可用' };
  const busy = ['opening', 'waiting-user', 'syncing'].includes(login.phase);
  $('loginTitle').textContent = titles[login.phase] || '抖音登录助手';
  $('loginMessage').textContent = login.message || '';
  $('loginStart').disabled = loginRequestPending;
  $('loginStart').textContent = busy ? '显示登录窗口' : login.phase === 'ready' ? '重新扫码 / 更换账号' : '扫码登录并连接';
  $('loginCancel').disabled = !busy;
}

async function beginLogin(automatic = false) {
  if (loginRequestPending) return;
  autoLoginChecked = true;
  loginRequestPending = true;
  const generation = ++loginGeneration;
  $('loginStart').disabled = true;
  try {
    const result = await api('/api/douyin/webcast/login/start', { method:'POST', body:JSON.stringify({ automatic }) });
    if (generation !== loginGeneration) return;
    renderLogin(result.login);
    // Only the initiating tab automatically connects; other tabs just display
    // status or focus the same window, never reset the game a second time.
    if (result.created && ['opening','waiting-user','syncing'].includes(result.login?.phase)) pendingLoginId = result.login.attemptId;
  } catch (error) { feedback(error.message, 'error', 'webcastFeedback'); }
  finally { loginRequestPending = false; $('loginStart').disabled = false; }
}

function abandonPendingLogin() { ++loginGeneration; pendingLoginId = ''; autoLoginChecked = true; }

async function reconcileLogin(data) {
  const login = data.douyin?.login;
  if (!login || !quickMode) return;
  if (pendingLoginId && login.attemptId === pendingLoginId) {
    if (login.phase === 'ready') {
      pendingLoginId = '';
      if ($('webcastRoom').value.trim()) await connectWebcast();
      else feedback('登录态已自动获取。请输入直播间链接，再点击「连接直播」。', 'success', 'webcastFeedback');
    } else if (['cancelled','expired','error'].includes(login.phase)) pendingLoginId = '';
  }
  if (!autoLoginChecked) {
    autoLoginChecked = true;
    if (login.available && login.phase === 'idle' && !data.douyin?.webcastConnection?.cookie?.hasLoginSession && data.connectionMode !== 'official') await beginLogin(true);
  }
}

function renderWebcastDiagnostics(data) {
  const connection = data.douyin?.webcastConnection || {};
  const cookie = connection.cookie || {};
  const transport = connection.transport || {};
  const webcast = data.douyin?.webcast || {};
  const decoder = webcast.decoder || {};
  const raw = decoder.rawMethods || {};
  const decoded = decoder.decodedMethods || {};
  const accepted = webcast.acceptedByMethod || {};
  const failures = decoder.decodeErrors || {};
  const failureReasons = decoder.decodeFailureReasons || {};
  const reasonLabels = {
    like_payload_decode_failed:'点赞载荷解析失败', like_count_invalid:'点赞计数无效', like_count_zero:'点赞计数为零或缺省',
    like_user_mapping_failed:'点赞用户映射失败', like_event_mapping_failed:'点赞事件映射失败',
    upstream_decoder_failed:'上游解码器异常（未细分）', upstream_decoder_returned_empty:'上游未返回事件（未细分）',
    gift_postprocess_failed:'礼物后处理失败', social_postprocess_failed:'社交后处理失败',
  };
  const dropped = decoder.droppedMethods || {};
  $('cookieState').textContent = cookie.persistence?.message
    ? `${cookie.persistence.message}${cookie.hasLoginSession ? ' 停止采集、切换直播间不会退出；平台有效性与礼物通道仍以实际消息为准。' : ''}`
    : cookie.hasLoginSession ? '登录态仅保存在本次运行中；平台有效性尚未验证。' : cookie.configured ? '已提供 Cookie，但未发现登录字段；请扫码登录。' : '尚未获取登录态 · 可点击扫码登录；匿名方式可能收不到礼物。';
  const giftRaw = Number(raw.WebcastGiftMessage || 0);
  const giftAccepted = Number(accepted.WebcastGiftMessage || 0);
  $('giftState').textContent = giftAccepted ? `礼物通道：本连接已接收 ${giftAccepted} 条礼物消息（含连击进度），接收链路已验证。` : giftRaw ? `礼物通道：原始收到 ${giftRaw} 条，但尚未进入后台；请查看解码失败数。` : cookie.hasLoginSession ? '礼物通道：已提供登录字段，尚未收到礼物；不能据此认定 Cookie 有效或失效。' : '礼物通道：缺少登录态；请在上方扫码登录后连接。';
  const likeMethods = ['WebcastLikeMessage', 'WebcastChatLikeMessage'];
  const likeRaw = likeMethods.reduce((sum, method) => sum + Number(raw[method] || 0), 0);
  const likeAccepted = likeMethods.reduce((sum, method) => sum + Number(accepted[method] || 0), 0);
  $('likeState').textContent = likeAccepted ? `点赞通道：本连接已接收 ${likeAccepted} 条点赞事件。` : likeRaw ? `点赞通道：原始收到 ${likeRaw} 条，尚未进入后台；请查看解码失败数。` : '点赞通道：尚未观测到原始点赞消息；现已支持两种点赞消息类型，不用房间总数伪造用户点赞。';
  const maskedNames = Number(webcast.maskedNicknameMessages || 0);
  const limitedIds = Number(webcast.limitedIdentityMessages || 0);
  $('identityState').textContent = maskedNames
    ? `观众身份：平台已返回 ${maskedNames} 条脱敏昵称事件；不同脱敏名会分开计分，同名脱敏观众无法可靠区分。`
    : limitedIds ? `观众身份：${limitedIds} 条事件未提供可用账号 ID，已使用稳定的本地匿名身份分组。` : '观众身份：尚未发现平台脱敏或占位用户 ID。';
  const transportLabels = { idle:'未连接', connecting:'握手中', connected:'已连接', disconnected:'已断开', error:'连接失败' };
  const handshake = transport.handshake;
  const handshakeText = handshake
    ? ` · 签名${handshake.signaturePresent ? `有效(${handshake.signatureLength})` : '缺失'} · 身份 ${handshake.identity || '未声明'} · ${handshake.cookieAttached ? '已注入登录态' : '未注入登录态'}`
    : '';
  $('transportState').textContent = `抖音上游：${transportLabels[transport.state] || '等待状态'} · 收到 ${Number(transport.frames || 0)} 帧${handshakeText}`;
  $('diagnosticSummary').textContent = `浏览器解析 ${Number(decoder.frames || 0)} 帧 · 帧解压/解析失败 ${Number(decoder.frameErrors || 0)} 次`;
  const methods = [...new Set([...Object.keys(raw), ...Object.keys(decoded), ...Object.keys(accepted), ...Object.keys(failures), ...Object.keys(dropped)])].sort();
  $('diagnosticMethods').textContent = methods.length ? methods.map(method => {
    const stages = Object.entries(reasonLabels).filter(([key]) => Number(failureReasons[method]?.[key]) > 0)
      .map(([key,label]) => `${label} ${failureReasons[method][key]}`).join(' · ');
    const stageText = stages ? `\n  失败阶段：${stages}` : Number(failures[method]) > 0 ? '\n  失败阶段：未上报，无法追溯旧记录' : '';
    return `${method}\n  原始 ${raw[method] || 0} → 解码 ${decoded[method] || 0} → 接收 ${accepted[method] || 0} · 解析失败 ${failures[method] || 0} · 未支持 ${dropped[method] || 0}${stageText}`;
  }).join('\n') : '尚无原始消息类型记录；请保持本后台打开。';
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const client = webcastClient, token = webcastToken;
    if (client?.getDiagnostics && token) {
      try { await api('/api/douyin/webcast/diagnostics', { method:'POST', body:JSON.stringify({ sessionToken:token, diagnostics:{...client.getDiagnostics(),delivery:webcastDelivery?.diagnostics()} }) }); }
      catch (error) { if (error.status === 401 && token === webcastToken) closeWebcastClient(); }
    }
    const data = await api("/api/status");
    if (data.douyin?.webcast?.ended && token === webcastToken) closeWebcastClient();
    render(data);
    await reconcileLogin(data);
  } catch (error) { feedback(error.message, "error", 'webcastFeedback'); }
  finally { refreshing = false; }
}

function showMode(mode) {
  const quick = mode === "quick";
  quickMode = quick;
  if (!quick) abandonPendingLogin();
  $("showQuick").classList.toggle("active", quick);
  $("showOfficial").classList.toggle("active", !quick);
  $("quickPanel").classList.toggle("hidden", !quick);
  $("officialPanel").classList.toggle("hidden", quick);
  $("officialNotice").classList.toggle("hidden", quick);
}

async function reportWebcastState(token, status, extra = {}) {
  if (!token || token !== webcastToken) return;
  try { await api("/api/douyin/webcast/state", { method:"POST", body:JSON.stringify({ sessionToken:token, state:{ status, ...extra } }) }); } catch { /* stale session */ }
}

// One bounded FIFO per connection. Keep the same identifiers across uncertain
// HTTP replies; the source deduplicates them before effect execution.
class WebcastDeliveryQueue {
  constructor(token, current, accepted, failed) {
    Object.assign(this, { token, current, accepted, failed });
    this.batches = []; this.messages = 0; this.bytes = 0;
    this.sequence = 0; this.retryCount = 0; this.overflowMessages = 0;
    this.active = false; this.cancelled = false;
  }
  diagnostics() {
    return { pendingMessages:this.messages, pendingBytes:this.bytes, retryCount:this.retryCount, overflowMessages:this.overflowMessages, oldestPendingMs:this.batches.length ? Date.now()-this.batches[0].at : 0 };
  }
  cancel() {
    this.cancelled = true; this.batches = []; this.messages = 0; this.bytes = 0;
    if (typeof clearTimeout==='function') clearTimeout(this.timer); this.wake?.();
  }
  enqueue(messages) {
    if (this.cancelled || !this.current()) return;
    if(this.messages+messages.length>20000) {this.overflow(messages.length);return;}
    const batches = [];
    let bytes = 0;
    for (let offset=0; offset<messages.length; offset+=500) {
      const items=messages.slice(offset,offset+500).map(message=>({...message,bridgeId:message.bridgeId || `bridge-${this.token}-${++this.sequence}`}));
      const body=JSON.stringify({sessionToken:this.token,messages:items});
      const size=body.length*2; // Conservative bound on retained UTF-16 strings.
      bytes+=size;
      if(this.bytes+bytes>8*1024*1024) {this.overflow(messages.length);return;}
      batches.push({body,size,count:items.length,at:Date.now(),items});
    }
    if (this.messages+messages.length>20000 || this.bytes+bytes>8*1024*1024) {
      this.overflow(messages.length); return;
    }
    this.batches.push(...batches); this.messages+=messages.length; this.bytes+=bytes;
    void this.pump();
  }
  overflow(count) {
    const outstanding=this.messages+count;
    this.overflowMessages+=count;
    this.failed(`本机转发积压达到保护上限，已停止采集；${outstanding} 条消息未确认送达，请先恢复服务再连接。不会把它们标成已完成。`,true);
    this.cancel();
  }
  async pump() {
    if (this.active) return;
    this.active=true;
    try {
      let failures=0;
      while (!this.cancelled && this.current() && this.batches.length) {
        const batch=this.batches[0];
        try {
          const result=await api('/api/douyin/webcast/events',{method:'POST',body:batch.body});
          if (this.cancelled || !this.current()) return;
          this.batches.shift(); this.messages-=batch.count; this.bytes-=batch.size;
          failures=0;
          await this.accepted(result,batch.items);
        } catch (error) {
          if (this.cancelled || !this.current()) return;
          const retryable=!error.status || error.status===408 || error.status===429 || error.status>=500;
          this.failed(retryable ? `转发暂时失败，保留 ${this.messages} 条待确认消息并自动重试。` : `会话或请求失效，${this.messages} 条消息未确认送达；请重新连接。`, !retryable);
          if (!retryable) { this.cancel(); return; }
          this.retryCount++; failures++;
          await new Promise(resolve=>{
            this.wake=resolve;
            this.timer=setTimeout(resolve,Math.min(5000,250*2**Math.min(failures-1,5)));
          });
          this.wake=undefined;
        }
      }
    } finally { this.active=false; }
  }
}

async function connectWebcast() {
  const input = $("webcastRoom").value.trim();
  if (!input) return feedback("请输入抖音直播间链接或 web_rid。", "error", "webcastFeedback");
  if ($("webcastStart").disabled) return;
  $("webcastStart").disabled = true;
  let generation = connectionGeneration;
  try {
    // Load first: a missing client dependency must not reset the running game.
    feedback("正在加载抖音连接组件……", "", "webcastFeedback");
    let DyCast;
    try {
      ({ DyCast } = await import("/vendor/dycast/index.mjs?v=diagnostics-2"));
      if (typeof DyCast !== "function") throw new Error("Missing DyCast export");
    } catch (error) {
      console.error("[Douyin] Webcast client module failed to load", error);
      feedback("抖音连接组件加载失败，请刷新页面后重试；若仍失败，请检查抖音后台服务。", "error", "webcastFeedback");
      return;
    }
    if (generation !== connectionGeneration) return;
    closeWebcastClient();
    generation = connectionGeneration;
    feedback("正在初始化 Webcast 快速连接……", "", "webcastFeedback");
    const result = await api("/api/douyin/webcast/start", { method:"POST", body:JSON.stringify({ url:input, cookie:$("webcastCookie").value }) });
    if (generation !== connectionGeneration) return;
    webcastToken = result.connection.sessionToken;
    const token = webcastToken;
    const webRid = result.connection.webRid;
    $("webcastCookie").value = "";
    const client = new DyCast(webRid);
    webcastClient = client;
    const isCurrent = () => webcastClient === client && webcastToken === token;
    let confirmed = false;
    const delivery=new WebcastDeliveryQueue(token,isCurrent,async(result,messages)=>{
      const ended=result.ended || messages.some(message=>message.method==='WebcastControlMessage' && Number(message.room?.status)>=3);
      if (ended) {
        await reportWebcastState(token,'disconnected',{message:'直播已结束，旧连接已关闭。'});
        if (isCurrent()) closeWebcastClient();
        feedback('直播已结束，旧连接已关闭；登录缓存保留。','','webcastFeedback');
        return;
      }
      if (!confirmed && result.accepted>0 && isCurrent()) {
        confirmed=true;
        await reportWebcastState(token,'connected',{message:'已收到抖音真实互动消息'});
        feedback('已收到抖音真实互动；礼物接收情况请查看下方独立状态。','success','webcastFeedback');
      }
    },(message,terminal)=>{
      feedback(message,'error','webcastFeedback');
      if (terminal && isCurrent()) { client.close(); void reportWebcastState(token,'error',{message}); }
    });
    webcastDelivery=delivery;
    client.on("open", (_event, info) => {
      if (!isCurrent()) return;
      reportWebcastState(token, "connecting", { roomId:info?.roomId, title:info?.title, message:"本地通道已就绪，等待抖音真实消息" });
      feedback(`正在等待抖音消息：${info?.title || webRid}`, "", "webcastFeedback");
    });
    client.on("message", (messages) => {
      if (!isCurrent() || !Array.isArray(messages) || !messages.length) return;
      delivery.enqueue(messages);
    });
    client.on("reconnecting", (count) => { if (!isCurrent()) return; confirmed = false; reportWebcastState(token, "reconnecting", { reconnectCount:Number(count || 0), message:`正在第 ${count || 1} 次重连` }); });
    client.on("reconnect", () => { if (!isCurrent()) return; confirmed = false; reportWebcastState(token, "connecting", { message:"Webcast 正在等待重连后的真实消息" }); });
    client.on("close", (code) => { if (isCurrent()) reportWebcastState(token, "disconnected", { message:`连接已断开（${code || "—"}）` }); });
    client.on("error", (error) => {
      if (!isCurrent()) return;
      reportWebcastState(token, "error", { message:error?.message || "Webcast 连接失败" });
      feedback(error?.message || "Webcast 连接失败", "error", "webcastFeedback");
    });
    await client.connect();
  } catch (error) {
    await reportWebcastState(webcastToken, "error", { message:error.message });
    feedback(error.message, "error", "webcastFeedback");
  } finally {
    $("webcastStart").disabled = false;
  }
}

$("showQuick").addEventListener("click", () => showMode("quick"));
$("showOfficial").addEventListener("click", () => showMode("official"));
$('loginStart').addEventListener('click', () => beginLogin(false));
$('loginCancel').addEventListener('click', async () => {
  abandonPendingLogin();
  try { renderLogin((await api('/api/douyin/webcast/login/cancel', { method:'POST', body:'{}' })).login); }
  catch (error) { feedback(error.message, 'error', 'webcastFeedback'); }
});
$("webcastStart").addEventListener("click", () => { abandonPendingLogin(); return connectWebcast(); });
$("clearWebcastCookie").addEventListener("click", async () => {
  if (!confirm('清除登录态会同时断开抖音数据连接，确定继续吗？')) return;
  abandonPendingLogin();
  closeWebcastClient();
  $('webcastCookie').value = '';
  try { render(await api('/api/douyin/webcast/cookie', { method:'DELETE' })); feedback('本机加密缓存和内存登录态均已清除，抖音已断开。', 'success', 'webcastFeedback'); } catch (error) { feedback(error.message, 'error', 'webcastFeedback'); }
});
$("quickStop").addEventListener("click", async () => {
  abandonPendingLogin();
  closeWebcastClient();
  try { await api('/api/douyin/stop', { method:'POST', body:'{}' }); await refresh(); feedback('抖音数据已停止，登录态保留；需要清除时点击「退出账号并断开」。', 'success', 'webcastFeedback'); } catch (error) { feedback(error.message, 'error', 'webcastFeedback'); }
});

$("startButton").addEventListener("click", async () => {
  try {
    abandonPendingLogin();
    closeWebcastClient();
    let giftCatalog;
    if ($("giftCatalog").value.trim()) giftCatalog = JSON.parse($("giftCatalog").value);
    feedback("正在向抖音启动评论、点赞、礼物三项任务……");
    const data = await api("/api/douyin/start", { method:"POST", body:JSON.stringify({ roomId:$("roomId").value, appId:$("appId").value, accessToken:$("accessToken").value, pushSecret:$("pushSecret").value, giftCatalog }) });
    $("accessToken").value = "";
    $("pushSecret").value = "";
    render(data);
    feedback("官方数据任务已启动，游戏已开启新一局。", "success");
  } catch (error) { feedback(error instanceof SyntaxError ? "礼物 ID 映射不是有效 JSON。" : error.message, "error"); }
});

$("restartButton").addEventListener("click", async () => {
  try { await api("/api/game/start", { method:"POST", body:"{}" }); feedback("游戏已重新开局。", "success"); } catch (error) { feedback(error.message, "error"); }
});

$("stopButton").addEventListener("click", async () => {
  try { abandonPendingLogin(); closeWebcastClient(); render(await api("/api/douyin/stop", { method:"POST", body:"{}" })); feedback("抖音数据已停止，TikTok 服务未受影响。", "success"); } catch (error) { feedback(error.message, "error"); }
});

$("callbackUrl").textContent = `${location.origin}/api/douyin/events`;
$("copyButton").addEventListener("click", async () => { await navigator.clipboard.writeText($("callbackUrl").textContent); feedback("回调地址已复制。", "success"); });
refresh();
setInterval(refresh, 2000);
