// A body portal keeps animation layers out of the scaled/clipped game tree.
class MotionSurface {
  constructor(host) { this.host = host; this.animations = new Set(); this.timers = new Set(); }
  later(fn, ms) { const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms); this.timers.add(id); return id; }
  move(node, frames, options) {
    if (effectsOff()) return null;
    const animation = node.animate(frames, options); this.animations.add(animation);
    animation.onfinish = () => this.animations.delete(animation);
    animation.oncancel = () => this.animations.delete(animation);
    return animation;
  }
  clear() { this.timers.forEach(clearTimeout); this.timers.clear(); this.animations.forEach(a => a.cancel()); this.animations.clear(); this.host.replaceChildren(); }
}

class ToastManager extends MotionSurface {
  show(title, detail) {
    this.clear(); const card = document.createElement('div'); card.className = 'ordinary-toast';
    card.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
    this.host.append(card); this.move(card, [{ opacity: 0, transform: 'translateY(15px)' }, { opacity: 1, transform: 'none' }], { duration: 180 });
    this.later(() => this.clear(), 2800);
  }
}

class GameEventOverlay extends MotionSurface {
  constructor(host, manager) { super(host); this.manager = manager; this.priority = 0; this.kind = ''; }
  clear() { super.clear(); this.priority = 0; this.kind = ''; }
  show(kind, title, value, detail = '', priority = 70, duration = 2100, onDone = null) {
    if (this.manager.resultActive || this.manager.celebration.active || priority < this.priority) return false;
    this.clear(); this.priority = priority; this.kind = kind;
    const stage = document.createElement('div'); stage.className = `game-event event-${kind}`;
    stage.innerHTML = `<div class="game-event-card"><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
    this.host.append(stage); const card = stage.firstElementChild;
    const end = kind === 'hint' ? 'translateY(-640px) scale(.22)' : 'scale(1.18)';
    this.move(card, [{ opacity: 0, transform: 'scale(1.5)' }, { opacity: 1, transform: 'scale(.96)', offset: .13 }, { opacity: 1, transform: 'scale(1)', offset: .27 }, { opacity: 1, transform: 'scale(1)', offset: .8 }, { opacity: 0, transform: end }], { duration, easing: 'ease-out', fill: 'both' });
    this.later(() => { this.clear(); if (onDone) onDone(); else this.manager.drain(); }, duration); return true;
  }
  start(round) {
    if (this.manager.celebration.active) { this.manager.pendingStart = round; return; }
    const steps = ['3', '2', '1', '开猜！']; let step = 0;
    const next = () => {
      if (state.round?.roundId !== round.roundId || state.round?.status !== 'RUNNING') return;
      const current = step++;
      this.show('start', `第 ${round.roundNo} 局 · 抢答开始`, steps[current], `发送 ${round.answerLength || '对应字数'} 字词语，抢先命中`, 75, current === 3 ? 1000 : 750, current < 3 ? next : null);
    }; next();
  }
}

class OverlayManager {
  constructor() {
    this.portal = document.createElement('div'); this.portal.id = 'overlayPortal'; this.portal.className = 'overlay-portal';
    this.plane = document.createElement('div'); this.plane.className = 'overlay-plane'; this.portal.append(this.plane); document.body.append(this.portal);
    const layer = (name, z) => { const el = document.createElement('div'); el.className = `overlay-layer ${name}`; el.style.zIndex = z; this.plane.append(el); return el; };
    this.toast = new ToastManager(layer('toast-host', 3000));
    this.gifts = new GiftBarrage($('giftDanmaku'), this);
    this.game = new GameEventOverlay(layer('event-host', 6000), this);
    this.celebration = new CelebrationOverlay(layer('celebration-host', 7000), this);
    this.result = layer('result-host', 8000); this.result.append($('winnerModal'));
    this.resultActive = false; this.pending = []; this.correctRound = null; this.countSecond = null; this.countRound = null; this.lastLength = null;
    this.sync = () => { const r = viewport.getBoundingClientRect(); Object.assign(this.portal.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }); this.plane.style.transform = `scale(${r.width / 1080})`; };
    addEventListener('resize', this.sync); this.sync();
    this.clock = setInterval(() => this.tick(), 100);
    reducedMotion.addEventListener('change', () => {
      if (!effectsOff()) return;
      [this.toast, this.game, this.celebration, this.gifts].forEach(surface => { surface.animations.forEach(animation => animation.cancel()); surface.animations.clear(); });
      if (this.gifts.active) this.gifts.active.element.style.transform = 'none';
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.game.clear(); this.toast.clear(); this.gifts.suspend(); } });
  }
  reset() { this.game.clear(); this.toast.clear(); if (!this.celebration.active || performance.now() - this.celebration.startedAt >= 2000) this.celebration.clear(); this.resultActive = false; this.pending = []; this.pendingStart = null; this.countSecond = null; this.countRound = state.round?.roundId; this.lastLength = null; }
  event(kind, title, value, detail = '', priority = 70, duration = 2100) {
    if (!this.game.show(kind, title, value, detail, priority, duration) && !this.resultActive && !this.celebration.active && kind === 'hint') {
      this.pending.push({ kind, title, value, detail, priority, duration, expires: Date.now() + 5000, roundId: state.round?.roundId }); this.pending = this.pending.slice(-4);
    }
  }
  drain() {
    if (this.pendingStart && !this.celebration.active) { const round = this.pendingStart; this.pendingStart = null; if (state.round?.roundId === round.roundId && state.round?.status === 'RUNNING') { this.game.start(round); return; } }
    while (this.pending.length) { const item = this.pending.shift(); if (item.expires > Date.now() && item.roundId === state.round?.roundId) { this.event(item.kind, item.title, item.value, item.detail, item.priority, item.duration); return; } }
  }
  correct(winner, round) {
    if (!winner || this.correctRound === round?.roundId) return;
    this.correctRound = round?.roundId; this.pending = []; this.game.clear(); this.toast.clear();
    this.celebration.show(winner); this.gifts.holdUntil = performance.now() + 800;
  }
  settled(message) { this.game.clear(); this.toast.clear(); this.pending = []; if (message.winner) this.correct(message.winner, message.round); this.resultActive = true; }
  tick() {
    const round = state.round;
    if (!round || round.status !== 'RUNNING' || this.resultActive || this.celebration.active || document.hidden) return;
    if (this.countRound !== round.roundId) { this.countRound = round.roundId; this.countSecond = null; this.lastLength = round.answerLength; }
    const seconds = Math.ceil(Math.max(0, round.endsAt - Date.now()) / 1000);
    if (seconds > 10) { if (['countdown','ending'].includes(this.game.kind)) this.game.clear(); this.countSecond = null; }
    if (seconds >= 1 && seconds <= 5 && this.countSecond !== seconds) { this.countSecond = seconds; this.event('countdown', '最后冲刺', String(seconds), '抓住最后一次机会', 80, 950); }
    else if (seconds > 5 && seconds <= 10 && this.countSecond === null) { this.countSecond = seconds; this.event('ending', '即将结束', '最后 10 秒', '答案就在眼前', 80, 1300); }
    if (this.lastLength != null && round.answerLength !== this.lastLength) this.event('hint', '答案字数更新', `${round.answerLength} 字`);
    this.lastLength = round.answerLength;
  }
}
