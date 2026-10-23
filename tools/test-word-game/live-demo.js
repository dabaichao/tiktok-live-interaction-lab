// Local-only visual demo. It injects the same browser events as the server, but never
// connects to TikTok, the live server, or an LLM. The normal page does not load this mode.
const demoNames = ['小林同学', '晚风', '橘子海', '山野来信', '小满', '月亮邮差', '阿白', '林间小路', '鲸落', '今天也开心'];
const demoWords = ['水果', '果园', '果树', '果汁', '梨子', '桃子', '甜味', '维生素', '红色', '早餐', '秋天', '种子', '农场', '绿色'];
const demoGiftWords = ['果盘', '果肉', '果香', '甜品', '苹果派', '果篮', '鲜果', '果实'];
const demoTimers = new Set();
let demoRoundNumber = 158;
let demoRoundId = 'demo-round-158';
let demoGuesses = [];
let demoPlayers = [];
let demoGuessSequence = 0;
let demoCurrentRound = null;

function demoLater(callback, delay) {
  const timer = setTimeout(() => { demoTimers.delete(timer); callback(); }, delay);
  demoTimers.add(timer);
  return timer;
}

function demoRound(status, endsIn, answer = undefined) {
  if (!demoCurrentRound || demoCurrentRound.roundId !== demoRoundId) {
    demoCurrentRound = { roundId: demoRoundId, roundNo: demoRoundNumber, status: 'RUNNING', answerLength: 2, partOfSpeech: 'noun', startedAt: Date.now() - 15000, endsAt: Date.now() + 225000 };
  }
  if (status) demoCurrentRound.status = status;
  if (endsIn !== undefined) demoCurrentRound.endsAt = Date.now() + endsIn;
  if (status === 'ANSWERED' || status === 'SETTLEMENT') demoCurrentRound.settleAt = Date.now() + 4200;
  if (status === 'SETTLEMENT') demoCurrentRound.revealedAnswer = answer || '苹果';
  return { ...demoCurrentRound };
}

function demoPlayer(index, score = 3400 - index * 137) {
  return { playerId: `demo-player-${index}`, nickname: demoNames[index % demoNames.length], uniqueId: `demo_${index + 1}`, avatarUrl: new URL('./demo-avatar.svg', location.href).href, tier: index < 3 ? '黄金' : index < 10 ? '白银' : '青铜', score };
}

function demoGuess(index, word, score, triggerType = 'chat', playerIndex = index) {
  const player = demoPlayers.find(item => item.playerId === `demo-player-${playerIndex}`) || demoPlayer(playerIndex);
  return { guessId: `${demoRoundId}-guess-${demoGuessSequence++}`, playerId: player.playerId, nickname: player.nickname, uniqueId: player.uniqueId, tier: player.tier, avatarUrl: player.avatarUrl, word, displayScore: score, triggerType, bucket: score >= 90 ? 'near' : score >= 70 ? 'hot' : 'warm', submittedAt: Date.now() };
}

function demoRoomSnapshot() {
  const now = Date.now();
  if (!demoPlayers.length) demoPlayers = Array.from({ length: 20 }, (_, index) => demoPlayer(index));
  demoGuesses = demoWords.map((word, index) => demoGuess(index, word, 96 - index * 2.35, index % 4 === 0 ? 'gift' : 'chat', index));
  applyMessage({ type: 'ROOM_SNAPSHOT', room: { language: 'zh-Hans', viewerCount: 12840, giftWordsMultiplier: 10, giftExtraTimeMs: 30000 }, round: demoRound(), topGuesses: demoGuesses, scoreboard: demoPlayers, hintsUnlocked: 0, timeline: { phaseIndex: 0, progress: .08, unlockedHints: [], hintLimit: 4, nextHintAt: now + 4200, phaseLabel: '探索期' }, metrics: { validGuesses: 368, uniqueGuessers: 120, likesThisRound: 1800 } });
}

function demoEmitGuess(word, score, triggerType = 'chat', playerIndex = 0) {
  const guess = demoGuess(playerIndex, word, score, triggerType, playerIndex);
  demoGuesses = [guess, ...demoGuesses].sort((a, b) => Number(b.displayScore) - Number(a.displayScore)).slice(0, 14);
  // Ordinary guesses do not award points; mirror settlement-only scoring.
  applyMessage({ type: 'GUESS_ACCEPTED', triggerType, guess, round: demoRound(), topGuesses: demoGuesses, scoreboard: demoPlayers, metrics: { validGuesses: 368 + demoGuessSequence, uniqueGuessers: 120 + Math.min(12, demoGuessSequence), likesThisRound: 1800 + demoGuessSequence * 3 } });
}

function demoUnlockHint(level, label, value, progress) {
  const hints = [...(state.timeline?.unlockedHints || []), { label, value }];
  applyMessage({ type: 'HINT_UNLOCKED', level, hint: { label, value }, round: demoRound(), timeline: { ...state.timeline, progress, unlockedHints: hints, hintLimit: 4, nextHintAt: Date.now() + 4200 } });
}

function demoGiftBurst() {
  demoGiftWords.forEach((word, index) => demoLater(() => demoEmitGuess(word, 63 + index * 3.7, 'gift', (index + 3) % demoPlayers.length), index * 120));
  demoLater(() => applyMessage({ type: 'GIFT_EFFECT', seconds: 30, round: demoRound('RUNNING', demoRound().endsAt - Date.now() + 30000) }), 80);
}

function demoShowcaseSettlement() {
  const rewards = [150, 100, 50, 50];
  demoPlayers = demoPlayers.map((player, index) => ({ ...player, score: player.score + (rewards[index] || 0) }));
  const winner = { ...demoGuess(0, '苹果', 100, 'chat', 0), isCorrect: true, scoreDelta: 150, currentScore: demoPlayers[0].score, currentRank: 1, pointsToSurpass: 0, tier: '黄金' };
  const awards = ['相似度第 2', '相似度第 3', '最佳助攻'].map((reason, index) => ({ ...demoPlayers[index + 1], reason, delta: rewards[index + 1], currentScore: demoPlayers[index + 1].score, currentRank: index + 2 }));
  applyMessage({ type: 'ROUND_SETTLED', round: demoRound('SETTLEMENT', 0, '苹果'), winner, scoreboard: demoPlayers, topGuesses: [winner, ...demoGuesses].slice(0, 14), awards });
}

function demoNewRound() {
  clearInteractionEffects();
  demoRoundNumber += 1; demoRoundId = `demo-round-${demoRoundNumber}`; demoGuessSequence = 0;
  applyMessage({ type: 'ROUND_STARTED', round: demoRound('RUNNING') });
  demoRoomSnapshot();
}


function demoRealGift(level = 1, index = 0) {
  const definitions = [{ name: '玫瑰', diamondCount: 1, count: 1 }, { name: '彩带礼炮', diamondCount: 100, count: 2 }, { name: '狮子', diamondCount: 29999, count: 1 }];
  applyMessage({ type: 'GIFT_RECEIVED', eventId: `${demoRoundId}-gift-${demoGuessSequence++}`, actor: demoPlayer(index), gift: definitions[level - 1] });
}
// Presentation-only score changes, deliberately isolated from live scoring.
function demoScoreMove(playerId, delta) {
  demoPlayers = demoPlayers.map(player => player.playerId === playerId ? { ...player, score: player.score + delta } : player)
    .sort((a, b) => b.score - a.score);
  applyMessage({ type: 'ROOM_SNAPSHOT', room: state.room, round: demoRound(), timeline: state.timeline,
    topGuesses: demoGuesses, scoreboard: demoPlayers, hintsUnlocked: state.hintsUnlocked, metrics: state.metrics });
}
function runDemoMotion() {
  demoLater(() => demoEmitGuess('果香', 97.2, 'chat', 4), 700);
  demoLater(() => demoRealGift(1, 1), 1100);
  demoLater(() => demoRealGift(1, 1), 1650);
  demoLater(() => demoScoreMove('demo-player-5', 950), 2700);
  demoLater(() => demoRealGift(3, 2), 3700);
  demoLater(() => demoEmitGuess('清甜', 98.1, 'chat', 2), 4500);
  demoLater(() => demoScoreMove('demo-player-8', 1300), 5500);
  demoLater(() => {
    for (let i = 0; i < 30; i++) demoLater(() => demoRealGift(i % 9 === 0 ? 2 : 1, i % 10), i * 90);
  }, 7500);
  demoLater(() => demoScoreMove('demo-player-0', 800), 10400);
  demoLater(() => demoEmitGuess('香甜', 99.0, 'gift', 0), 11800);
  demoLater(runDemoMotion, 15000);
}
function demoCorrect() {
  const winner = { ...demoGuess(0, '苹果', 100), isCorrect: true, pendingReward: 150 };
  applyMessage({ type: 'ROUND_ANSWERED', round: demoRound('ANSWERED', 0), winner });
}
function demoCountdown(seconds = 10) {
  state.round = demoRound('RUNNING', seconds * 1000);
  renderRound();
}
function demoTimeoutResult() {
  applyMessage({ type: 'ROUND_SETTLED', round: demoRound('SETTLEMENT', 0), winner: null, scoreboard: demoPlayers, topGuesses: demoGuesses, awards: [] });
}
function runDemoShowcase() {
  demoRoomSnapshot();
  applyMessage({ type: 'ROUND_STARTED', round: demoRound() });
  demoLater(() => demoEmitGuess('水果', 86, 'chat', 0), 3400);
  demoLater(() => demoUnlockHint(1, '方向提示', '水果的一种', .25), 4000);
  demoLater(() => demoRealGift(1, 1), 5500);
  demoLater(() => demoRealGift(2, 2), 5800);
  demoLater(() => demoRealGift(3, 3), 6200);
  demoLater(demoGiftBurst, 7000);
  demoLater(() => demoEmitGuess('果实', 93, 'chat', 4), 9400);
  demoLater(() => demoCountdown(10), 11000);
  demoLater(() => { demoCorrect(); demoRealGift(3, 7); }, 19000);
  demoLater(demoShowcaseSettlement, 22000);
  demoLater(demoNewRound, 28000);
  demoLater(() => demoCountdown(5), 31500);
  demoLater(() => applyMessage({ type: 'ROUND_TIMEOUT', round: demoRound('ANSWERED', 0) }), 36600);
  demoLater(demoTimeoutResult, 39300);
  demoLater(() => { demoNewRound(); runDemoShowcase(); }, 45000);
}
function runDemo(mode = 'showcase') {
  document.body.dataset.demo = mode;
  document.title = '演示数据 · 语义猜词';
  demoRoomSnapshot();
  if (mode === 'showcase') runDemoShowcase();
  else if (mode === 'motion') runDemoMotion();
  else if (mode === 'timeout') {
    demoLater(() => applyMessage({ type: 'ROUND_TIMEOUT', round: demoRound('ANSWERED', 0) }), 500);
    demoLater(demoTimeoutResult, 3300);
  } else if (mode === 'settlement') demoLater(demoShowcaseSettlement, 250);
  else if (mode === 'celebration') { demoLater(demoCorrect, 400); demoLater(demoShowcaseSettlement, 1500); }
  else if (mode === 'gift') { [1, 2, 3, 1, 2].forEach((level, i) => demoLater(() => demoRealGift(level, i), i * 120 + 250)); }
  else if (mode === 'countdown') {
    demoCountdown(5);
    demoLater(() => applyMessage({ type: 'ROUND_TIMEOUT', round: demoRound('ANSWERED', 0) }), 5100);
    demoLater(demoTimeoutResult, 7800);
  }
  else if (mode === 'start') applyMessage({ type: 'ROUND_STARTED', round: demoRound() });
  else if (mode === 'concurrent') {
    demoCountdown(5);
    demoLater(() => { demoCorrect(); [1, 2, 3, 1, 3].forEach((level, i) => demoRealGift(level, i)); demoUnlockHint(2, '开头提示', '苹', .9); }, 650);
    demoLater(demoShowcaseSettlement, 1700);
  }
}
addEventListener('beforeunload', () => demoTimers.forEach(clearTimeout));
