// A single acknowledgement lives in the existing interaction dock. Presentation
// coalescing never changes gift events, game effects or the server's ledger.
class GiftBarrage extends MotionSurface {
  constructor(host, manager) {
    super(host); this.manager = manager; this.queue = []; this.active = null;
    this.history = []; this.seen = new Set(); this.holdUntil = 0;
    this.host.className = 'gift-spotlight';
    $('giftFlowStatus').textContent = '感谢每一份支持';
    this.showIdle();
    this.pumpTimer = setInterval(() => this.pump(), 120);
    addEventListener('beforeunload', () => { clearInterval(this.pumpTimer); this.clear(); }, { once: true });
  }
  receive(event) {
    if (event.eventId && this.seen.has(event.eventId)) return;
    if (event.eventId) this.seen.add(event.eventId);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    const gift = event.gift || {}, user = event.actor || event.user || {};
    const count = Math.max(1, Number(gift.count) || 1);
    const value = Math.max(0, Number(gift.totalValue ?? (Number(gift.diamondCount) * count)) || 0);
    const identity = user.id || user.uniqueId || user.playerId;
    const item = { user, gift: { ...gift, count }, value, level: this.level(value), at: performance.now(),
      key: identity && (gift.id || gift.name) ? `${identity}:${gift.id || gift.name}` : null };
    this.history.unshift(item); this.history.length = Math.min(this.history.length, 60);
    if (document.hidden) return;
    const active = this.active;
    if (item.key && active?.item.key === item.key && !active.leaving) {
      active.item = this.merge(active.item, item);
      // A combo update must not shorten an already promised high-value display.
      const cap = active.started + (active.item.level === 3 ? 5400 : active.item.level === 2 ? 4800 : 4400);
      active.until = Math.max(active.until, Math.min(cap, performance.now() + 1300));
      this.patchCard(active.element, active.item, true);
      return;
    }
    const index = item.key ? this.queue.findIndex(pending => pending.key === item.key) : -1;
    if (index >= 0) this.queue[index] = this.merge(this.queue[index], item);
    else this.queue.push(item);
    // Only visual waiting is bounded. No eight-second-old animations replay.
    if (this.queue.length > 24) this.queue.shift();
    this.pump();
  }
  level(value) { return value >= 1000 ? 3 : value >= 10 ? 2 : 1; }
  merge(old, incoming) {
    const value = old.value + incoming.value;
    return { ...incoming, gift: { ...old.gift, ...incoming.gift, icon: incoming.gift.icon || old.gift.icon, count: old.gift.count + incoming.gift.count }, value, level: this.level(value) };
  }
  showIdle() {
    this.host.replaceChildren();
    const idle = document.createElement('div'); idle.className = 'gift-dock-idle';
    idle.textContent = '礼物将醒目展示送礼观众、礼物与数量';
    this.host.append(idle);
    $('giftFlowStatus').textContent = '感谢每一份支持';
  }
  pump() {
    if (document.hidden) return;
    const now = performance.now();
    this.queue = this.queue.filter(item => now - item.at <= 8000);
    if (this.active) {
      if (!this.active.leaving && now >= this.active.until) this.dismiss();
      return;
    }
    const busy = this.manager.celebration?.active || this.manager.resultActive || (this.manager.game?.priority || 0) >= 70;
    if (busy || now < this.holdUntil || !this.queue.length) return;
    this.launch(this.queue.shift());
  }
  launch(item) {
    this.clear();
    const el = document.createElement('article');
    el.innerHTML = `${avatarHtml(item.user)}<div class="gift-identity"><b></b><span class="gift-name"></span></div><div class="gift-picture" aria-hidden="true"></div><div class="gift-count"><small>送出</small><strong></strong></div><span class="gift-accent" aria-hidden="true"></span>`;
    this.patchCard(el, item);
    this.host.append(el);
    const now = performance.now();
    this.active = { item, element: el, started: now, until: now + (item.level === 3 ? 4200 : item.level === 2 ? 3600 : 3200), leaving: false };
    this.move(el, [{ opacity: 0, transform: 'translateY(26px) scale(.88)' }, { opacity: 1, transform: 'translateY(-3px) scale(1.025)', offset: .72 }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
      { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (item.level >= 2) this.move(el.querySelector('.gift-accent'),
      [{ transform: 'translateX(-110%)', opacity: 0 }, { opacity: .65, offset: .3 }, { transform: 'translateX(110%)', opacity: 0 }],
      { duration: 1050, easing: 'ease-out' });
  }
  patchCard(el, item, pulse = false) {
    el.className = `gift-barrage-item gift-level-${item.level}`;
    el.querySelector('.gift-identity > b').textContent = actorName(item.user);
    el.querySelector('.gift-name').textContent = item.gift.name || '礼物';
    const picture = el.querySelector('.gift-picture');
    const iconUrl = safeUrl(item.gift.icon || item.gift.giftIcon || item.gift.imageUrl);
    if (picture.dataset.icon !== iconUrl) {
      picture.dataset.icon = iconUrl;
      picture.replaceChildren();
      if (iconUrl) {
        const image = document.createElement('img');
        image.src = iconUrl; image.alt = ''; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => {
          if (picture.dataset.icon !== iconUrl) return;
          const fallback = document.createElement('span'); fallback.className = 'gift-fallback'; fallback.textContent = '🎁'; picture.replaceChildren(fallback);
        }, { once: true });
        picture.append(image);
      } else {
        const fallback = document.createElement('span'); fallback.className = 'gift-fallback'; fallback.textContent = '🎁'; picture.append(fallback);
      }
    }
    $('giftFlowStatus').textContent = `${actorName(item.user)} 送出 ${item.gift.name || '礼物'}`;
    const count = el.querySelector('.gift-count strong');
    count.textContent = `×${item.gift.count}`;
    if (pulse) {
      count.getAnimations().forEach(animation => animation.cancel());
      this.move(count, [{ transform: 'scale(1.25)', color: '#c66036' }, { transform: 'scale(1)' }],
        { duration: 400, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  dismiss() {
    const active = this.active;
    if (!active) return;
    active.leaving = true;
    this.move(active.element, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-14px)' }],
      { duration: 260, easing: 'ease-in', fill: 'forwards' });
    this.later(() => { this.clear(); this.showIdle(); this.pump(); }, effectsOff() ? 0 : 270);
  }
  clear() { super.clear(); this.active = null; }
  suspend() { this.queue = []; this.clear(); this.showIdle(); }
}
