// Isolated HTTP smoke test: no real platform connection, cookies or model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";

const root=resolve(import.meta.dirname,"..");
const dir=await mkdtemp(join(tmpdir(),"douyin-http-check-"));
const base="http://127.0.0.1:3012";
const child=spawn(process.execPath,["dist/douyin-server.js"],{
  cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],
  env:{...process.env,HOST:"127.0.0.1",DOUYIN_PORT:"3012",DOUYIN_WS_PORT:"8772",DATA_DIR:dir,
    SEMANTIC_LANGUAGE:"zh-Hans",SEMANTIC_ANSWER:"苹果",SEMANTIC_ROUND_DURATION_MS:"240000",
    HINT_LLM_API_KEY:"",EMBEDDING_API_KEY:"",EMBEDDING_BASE_URL:"http://127.0.0.1:1/v1"},
});
let ready=false,failed=false;
child.stdout.on("data",data=>{if(String(data).includes("douyin_server_started"))ready=true;});
child.stderr.resume();
child.on("exit",()=>{failed=true;});
const checks=[];
const delay=()=>new Promise(resolve=>setTimeout(resolve,150));
async function api(path,method="GET",body,expected=200,headers={}) {
  const response=await fetch(`${base}${path}`,{method,headers:{"Content-Type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  const value=await response.json();
  assert.equal(response.status,expected,`Unexpected HTTP status for ${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
let socket;
try {
  for(let i=0;i<100&&!ready&&!failed;i++)await delay();
  assert.ok(ready&&!failed,"Isolated server did not start; do not reuse or stop an unrelated listener.");
  for(const path of ["/douyin-admin/","/douyin-admin/operations.js","/douyin-split/","/test-word-game/","/vendor/dycast/index.mjs"])assert.equal((await fetch(base+path)).status,200);
  checks.push("后台、分屏、游戏与已打包连接脚本均可访问");
  await api("/api/douyin/operations","GET",undefined,403,{Origin:"https://untrusted.example"});
  checks.push("跨站请求被拒绝");
  let view=await api("/api/douyin/operations");
  await api("/api/douyin/operations/catalog/sync","POST",{},400);
  const result=await api("/api/douyin/operations/simulate","POST",{trigger:"gift",unitPrice:20,quantity:3});
  assert.equal(result.plan.randomWords,600);assert.equal(result.simulation,true);
  assert.deepEqual((await api("/api/douyin/operations")).records,[]);
  checks.push("20 单价 × 3 份 × 10 = 600 词，隔离预演不写入真实记录");
  view=await api("/api/douyin/operations/rules","PUT",{revision:view.revision,rules:[
    {id:"smoke-time",name:"隔离礼物只加时",enabled:true,trigger:"gift",match:"gift",giftId:"smoke-gift",actions:[{type:"extra_time",amount:30,basis:"quantity"}]},
    {id:"smoke-likes",name:"隔离点赞仅展示",enabled:true,trigger:"like",match:"default",actions:[]},
  ]});
  await api("/api/douyin/operations/rules","PUT",{revision:view.revision-1,rules:[]},400);
  view=await api("/api/douyin/operations/game","PUT",{revision:view.revision,game:{answer:"苹果"},presentation:{...view.presentation,directionHint:"水果的一种",winnerPoints:250}});
  assert.equal(view.config.game.answer,"苹果");
  assert.equal(view.presentation.winnerPoints,250);
  checks.push("规则与游戏设置保存成功，旧版本保存被拒绝");
  socket=new WebSocket("ws://127.0.0.1:8772/word-game");
  const [frame]=await once(socket,"message");
  assert.equal(JSON.parse(String(frame)).type,"ROOM_SNAPSHOT");
  checks.push("游戏 WebSocket 可收到真实服务快照");
  const login=await api("/api/douyin/webcast/start","POST",{webRid:"smokeRoomA",cookie:"sessionid=isolated_not_a_real_login"});
  const token=login.connection.sessionToken;
  await api("/api/douyin/operations/catalog/import","POST",{gifts:[{id:"smoke-gift",name:"隔离礼物",price:20}]});
  let before=await api("/api/douyin/operations");
  const gift={method:"WebcastGiftMessage",user:{id:"smoke-user",name:"隔离测试观众"},gift:{id:"smoke-gift",name:"隔离礼物",price:20,count:2,type:1,groupId:"combo-1"}};
  await api("/api/douyin/webcast/events","POST",{sessionToken:token,messages:[
    {...gift,id:"progress",gift:{...gift.gift,repeatEnd:0}},
    {...gift,id:"final",gift:{...gift.gift,repeatEnd:1}},
    {...gift,id:"duplicate-final",gift:{...gift.gift,repeatEnd:1}},
  ]});
  view=await api("/api/douyin/operations");
  assert.equal(view.records.length,1);
  assert.equal(view.records[0].appliedTimeMs,60000);
  assert.equal(view.records[0].completedWords,0);
  assert.equal(view.game.round.endsAt,before.game.round.endsAt+60000);
  assert.equal(view.game.hintsUnlocked,0);
  checks.push("连击只结算一次：2 份礼物加时 60 秒，无随机词或隐含提示");
  await api("/api/douyin/operations/game/control","POST",{action:"pause"});
  assert.equal((await api("/api/douyin/operations")).game.round.status,"PAUSED");
  await api("/api/douyin/operations/game/control","POST",{action:"resume"});
  assert.equal((await api("/api/douyin/operations")).game.round.status,"RUNNING");
  checks.push("暂停与继续可控制游戏");
  const stopped=await api("/api/douyin/stop","POST",{});
  assert.equal(stopped.douyin.webcastConnection.cookie.hasLoginSession,true);
  await api("/api/douyin/webcast/start","POST",{webRid:"smokeRoomB"});
  assert.equal((await api("/api/status")).douyin.webcastConnection.cookie.hasLoginSession,true);
  view=await api("/api/douyin/operations");
  assert.equal(view.catalog.gifts.length,0);assert.equal(view.records.length,0);
  assert.deepEqual(view.game.scoreboard,[]);
  await api("/api/douyin/webcast/events","POST",{sessionToken:token,messages:[{...gift,id:"stale"}]},401);
  checks.push("停止和换房保留登录字段；礼物库、榜单和会话隔离");
  const loggedOut=await api("/api/douyin/webcast/cookie","DELETE");
  assert.equal(loggedOut.douyin.webcastConnection.cookie.hasLoginSession,false);
  checks.push("只有明确退出账号才清除登录字段");
  const persisted=JSON.parse(await readFile(join(dir,"douyin","operations.json"),"utf8"));
  assert.equal(persisted.gameConfig.game.answer,"苹果");
  assert.equal(persisted.presentation.winnerPoints,250);
  assert.ok(!JSON.stringify(persisted).includes("isolated_not_a_real_login"));
  checks.push("运营配置持久化，不包含 Cookie；登录凭证使用独立加密缓存");
  console.log(JSON.stringify({ok:true,isolated:true,realPlatformVerified:false,checks},null,2));
} finally {
  socket?.terminate();
  // This is exactly the child created above, never a process found by port.
  if(child.exitCode===null) {const exited=once(child,"exit");child.kill();await exited;}
}
