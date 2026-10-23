// Presentation only: coalescing paints never filters server guesses or scores.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Broadcast output explicitly enables motion. Use motion=auto to follow the
// operator OS, or motion=reduced / lowEffects=true for reduced-motion output.
const motionMode = params.get('motion') || 'full';
const effectsOff = () => gameRoot.classList.contains('low-effects') || motionMode === 'reduced' || (motionMode === 'auto' && reducedMotion.matches);
document.body.dataset.motion = effectsOff() ? 'reduced' : 'full';
let renderPending = false;
let renderTimer = 0;
let lastListPaint = -Infinity;
let recentChatCards = [];
let latestGuess = null;
let interactionFeed = [];
const activeEffects = new Set();
const seenGuesses = new Set();
const guessKey = (guess) => String(guess.guessId || `${guess.playerId || guess.uniqueId}:${guess.word}:${guess.submittedAt}`);
const percent = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const numberTweens = new Map();
let numberFrame = 0;

function animateElement(element, frames, options, remove = false) {
  if (effectsOff() || document.hidden) { if (remove) element.remove(); return null; }
  const animation = element.animate(frames, options);
  activeEffects.add(animation);
  const cleanup = () => { activeEffects.delete(animation); if (remove) element.remove(); };
  animation.onfinish = cleanup;
  animation.oncancel = cleanup;
  return animation;
}

function setText(element, value) {
  const text = String(value ?? '');
  if (element.textContent !== text) element.textContent = text;
}
function setMarkup(element, html) {
  if (element._markup !== html) { element.innerHTML = html; element._markup = html; }
}
function patchAvatar(holder, actor) {
  const key = `${safeUrl(actor.avatarUrl)}:${initials(actor)}`;
  if (holder._avatarKey !== key) { holder.innerHTML = avatarHtml(actor); holder._avatarKey = key; }
}
function finishNumbers() {
  if (numberFrame) cancelAnimationFrame(numberFrame);
  numberFrame = 0;
  for (const [element, tween] of numberTweens) {
    element._shownNumber = tween.to;
    setText(element, tween.format(tween.to));
  }
  numberTweens.clear();
}
function animateNumbers(now) {
  numberFrame = 0;
  for (const [element, tween] of numberTweens) {
    if (!element.isConnected) { numberTweens.delete(element); continue; }
    const t = Math.min(1, Math.max(0, (now - tween.started) / tween.duration));
    const progress = 1 - Math.pow(1 - t, 3);
    element._shownNumber = tween.from + (tween.to - tween.from) * progress;
    setText(element, tween.format(t === 1 ? tween.to : element._shownNumber));
    if (t === 1) numberTweens.delete(element);
  }
  if (numberTweens.size) numberFrame = requestAnimationFrame(animateNumbers);
}
function updateNumber(element, value, format, duration = 780) {
  const target = Math.max(0, Number(value) || 0), previous = element._numberTarget;
  if (previous === target) return;
  element._numberTarget = target;
  if (previous === undefined || effectsOff() || document.hidden) {
    numberTweens.delete(element); element._shownNumber = target; setText(element, format(target)); return;
  }
  numberTweens.set(element, { from: element._shownNumber ?? previous, to: target, started: performance.now(), duration, format });
  if (!numberFrame) numberFrame = requestAnimationFrame(animateNumbers);
}
function discardRow(element) {
  element._rowMotion?.cancel();
  element.querySelectorAll('.score-value,.score-line b').forEach(node => numberTweens.delete(node));
  element.remove();
}

// Measure/reorder only when the keyed order changes. A score tick does not
// cancel and restart a row that is already moving toward its final slot.
function reconcileList(container, items, keyOf, classOf, patchOf) {
  const keys = items.map(item => String(keyOf(item)));
  const order = JSON.stringify(keys), layoutChanged = container._order !== order;
  const oldRows = [...container.children].filter(el => el.dataset.key);
  const existing = new Map(oldRows.map(el => [el.dataset.key, el]));
  const oldPositions = new Map(layoutChanged && !effectsOff() ? oldRows.map(el => [el.dataset.key, el.getBoundingClientRect().top]) : []);
  container.querySelector('.empty')?.remove();
  const keep = new Set(keys);
  for (const [key, el] of existing) if (!keep.has(key)) discardRow(el);
  const scale = gameRoot.getBoundingClientRect().width / 1080 || 1;
  const fresh = [];
  items.forEach((item, index) => {
    const key = keys[index];
    const el = existing.get(key) || document.createElement('div');
    el.dataset.key = key;
    const className = classOf(item, index);
    if (el.className !== className) el.className = className;
    patchOf(el, item, index);
    if (container.children[index] !== el) container.insertBefore(el, container.children[index] || null);
    if (!existing.has(key)) fresh.push(el);
  });
  container._order = order;
  if (layoutChanged && !effectsOff()) {
    // Cancel previous transforms before reading destinations, while retaining
    // their current on-screen start positions above (interruptible FLIP).
    for (const el of container.children) el._rowMotion?.cancel();
    const moves = [...container.children].map(el => ({ el, top: el.getBoundingClientRect().top }));
    for (const { el, top } of moves) {
      if (!oldPositions.has(el.dataset.key)) continue;
      const dy = (oldPositions.get(el.dataset.key) - top) / scale;
      if (Math.abs(dy) > .5) el._rowMotion = animateElement(el,
        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    fresh.forEach((el, index) => {
      el._rowMotion = animateElement(el, [
        { opacity: 0, transform: 'translateX(26px) scale(.98)' },
        { opacity: 1, transform: 'translateX(0) scale(1)' },
      ], { duration: 450, delay: Math.min(index, 5) * 25, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    });
  }
}
function renderEmpty(container, html) {
  if (container.querySelector('.empty')) return;
  [...container.children].forEach(discardRow);
  container._order = ''; container.innerHTML = html;
}
function patchGuessRow(el, guess) {
  if (!el._ready) {
    el.innerHTML = '<div class="guess-user"><span class="guess-avatar"></span><span class="guess-name"></span></div><span class="guess-tier"></span><strong class="guess-word"></strong><div class="score-wrap"><div class="score-line"><b></b></div><div class="score-bar"><div></div></div></div>';
    el._ready = true;
  }
  patchAvatar(el.querySelector('.guess-avatar'), guess);
  const name = el.querySelector('.guess-name'), word = el.querySelector('.guess-word');
  setText(name, actorName(guess));
  name.classList.toggle('identity-limited', Boolean(guess.identityLimited || guess.nicknameMasked));
  name.title = guess.nicknameMasked ? `${actorName(guess)} · 昵称由抖音平台脱敏` : guess.identityLimited ? `${actorName(guess)} · 平台未提供可用用户 ID` : actorName(guess);
  setMarkup(el.querySelector('.guess-tier'), tierBadgeHtml(guess.tier));
  setText(word, guess.word);
  word.classList.toggle('long-word', Array.from(guess.word).length > 3);
  word.title = `${guess.word} · ${guessModeLabel(guess)}`;
  updateNumber(el.querySelector('.score-line b'), percent(guess.displayScore), value => `${value.toFixed(1)}%`, 650);
  const bar = el.querySelector('.score-bar div'), target = percent(guess.displayScore);
  if (bar._target !== target) {
    const from = bar._target ?? 0; bar._target = target;
    bar.style.width = `${target}%`;
    animateElement(bar, [{ transform: `scaleX(${target ? from / target : 0})` }, { transform: 'scaleX(1)' }],
      { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
function patchScoreRow(el, player, index) {
  if (!el._ready) {
    el.innerHTML = '<span class="rank"></span><span class="score-avatar"></span><span class="score-name"></span><span class="score-value"></span><span class="score-delta" aria-hidden="true"></span>';
    el._ready = true;
  }
  const rank = el.querySelector('.rank'), name = el.querySelector('.score-name'), value = el.querySelector('.score-value');
  setText(rank, index === 0 ? '♛' : index === 1 ? '②' : index === 2 ? '③' : index + 1);
  rank.title = `第${index + 1}名`;
  patchAvatar(el.querySelector('.score-avatar'), player);
  setText(name, actorName(player));
  name.classList.toggle('identity-limited', Boolean(player.identityLimited || player.nicknameMasked));
  name.title = player.nicknameMasked ? `${actorName(player)} · 昵称由抖音平台脱敏` : player.identityLimited ? `${actorName(player)} · 平台未提供可用用户 ID` : actorName(player);
  const previous = value._numberTarget, score = Math.max(0, Number(player.score) || 0);
  value.title = fmt(score);
  updateNumber(value, score, number => compactScore(Math.round(number)));
  if (previous !== undefined && score > previous) {
    const delta = el.querySelector('.score-delta');
    setText(delta, `+${compactScore(score - previous)}`);
    delta.getAnimations().forEach(animation => animation.cancel());
    animateElement(delta, [{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'translateY(0)', offset: .18 }, { opacity: 1, offset: .68 }, { opacity: 0, transform: 'translateY(-10px)' }],
      { duration: 1100, easing: 'ease-out' });
    value._scoreAccent?.cancel();
    value._scoreAccent = animateElement(value, [{ color: '#be7033', transform: 'scale(1.12)' }, { transform: 'scale(1)', color: '#723d40' }],
      { duration: 780, easing: 'ease-out' });
  }
}

function renderGuessCards() {
  const guesses = state.topGuesses.slice(0, 12);
  $('guessPanelNote').textContent = guesses.some(guess => guess.nicknameMasked) ? '平台昵称已脱敏' : '关联度由高到低';
  if (!guesses.length) { renderEmpty($('guessTable'), '<div class="empty">还没有人猜词<br><small>发出第一个答案吧</small><div class="empty-slots"><div class="empty-slot">你的猜词 → 关联度</div></div></div>'); return; }
  reconcileList($('guessTable'), guesses, guessKey,
    (guess, index) => `guess-row ${index < 3 ? 'top' : ''} level-${scoreLevel(guess)}`,
    patchGuessRow);
}

function renderScoreCards() {
  const players = state.scoreboard.slice(0, 20);
  $('scoreboardCount').textContent = `${players.some(player => player.nicknameMasked) ? '昵称脱敏 · ' : ''}前${players.length || 20}`;
  updateRankFocus(players);
  if (!players.length) { renderEmpty($('scoreboard'), '<div class="empty"><small>首位得分玩家<br>将在这里出现</small><div class="empty-slots"><div class="empty-slot"><i>♛</i> 冠军席位</div><div class="empty-slot">02 亚军席位</div><div class="empty-slot">03 季军席位</div></div></div>'); return; }
  reconcileList($('scoreboard'), players, player => String(player.playerId || player.uniqueId || player.nickname),
    (player, index) => `score-row rank-${index + 1} ${player.playerId === focusPlayerId ? 'focus-player' : ''}`,
    patchScoreRow);
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  const paint = () => requestAnimationFrame(() => {
    renderPending = false;
    renderTimer = 0; lastListPaint = performance.now();
    renderAll();
    renderLatestGuess();
    const pending = recentChatCards;
    recentChatCards = [];
    for (const guess of pending) showEntryCard(guess);
  });
  const delay = Math.max(0, 120 - (performance.now() - lastListPaint));
  if (delay) renderTimer = setTimeout(paint, delay);
  else paint();
}

function receiveGuessEffect(guess) {
  const key = guessKey(guess);
  if (seenGuesses.has(key)) return;
  seenGuesses.add(key);
  if (seenGuesses.size > 2048) seenGuesses.delete(seenGuesses.values().next().value);
  latestGuess = guess;
  interactionFeed.unshift(guess);
  interactionFeed.length = Math.min(interactionFeed.length, 3);
  if (guess.triggerType === 'chat') { if (focusPlayerId !== guess.playerId) focusMovement = 0; focusPlayerId = guess.playerId; }
  if (guess.triggerType === 'gift' || guess.triggerType === 'like') flashAbility(guess.triggerType);
  if (guess.triggerType === 'chat') {
    recentChatCards.push(guess);
    if (recentChatCards.length > 2) recentChatCards.shift();
  }
}

function renderLatestGuess() {
  const target = $('latestGuess');
  if (!interactionFeed.length) {
    renderEmpty(target, '<div class="empty action-empty">等待本局触发动作…</div>');
    return;
  }
  reconcileList(target, interactionFeed, guessKey,
    guess => `action-row trigger-${guess.triggerType || 'chat'}`,
    (el, guess) => {
      if (!el._ready) {
        el.innerHTML = '<span class="action-kind"></span><span class="action-avatar"></span><span class="action-name"></span><strong class="action-word"></strong><b class="action-score"></b>';
        el._ready = true;
      }
      patchAvatar(el.querySelector('.action-avatar'), guess);
      setText(el.querySelector('.action-kind'), triggerLabel(guess.triggerType));
      setText(el.querySelector('.action-name'), actorName(guess));
      setText(el.querySelector('.action-word'), guess.word);
      setText(el.querySelector('.action-score'), `${percent(guess.displayScore).toFixed(1)}%`);
      el.title = `${triggerLabel(guess.triggerType)} · ${actorName(guess)} · ${guess.word} · ${percent(guess.displayScore).toFixed(1)}%`;
    });
}

function showEntryCard(guess) {
  if (effectsOff() || document.hidden) return;
  const target = [...$('guessTable').children].find(el => el.dataset.key === guessKey(guess));
  if (!target) return;
  // Entry is the actual card sliding into its slot, not a large flying duplicate.
  const word = target.querySelector('.guess-word');
  animateElement(word, [{ backgroundColor: guess.isCorrect || percent(guess.displayScore) >= 90 ? '#f0d6ce' : '#f8e9d6' }, { backgroundColor: '#fffaf7' }],
    { duration: 850, easing: 'ease-out' });
}

function clearInteractionEffects() {
  for (const animation of activeEffects) animation.cancel();
  activeEffects.clear(); recentChatCards = []; latestGuess = null; interactionFeed = [];
  finishNumbers();
  seenGuesses.clear();
  $('entryLayer').replaceChildren();  $('floatRail').replaceChildren(); $('toastLayer').replaceChildren();
  $('latestGuess').innerHTML = '<div class="empty action-empty">等待本局触发动作…</div>';
  $('latestGuess')._order = '';
}


reducedMotion.addEventListener('change', () => {
  document.body.dataset.motion = effectsOff() ? 'reduced' : 'full';
  if (!effectsOff()) return;
  for (const animation of activeEffects) animation.cancel();
  activeEffects.clear(); $('entryLayer').replaceChildren();
  finishNumbers();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  for (const animation of activeEffects) animation.cancel();
  activeEffects.clear(); recentChatCards = [];
  finishNumbers();
  $('entryLayer').replaceChildren();
});
