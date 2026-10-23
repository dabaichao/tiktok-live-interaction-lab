// Isolated browser acceptance. No TikTok, LLM, or running server mutation.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const folder = fileURLToPath(new URL('./test-word-game/', import.meta.url));
const output = join(tmpdir(), 'semantic-emotion-qa'); await mkdir(output, { recursive: true });
const files = new Set(['index.html','live-layout.css','live-game.js','live-effects.js','live-presentation.js','live-demo.js','overlay-core.js','celebration-overlay.js','gift-barrage.js','emotion-overlays.css','demo-avatar.svg']);
const server = createServer(async (req, res) => {
  const file = new URL(req.url,'http://localhost').pathname.split('/').pop() || 'index.html';
  if (!files.has(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
  res.end(await readFile(join(folder,file)));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
let browser; const report = { checks: [], screenshots: output };
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; const requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
  await page.addInitScript(() => { window.socketAttempts = 0; window.WebSocket = class { constructor() { window.socketAttempts++; } addEventListener() {} close() {} }; });
  await page.goto(`${base}?demo=start`);
  for (const [time, value] of [[100,'3'],[800,'2'],[1550,'1'],[2320,'开猜！']]) {
    // Absolute timings use the first sample as the reference.
    await page.waitForTimeout(time === 100 ? 100 : time - (value === '2' ? 100 : value === '1' ? 800 : 1550));
    assert.equal(await page.locator('.event-start strong').textContent(), value);
  }
  await page.locator('.event-start').waitFor({ state:'detached',timeout:2000 });
  report.checks.push('3/2/1/开猜 sequence');
  await page.evaluate(() => demoUnlockHint(1,'开头提示','苹',.25));
  assert.equal(await page.locator('.event-hint strong').textContent(),'苹');
  assert.equal(await page.locator('#toastLayer').textContent(),'');
  await page.waitForTimeout(450); await page.screenshot({ path:join(output,'hint.png') });
  await page.goto(`${base}?demo=countdown`);
  await page.waitForTimeout(220);
  assert.equal(await page.locator('.event-countdown strong').textContent(),'5');
  await page.waitForTimeout(1000); assert.equal(await page.locator('.event-countdown strong').textContent(),'4');
  await page.screenshot({ path:join(output,'countdown.png') });
  report.checks.push('central hint and final countdown');
  await page.evaluate(() => applyMessage({type:'GIFT_EFFECT', seconds:30, round:{...state.round, endsAt:Date.now()+34000}}));
  assert.equal(await page.locator('.event-countdown').count(),0);
  assert.equal(await page.locator('.event-extra-time strong').textContent(),'+30 秒');
  report.checks.push('gift extension replaces obsolete final countdown');
  await page.goto(`${base}?demo=manual&motion=full`);
  const gifts = [];
  for (const level of [1,2,3]) {
    await page.evaluate(level => { overlays.gifts.suspend(); demoRealGift(level,level); },level);
    const gift = await page.evaluate(() => {
      const el=document.querySelector('.gift-barrage-item'),dock=document.querySelector('#giftDanmaku');
      return { cls:el.className,avatar:!!el.querySelector('img'),text:el.textContent,height:el.offsetHeight,
        duration:el.getAnimations()[0]?.effect.getTiming().duration,frames:el.getAnimations()[0]?.effect.getKeyframes().map(f=>f.transform),
        belowBoard:dock.getBoundingClientRect().top>=document.querySelector('.main-panel').getBoundingClientRect().bottom,
        beforeSticker:dock.getBoundingClientRect().bottom<document.querySelector('.bottom-panel').getBoundingClientRect().top };
    });
    assert.equal(await page.locator('.gift-barrage-item').count(),1);
    assert.ok(gift.avatar);assert.match(gift.text,/送出/);assert.match(gift.text,/×/);
    assert.equal(gift.duration,520);assert.match(gift.frames[0],/translateY\(26px\)/);
    assert.ok(gift.belowBoard);assert.ok(gift.beforeSticker);gifts.push(gift);
  }
  assert.equal(new Set(gifts.map(g=>g.height)).size,1);
  await page.waitForTimeout(450);await page.screenshot({path:join(output,'gifts.png')});
  await page.locator('.gift-barrage-item').waitFor({state:'detached',timeout:6000});
  assert.equal(await page.evaluate(()=>overlays.gifts.history.length),3);
  report.gifts=gifts;report.checks.push('single dock, 3 same-size tiers, entry/exit and no leaderboard overlap');
  await page.goto(`${base}?demo=concurrent`); await page.waitForTimeout(1000);
  assert.equal(await page.locator('.celebration-beam').count(),24); assert.equal(await page.locator('.celebration-particle').count(),28);
  assert.equal(await page.locator('.game-event').count(),0);
  await page.screenshot({ path:join(output,'celebration-hit.png') });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.celebration-scene').count(),1);
  assert.equal(await page.locator('#winnerModal').isVisible(),true);
  assert.equal(await page.locator('#winnerReward').textContent(),'+150');
  assert.equal(await page.locator('.gift-barrage-item').count(),0);
  await page.screenshot({ path:join(output,'celebration.png') });
  const portal = await page.evaluate(() => ({ fixed:getComputedStyle(overlays.portal).position, parent:overlays.portal.parentElement.tagName, z:[...overlays.plane.children].map(e=>getComputedStyle(e).zIndex), duration:overlays.celebration.animations.size }));
  assert.equal(portal.fixed,'fixed'); assert.equal(portal.parent,'BODY'); assert.deepEqual(portal.z,['3000','6000','7000','8000']);
  report.portal = portal; report.checks.push('immediate correct celebration lasts >2s, priority arbitration, portal levels');
  await page.locator('.celebration-scene').waitFor({state:'detached',timeout:3000});
  for (const size of [{width:375,height:812},{width:390,height:844},{width:430,height:932},{width:1920,height:1080}]) {
    await page.setViewportSize(size); await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => { const r=gameRoot.getBoundingClientRect(), p=overlays.portal.getBoundingClientRect(), c=document.querySelector('.winner-card').getBoundingClientRect(), reserved=document.querySelector('.bottom-panel'); return Math.abs(r.width-p.width)<1 && c.right<=p.right+1 && c.left>=p.left-1 && c.bottom<reserved.getBoundingClientRect().top && reserved.childElementCount===0 && document.documentElement.scrollHeight<=innerHeight; }));
  }
  await page.setViewportSize({width:390,height:844});
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await page.goto(`${base}?demo=gift`);
  report.performance = await page.evaluate(async () => {
    demoCorrect(); for(let i=0;i<500;i++) demoRealGift(i%3+1,i%20);
    const gaps=[]; let last; const start=performance.now(); let maxNodes=0,maxQueue=0;
    await new Promise(resolve => { const frame = now => { if(last!==undefined)gaps.push(now-last);last=now;maxNodes=Math.max(maxNodes,document.querySelectorAll('.gift-barrage-item').length);maxQueue=Math.max(maxQueue,overlays.gifts.queue.length);if(now-start<5000)requestAnimationFrame(frame);else resolve(); };requestAnimationFrame(frame); });
    gaps.sort((a,b)=>a-b);return {fps:gaps.length*1000/(performance.now()-start),p95:gaps[Math.floor(gaps.length*.95)],maxNodes,maxQueue,history:overlays.gifts.history.length};
  });
  assert.ok(report.performance.maxNodes<=1); assert.ok(report.performance.maxQueue<=24); assert.equal(report.performance.history,60);
  // This is a throttled desktop renderer measurement, not a physical phone claim.
  report.performance.environment='Edge headless, 390x844 viewport, 4x CPU throttle';
  assert.ok(report.performance.fps >= 50, 'main-thread frame cadence must meet the 50 FPS floor');
  assert.ok(report.performance.p95 < 34, 'p95 main-thread frame interval must be below 34ms');
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  await page.goto(`${base}?demo=start`);
  const anonymous = await page.evaluate(() => {
    overlays.gifts.holdUntil = Infinity;
    for (let i=0;i<125;i++) overlays.gifts.receive({eventId:`anonymous-${i}`,actor:{nickname:`观众${i}`},gift:{name:'玫瑰',count:1,diamondCount:1}});
    return {allCountsOne:overlays.gifts.queue.every(item=>item.gift.count===1),history:overlays.gifts.history.length,queue:overlays.gifts.queue.length};
  });
  assert.deepEqual(anonymous,{allCountsOne:true,history:60,queue:24});
  report.checks.push('anonymous senders never merged; bounded presentation queue/history');
  await page.goto(`${base}?demo=gift&motion=auto`); await page.waitForTimeout(1000);
  await page.emulateMedia({reducedMotion:'reduce'}); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
  assert.ok(await page.evaluate(()=>[...document.querySelectorAll('.gift-barrage-item')].every(item=>getComputedStyle(item).transform==='none')));
  await page.emulateMedia({reducedMotion:'reduce'}); await page.goto(`${base}?demo=celebration&motion=auto`); await page.waitForTimeout(650);
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
  assert.equal(await page.evaluate(()=>window.socketAttempts),0);
  assert.ok(!requests.some(url=>url.includes('/api/') || !url.startsWith(base)));
  assert.deepEqual(errors,[]); report.errors=errors; report.checks.push('bounded 500-gift burst, reduced motion, demo network isolation');
  const loop = await browser.newPage({viewport:{width:390,height:844}, reducedMotion:'reduce'});
  loop.on('pageerror', error => errors.push(error.message));
  await loop.clock.install();
  await loop.goto(`${base}?demo=showcase&motion=reduced`);
  await loop.clock.runFor(10000);
  const running = await loop.evaluate(() => {
    const endsAt = state.round.endsAt;
    demoEmitGuess('测试词',50); demoUnlockHint(2,'补充提示','甜味',.5);
    return {sameDeadline:state.round.endsAt===endsAt,score:demoPlayers[0].score};
  });
  assert.deepEqual(running,{sameDeadline:true,score:3400});
  await loop.clock.runFor(80500);
  const continuous = await loop.evaluate(() => ({round:demoRoundNumber,score:demoPlayers[0].score,gifts:overlays.gifts.seen.size,queue:overlays.gifts.queue.length,timers:demoTimers.size,result:overlays.resultActive,celebration:overlays.celebration.active}));
  assert.equal(continuous.round,162); assert.equal(continuous.score,3700);
  assert.equal(continuous.gifts,8); assert.equal(continuous.queue,0);
  assert.ok(continuous.timers<=20); assert.equal(continuous.result,false); assert.equal(continuous.celebration,false);
  await loop.close();
  report.continuous=continuous; report.checks.push('two complete showcase loops: unique gifts, persistent scores, stable deadline, cleared result');
  await page.goto(`${base}?demo=start`);
  await page.evaluate(() => overlays.correct({word:'internationalization',nickname:'这是一位昵称特别特别长的观众朋友',pendingReward:150},state.round));
  const longAnswer = await page.evaluate(() => {
    const hero=document.querySelector('.celebration-hero'),word=hero.querySelector('strong'),reward=hero.querySelector('em'),safe=document.querySelector('.bottom-panel').getBoundingClientRect();
    const h=hero.getBoundingClientRect(),r=reward.getBoundingClientRect();
    return {wordFits:word.scrollWidth<=word.clientWidth+1,rewardFits:r.right<=h.right,aboveSticker:h.bottom<safe.top,text:word.textContent};
  });
  assert.equal(longAnswer.wordFits,true); assert.equal(longAnswer.rewardFits,true); assert.equal(longAnswer.aboveSticker,true);
  assert.equal(longAnswer.text,'internationalization');
  report.checks.push('long answer wraps fully; long nickname preserves reward and sticker space');
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
