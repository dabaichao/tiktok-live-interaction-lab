// Isolated burst-input check. No platform, real account, or paid model calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";

const root=resolve(import.meta.dirname,"..");
const directory=await mkdtemp(join(tmpdir(),"semantic-stability-"));
let modelRequests=0;
const model=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw||"{}").input?.[0]??"";
  modelRequests++;
  // Deterministic fixture vectors test delivery, not semantic model quality.
  const sum=[...input].reduce((n,c)=>n+c.codePointAt(0),0);
  res.setHeader("content-type","application/json");
  res.end(JSON.stringify({data:[{index:0,embedding:[1,1+(sum%13)/20,1+(sum%19)/20,1+(sum%23)/20]}]}));
});
model.listen(0,"127.0.0.1");await once(model,"listening");
const port=model.address().port;
const base="http://127.0.0.1:3014";
const child=spawn(process.execPath,["dist/douyin-server.js"],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,
  HOST:"127.0.0.1",DATA_DIR:directory,DOUYIN_PORT:"3014",DOUYIN_WS_PORT:"8774",HINT_LLM_API_KEY:"",EMBEDDING_API_KEY:"",
  SEMANTIC_LANGUAGE:"zh-Hans",SEMANTIC_ANSWER:"苹果",SEMANTIC_ROUND_DURATION_MS:"240000",EMBEDDING_BASE_URL:`http://127.0.0.1:${port}/v1`,EMBEDDING_TIMEOUT_MS:"1000"}});
let ready=false;child.stdout.on("data",data=>{if(String(data).includes("douyin_server_started"))ready=true;});child.stderr.resume();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,method="GET",body){
  const response=await fetch(base+path,{method,headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200,path);return response.json();
}
let socket;let frames=0;let latestCount=0;
try{
  for(let n=0;n<100&&!ready&&child.exitCode===null;n++)await delay(100);
  assert.ok(ready&&child.exitCode===null,"Own isolated child failed to start; do not reuse unrelated listeners.");
  const connection=await api("/api/douyin/webcast/start","POST",{webRid:"stability-room"});
  const sessionToken=connection.connection.sessionToken;
  await api("/api/douyin/webcast/state","POST",{sessionToken,state:{status:"connected",roomId:"1234567890"}});
  socket=new WebSocket("ws://127.0.0.1:8774/word-game");
  socket.on("message",raw=>{frames++;const message=JSON.parse(String(raw));if(message.metrics)latestCount=message.metrics.validGuesses;});
  await once(socket,"open");
  const before=await api("/api/status");
  const words=["香蕉","水果","海洋","森林","天空","河流","电脑","手机"];
  const started=performance.now();let accepted=0;let peakHeap=before.runtime.memory.heapUsed;let maxStatusLatency=0;
  for(let batch=0;batch<20;batch++){
    const messages=Array.from({length:500},(_,i)=>({id:`audit-${batch*500+i}`,method:"WebcastChatMessage",user:{id:`viewer-${i}`,name:`隔离观众${i}`,nicknameMasked:false},content:words[(batch+i)%words.length]}));
    accepted+=(await api("/api/douyin/webcast/events","POST",{sessionToken,messages})).accepted;
    const time=performance.now();const status=await api("/api/status");maxStatusLatency=Math.max(maxStatusLatency,performance.now()-time);peakHeap=Math.max(peakHeap,status.runtime.memory.heapUsed);
  }
  let after;
  for(let n=0;n<200;n++){after=await api("/api/status");peakHeap=Math.max(peakHeap,after.runtime.memory.heapUsed);if(after.game.metrics.validGuesses===10000)break;await delay(100);}
  assert.equal(accepted,10000);assert.equal(after.game.metrics.validGuesses,10000);assert.equal(after.game.metrics.uniqueGuessers,500);
  assert.ok(after.game.topGuesses.length<=14);
  assert.equal(new Set(after.game.topGuesses.map(g=>`${g.playerId}:${g.word}`)).size,after.game.topGuesses.length);
  assert.equal(after.runtime.recentEventCount,200);
  assert.ok(after.game.embedding.cacheEntries<=2048);assert.equal(after.game.embedding.mode,"embedding");
  const processedMs=performance.now()-started;
  await delay(200);assert.equal(latestCount,10000);
  const status=await api("/api/status");assert.equal(status.runtime.gameDelivery.slowClientsDisconnected,0);
  assert.ok(frames<1000,"Presentation must be coalesced without losing input counts.");
  console.log(JSON.stringify({ok:true,isolated:true,realPlatformVerified:false,vectorFixture:true,accepted,processed:after.game.metrics.validGuesses,viewers:500,elapsedMs:Math.round(processedMs),inputsPerSecond:Math.round(10000*1000/processedMs),maxStatusLatencyMs:Math.round(maxStatusLatency),websocketFrames:frames,modelRequests,rankingRows:after.game.topGuesses.length,recentEvents:after.runtime.recentEventCount,heapBeforeMB:Math.round(before.runtime.memory.heapUsed/1048576),peakObservedHeapMB:Math.round(peakHeap/1048576),heapAfterMB:Math.round(after.runtime.memory.heapUsed/1048576),rssAfterMB:Math.round(after.runtime.memory.rss/1048576)},null,2));
}finally{
  socket?.terminate();if(child.exitCode===null){const exited=once(child,"exit");child.kill();await exited;}
  await new Promise(resolve=>model.close(resolve));
}
