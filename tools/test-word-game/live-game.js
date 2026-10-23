const state = { connection: 'connecting', room: {}, round: null, timeline: null, topGuesses: [], scoreboard: [], hintsUnlocked: 0, activity: null, metrics: {}, embedding: null, hintModel: null, socket: null };
const $ = (id) => document.getElementById(id);
const gameRoot = $('gameRoot'); const viewport = $('viewport');
const params = new URLSearchParams(location.search); if (params.get('lowEffects') === 'true') gameRoot.classList.add('low-effects'); if (params.get('transparent') === 'true') document.body.classList.add('transparent');
function fit() { gameRoot.style.transform = `scale(${Math.min(viewport.clientWidth / 1080, viewport.clientHeight / 2340)})`; } addEventListener('resize', fit); fit();
const fmt = (value) => Number(value || 0).toLocaleString();
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function safeUrl(value) { return /^https?:\/\//i.test(String(value || '')) ? String(value) : ''; }
function initials(item) { return String(item?.nickname || item?.uniqueId || '观').trim().slice(0, 1).toUpperCase(); }
function avatarHtml(item, className = 'avatar') { const url = safeUrl(item?.avatarUrl); return url ? `<img class="${className}" src="${escapeHtml(url)}" data-initial="${escapeHtml(initials(item))}" loading="lazy" alt="" onerror="const fallback=document.createElement('span');fallback.className=this.className+' avatar-fallback';fallback.textContent=this.dataset.initial;this.replaceWith(fallback)">` : `<span class="${className} avatar-fallback">${escapeHtml(initials(item))}</span>`; }
function actorName(actor) { return actor?.nickname || actor?.uniqueId || '直播间玩家'; }
function triggerLabel(trigger) { return ({gift:'礼物随机词',like:'点赞随机词',follow:'关注随机词',share:'分享随机词'})[trigger] || '聊天猜词'; }
function tierBadgeHtml(tier, compact = false) { const meta = ({ '青铜': ['✦', '青铜'], '白银': ['◆', '白银'], '黄金': ['★', '黄金'], '铂金': ['✧', '铂金'], '钻石': ['◇', '钻石'], '王者': ['♛', '王者'] })[tier] || ['✦', '青铜']; const className = compact ? 'score-tier' : 'tier-badge'; return `<span class="${className} rank-emblem rank-${escapeHtml(tier || '青铜')}"><i>${meta[0]}</i><b>${meta[1]}</b></span>`; }
let websocketPort = 8765;
async function loadRuntime() { try { const response = await fetch('/api/status', {signal:AbortSignal.timeout(5000)}); if (!response.ok) return; const body = await response.json(); websocketPort = Number(body.data?.runtime?.websocketPort || websocketPort); } catch { /* retry runtime discovery on reconnect */ } }
let reconnectTimer = 0, reconnectDelay = 1500, pageClosed = false, connecting = false;
async function connect() {
  if (pageClosed || connecting || state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  await loadRuntime(); connecting = false; if (pageClosed) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.hostname}:${websocketPort}/word-game`); state.socket = socket;
  socket.addEventListener('open', () => { state.connection = 'open'; reconnectDelay = 1500; });
  socket.addEventListener('close', () => { if (state.socket !== socket) return; state.connection = 'closed'; if (!pageClosed) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(30000, reconnectDelay * 2); } });
  socket.addEventListener('error', () => socket.close());
  socket.addEventListener('message', message => { try { applyMessage(JSON.parse(message.data)); } catch { /* ignore malformed server frames */ } });
}
addEventListener('pagehide', () => { pageClosed = true; clearTimeout(reconnectTimer); state.socket?.close(); });
addEventListener('pageshow', event => { if (event.persisted && !params.get('demo')) { pageClosed = false; void connect(); } });
function applyMessage(message) {
  if (message.type === 'GIFT_RECEIVED') { overlays.gifts.receive(message); return; }
  if (message.type === 'ROOM_SNAPSHOT') { if (state.round?.roundId !== message.round?.roundId) { clearInteractionEffects(); resetRoundPresentation(); } Object.assign(state, { room: message.room || {}, round: message.round || null, timeline: message.timeline || null, topGuesses: message.topGuesses || [], scoreboard: message.scoreboard || [], hintsUnlocked: message.hintsUnlocked || 0, activity: message.activity, metrics: message.metrics || {}, embedding: message.embedding || null, hintModel: message.hintModel || null }); if (message.lastSettlement) lastResult = message.lastSettlement; renderAll(); if (message.round?.status === 'SETTLEMENT' && lastResult?.round?.roundId === message.round.roundId) renderSettlement(lastResult); return; }
  if (message.type === 'TIMER_TICK') { if (state.round && state.round.roundId === message.roundId) { state.round.status = message.status; state.timeline = message.timeline || state.timeline; state.hintsUnlocked = message.hintsUnlocked ?? state.hintsUnlocked; renderRound(); renderTimeline(); renderHints(); } return; }
  if (message.type === 'ROOM_STATS') { state.room.viewerCount = message.viewerCount; state.room.totalLikes = message.totalLikes; state.metrics = message.metrics || state.metrics; state.hintsUnlocked = message.hintsUnlocked ?? state.hintsUnlocked; renderHints(); return; }
  if (message.type === 'GUESS_ACCEPTED') {
    if (state.round && message.round?.roundId && state.round.roundId !== message.round.roundId) { clearInteractionEffects(); resetRoundPresentation(); }
    state.round = message.round; state.topGuesses = message.topGuesses || []; state.scoreboard = message.scoreboard || []; state.metrics = message.metrics || {};
    for (const guess of message.recentGuesses || (message.guess ? [message.guess] : [])) receiveGuessEffect({ ...guess, triggerType: guess.triggerType || message.triggerType || 'chat' });
    scheduleRender(); return;
  }
  if (message.type === 'GUESS_REJECTED') { if (!message.silent && !['empty', 'not_word', 'length_mismatch', 'cooldown'].includes(message.reason)) toast('未计入榜单', rejectText(message.reason)); return; }
  if ((message.type === 'ROOM_ERROR' || message.type === 'LLM_WORD_GENERATION_FAILED' || message.type === 'LLM_WORD_GENERATION_PARTIAL') && String(message.code || '').match(/^(HY3_HINT_GENERATION_|LLM_WORD_GENERATION_)/)) { toast('模型生成随机词', message.message || '模型没有返回可用随机词'); return; }
  if (message.type === 'HINT_UNLOCKED') { state.hintsUnlocked = message.level || state.hintsUnlocked; state.round = message.round || state.round; state.timeline = message.timeline || state.timeline; overlays.event('hint', `新提示解锁 · ${message.hint?.label || '提示'}`, message.hint?.value || '新线索', '记住线索，继续抢答'); renderAll(); return; }
  if (message.type === 'ROUND_STARTED') { clearInteractionEffects(); resetRoundPresentation(); state.round = message.round; state.timeline = null; state.topGuesses = []; state.hintsUnlocked = 0; state.metrics = {}; $('winnerModal').classList.add('hidden'); overlays.game.start(message.round); renderAll(); return; }
  if (message.type === 'ROUND_ANSWERED') { state.round = message.round; overlays.correct(message.winner, message.round); renderAll(); return; }
  if (message.type === 'ROUND_TIMEOUT') { state.round = message.round; overlays.event('timeout', '回合结束', '本轮时间到', '正在结算 · 答案即将揭晓', 90, 2400); renderAll(); return; }
  if (message.type === 'ROUND_SETTLED') { state.round = message.round; state.scoreboard = message.scoreboard || []; state.topGuesses = message.topGuesses || []; showSettlement(message); renderAll(); return; }
  if (message.type === 'ROUND_SKIPPED') { state.round = message.round; overlays.event('timeout', '回合结束', '本轮已跳过', '等待结算', 90); renderAll(); return; }
  if (message.type === 'GIFT_EFFECT') { state.round = message.round || state.round; overlays.tick(); flashAbility(message.triggerType || 'gift'); overlays.event('extra-time', ({like:'点赞助力',follow:'关注助力',share:'分享助力'})[message.triggerType] || '礼物助力', `+${Number(message.seconds || 0)} 秒`, '抓住新的机会', 65, 1600); renderAll(); return; }
  if (message.type === 'ACTIVITY') { state.activity = message; renderActivity(); }
}
function rejectText(reason) { return ({ empty: '消息为空', not_word: '消息没有可计算的文本', round_not_running: '当前不在猜词阶段' })[reason] || '当前猜词未被接受'; }
function renderAll() { renderRound(); renderTimeline(); renderGuesses(); renderScoreboard(); renderHints(); renderPreviousResult(); }
function renderRound() { renderRoundStatus(); }
function renderTimeline() { renderHintStatus(); }
function guessModeLabel(guess) { return ({gift:'礼物猜词',like:'点赞猜词',follow:'关注猜词',share:'分享猜词'})[guess.triggerType] || '聊天猜词'; }
function renderGuesses() { renderGuessCards(); }
function renderScoreboard() { renderScoreCards(); }
function renderActivity() { /* Social activity stays in the operator event stream. */ }
function renderHints() { renderHintStatus(); }
function showSettlement(message) { renderSettlement(message); }
function toast(title, text) { if (!overlays.celebration.active && !overlays.resultActive) overlays.toast.show(title, text); }
