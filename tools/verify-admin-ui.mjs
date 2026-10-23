// Read-only UI smoke test in a new isolated browser profile, no login actions.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:"playwright");
const base=process.env.ADMIN_QA_URL??"http://127.0.0.1:3002";
const status=await(await fetch(base+"/api/status")).json();
assert.ok(status.douyin?.webcastConnection?.cookie?.hasLoginSession,"Skip live-page smoke test without cached login: the admin can automatically open a login window.");
const browser=await chromium.launch({channel:"msedge",headless:true});
const errors=[],checks=[];
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on("pageerror",error=>errors.push(error.message));
  page.on("crash",()=>errors.push("renderer crashed"));
  await page.goto(base+"/douyin-admin/");
  await page.waitForFunction(()=>document.querySelector("#opGameState").textContent.includes("第"));
  for(const name of ["events","catalog","rules","game","records","connection"]){
    await page.locator(`[data-ops-tab="${name}"]`).click();
    assert.equal(await page.locator(`[data-ops-tab="${name}"]`).getAttribute("aria-current"),"page");
    checks.push(`运营页 ${name} 可切换`);
  }
  await page.goto(base+"/douyin-split/");
  await page.waitForFunction(()=>document.querySelectorAll("iframe").length===2);
  const game=page.frames().find(frame=>frame.url().includes("/test-word-game/"));assert.ok(game);
  await game.waitForFunction(()=>document.querySelector("#roundNo").textContent.includes("局"));
  assert.equal(await game.evaluate(()=>state.connection),"open");
  const layout=await game.evaluate(()=>({topRows:document.querySelectorAll(".guess-row").length,stickers:document.querySelector(".bottom-panel").childElementCount,scrollHeight:document.documentElement.scrollHeight,height:innerHeight}));
  assert.equal(layout.stickers,0);assert.ok(layout.scrollHeight<=layout.height+1);
  checks.push("正式分屏游戏收到服务快照，保留空白贴图区，无页面纵向溢出");
  await page.waitForTimeout(2500);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,readOnly:true,realPlatformVerified:false,checks,errors},null,2));
}finally{await browser.close();}
