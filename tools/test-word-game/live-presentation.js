// Round, hint, reward and ranking presentation; values come from server events.
let lastResult = null;
let visibleResult = null;
let focusPlayerId = null;
let priorRanks = new Map();
let focusMovement = 0;
const abilityAnimations = new Map();
const compactScore = value => { const score = Math.max(0, Number(value) || 0); return score >= 100000 ? `${Math.floor(score / 10000)}万` : score >= 10000 ? `${(score / 10000).toFixed(1)}万` : String(score); };
const clockText = ms => { const seconds = Math.ceil(Math.max(0, ms) / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
function scoreLevel(guess) { const score = percent(guess.displayScore); return guess.isCorrect ? 'correct' : score >= 90 ? 'near' : score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold'; }

function renderRoundStatus() {
  const round = state.round;
  if (!round) { $('timer').textContent = '--:--'; return; }
  const running = String(round.status).toUpperCase() === 'RUNNING';
  const remaining = running ? Math.max(0, Number(round.endsAt) - Date.now()) : 0;
  $('roundNo').textContent = `第 ${round.roundNo} 局`;
  const pos = ({ noun: '名词', verb: '动词', adjective: '形容词', idiom: '成语' })[round.partOfSpeech] || round.partOfSpeech;
  $('partOfSpeech').textContent = pos || '猜词挑战';
  $('answerLength').textContent = `${round.answerLength ?? '—'} ${state.room.language && state.room.language !== 'zh-Hans' ? '字母' : '字'}`;
  $('timer').textContent = running ? clockText(remaining) : round.status === 'PAUSED' ? '已暂停' : round.status === 'WAITING' ? '待开局' : '结算中';
  $('timer').className = `timer ${running && remaining <= 10000 ? 'danger' : running && remaining <= 30000 ? 'warning' : ''}`;
  if (!state.timeline) state.timeline = { progress: running ? Math.max(0, 1 - remaining / Math.max(1, round.endsAt - round.startedAt)) : 1, phaseIndex: 0 };
}

function renderHintStatus() {
  const timeline = state.timeline || {};
  const progress = Math.max(0, Math.min(1, Number(timeline.progress) || 0));
  $('timelineProgress').style.width = `${progress * 100}%`;
  const count = state.hintsUnlocked || 0;
  $('hintCount').textContent = `提示 ${count}/${timeline.hintLimit || 4} 已解锁`;
  const nextAt = Number(timeline.nextHintAt);
  $('nextHint').textContent = state.round?.status === 'PAUSED' ? '游戏已暂停' : nextAt ? `${clockText(nextAt - Date.now())} 后下一条` : count >= (timeline.hintLimit || 4) ? '提示已全部解锁' : '等待下一条线索';
  [...document.querySelectorAll('.timeline-marker')].forEach((marker, i) => marker.classList.toggle('active', progress >= (i + 1) / 4));
}

function flashAbility(trigger) {
  if (trigger !== 'gift') return;
  const target = $('giftAbility');
  if (!target || effectsOff() || abilityAnimations.has(target)) return;
  const animation = target.animate([{ boxShadow: 'inset 0 0 0 2px #b76378', backgroundColor: '#f3cfd4' }, { boxShadow: 'inset 0 0 0 0px transparent' }], { duration: 650, easing: 'ease-out' });
  abilityAnimations.set(target, animation);
  animation.onfinish = animation.oncancel = () => abilityAnimations.delete(target);
}

function updateRankFocus(players) {
  const ranks = new Map(players.map((player, i) => [player.playerId, i + 1]));
  const index = players.findIndex(player => player.playerId === focusPlayerId);
  if (index >= 0) {
    const oldRank = priorRanks.get(focusPlayerId);
    if (oldRank && oldRank !== index + 1) focusMovement = oldRank - index - 1;
    const delta = index > 0 ? Math.max(0, Number(players[index - 1].score) - Number(players[index].score) + 1) : 0;
    setMarkup($('rankFocus'), `<b>#${index + 1}</b>${focusMovement ? `<span class="rank-change">${focusMovement > 0 ? '↑' : '↓'}${Math.abs(focusMovement)}</span>` : ''}<span>${index ? `差${compactScore(delta)}分超越` : '本场榜首'}</span>`);
  } else setMarkup($('rankFocus'), focusPlayerId ? '最近参与者暂未进入前20' : '本轮参与，争取上榜');
  priorRanks = ranks;
}

function awardHtml(award) {
  const rank = Number(award.currentRank);
  return `<article class="award-card"><span class="award-label">${escapeHtml(award.reason)}</span><div class="award-user">${avatarHtml(award)}<strong>${escapeHtml(actorName(award))}</strong><b>+${Number(award.delta) || 0}</b></div><div class="award-meta">${rank ? `第${rank}名 · ` : ''}总分 ${fmt(award.currentScore)}</div></article>`;
}

function renderSettlement(message) {
  overlays.settled(message);
  overlays.plane.classList.add('result-visible');
  visibleResult = message; lastResult = message;
  const winner = message.winner;
  const answer = message.round?.revealedAnswer || winner?.word;
  $('winnerKicker').textContent = winner ? '全场猜中' : '本轮结束 · 无人猜中';
  $('winnerWord').textContent = answer || '本轮结束';
  $('winnerWord').classList.toggle('long-answer', Array.from(answer || '').length > 5);
  $('winnerHero').hidden = !winner;
  $('winnerAvatar').innerHTML = winner ? avatarHtml(winner) : '';
  $('winnerTitle').textContent = winner ? actorName(winner) : '';
  $('winnerReward').textContent = winner ? `+${Number(winner.scoreDelta) || 0}` : '';
  $('winnerCopy').textContent = winner ? `第 ${winner.currentRank || '—'} 名 · ${winner.tier || ''} · 总分 ${fmt(winner.currentScore)}` : answer ? '答案已揭晓，下一局继续挑战' : '等待服务器公布答案';
  $('winnerRankCopy').textContent = winner ? (winner.pointsToSurpass ? `再得 ${fmt(winner.pointsToSurpass)} 分，即可超越上一名` : '恭喜登顶本场积分榜') : '';
  const awards = Array.isArray(message.awards) ? message.awards : [];
  const similarity = awards.filter(award => String(award.reason).startsWith('相似度')).slice(0, 2);
  const assist = awards.filter(award => String(award.reason).includes('助攻')).slice(0, 1);
  $('similarityAwards').innerHTML = similarity.length ? similarity.map(awardHtml).join('') : '<div class="no-award">本轮暂无相似度奖励</div>';
  $('assistAward').innerHTML = assist.length ? assist.map(awardHtml).join('') : '<div class="no-award">本轮无额外助攻奖励</div>';
  const wasHidden = $('winnerModal').classList.contains('hidden');
  $('winnerModal').classList.remove('hidden');
  $('floatRail').replaceChildren(); $('toastLayer').replaceChildren();
  if (wasHidden) {
    animateElement(document.querySelector('.winner-card'), [{ opacity: 0, transform: 'translateY(20px) scale(.72)' }, { opacity: 1, transform: 'scale(1.06)', offset: .43 }, { transform: 'scale(.98)', offset: .72 }, { opacity: 1, transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
    animateElement($('winnerReward'), [{ transform: 'scale(.8)' }, { transform: 'scale(1.2)', offset: .5 }, { transform: 'scale(1)' }], { duration: 620 });
  }
  renderPreviousResult(); renderSettlementClock();
}

function renderSettlementClock() {
  if (!visibleResult || $('winnerModal').classList.contains('hidden')) return;
  const until = Number(visibleResult.round?.settleAt);
  const remaining = until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : null;
  $('settlementCountdown').textContent = remaining === null ? '' : String(remaining);
  $('settlementNextLabel').textContent = remaining ? '秒后进入下一局' : '等待下一局开始…';
}

function renderPreviousResult() {
  if (!lastResult) return;
  const winner = lastResult.winner;
  const answer = lastResult.round?.revealedAnswer || winner?.word;
  setMarkup($('previousResult'), `<span>上局 · 第${lastResult.round?.roundNo ?? '—'}局</span><strong title="${escapeHtml(answer || '')}">${escapeHtml(answer || '暂未揭晓')}</strong><div class="previous-winner">${winner ? avatarHtml(winner) : ''}<span>${winner ? escapeHtml(actorName(winner)) : '无人猜中'}</span></div>`);
}

function resetRoundPresentation() {
  overlays.reset(); overlays.plane.classList.remove('result-visible');
  visibleResult = null; focusPlayerId = null; focusMovement = 0;
  $('winnerModal').classList.add('hidden');
  for (const animation of abilityAnimations.values()) animation.cancel();
  abilityAnimations.clear();
}
reducedMotion.addEventListener('change', () => { if (effectsOff()) { for (const animation of abilityAnimations.values()) animation.cancel(); abilityAnimations.clear(); } });
