// Actual process restarts + Windows DPAPI; only synthetic credentials in a temp directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const dir=await mkdtemp(join(tmpdir(),'douyin-cache-restart-'));
const file=join(dir,'douyin','login.dpapi.json');
const base='http://127.0.0.1:3013';
const synthetic='sessionid=synthetic-restart-check-not-a-real-account';
let child;
const checks=[];
async function start() {
  let ready=false,failed=false;
  child=spawn(process.execPath,['dist/douyin-server.js'],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOST:'127.0.0.1',DOUYIN_PORT:'3013',DOUYIN_WS_PORT:'8773',DATA_DIR:dir,
      HINT_LLM_API_KEY:'',EMBEDDING_API_KEY:'',EMBEDDING_BASE_URL:'http://127.0.0.1:1/v1'},
  });
  child.stdout.on('data',data=>{if(String(data).includes('douyin_server_started'))ready=true;});
  child.stderr.resume();child.on('exit',()=>{failed=true;});
  for(let i=0;i<100&&!ready&&!failed;i++)await new Promise(resolve=>setTimeout(resolve,150));
  assert.ok(ready&&!failed,'Isolated test service failed to start; no unrelated process was stopped.');
}
async function stop() {
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  child=undefined;
}
async function api(path,method='GET',body) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20_000)});
  assert.equal(response.status,200,`${method} ${path} failed`);
  const result=await response.json();assert.ok(!JSON.stringify(result).includes('synthetic-restart-check'));
  return result;
}
try {
  await start();
  assert.equal((await api('/api/status')).douyin.webcastConnection.cookie.hasLoginSession,false);
  await api('/api/douyin/webcast/start','POST',{webRid:'cacheTestA',cookie:synthetic});
  let status=await api('/api/status');
  assert.equal(status.douyin.webcastConnection.cookie.persistence.state,'saved');
  assert.equal(status.douyin.webcastConnection.cookie.storage,'encrypted-local');
  const encrypted=await readFile(file,'utf8');assert.ok(!encrypted.includes('sessionid'));assert.ok(!encrypted.includes('synthetic-restart'));
  await api('/api/douyin/stop','POST',{});
  await api('/api/douyin/webcast/start','POST',{webRid:'cacheTestB'});
  assert.equal((await api('/api/status')).douyin.webcastConnection.cookie.hasLoginSession,true);
  checks.push('合成登录凭证经真实 DPAPI 加密；停止数据和换房保留缓存；接口不返回凭证');
  await stop();await start();
  status=await api('/api/status');
  assert.equal(status.douyin.webcastConnection.cookie.persistence.state,'restored');
  assert.equal(status.douyin.webcastConnection.cookie.hasLoginSession,true);
  assert.equal(status.douyin.login.phase,'ready');
  const login=await api('/api/douyin/webcast/login/start','POST',{automatic:true});
  assert.equal(login.created,false);
  checks.push('真实进程重启后自动恢复，不重复打开扫码窗口');
  await api('/api/douyin/webcast/cookie','DELETE');
  await assert.rejects(access(file),{code:'ENOENT'});
  await stop();await start();
  status=await api('/api/status');assert.equal(status.douyin.webcastConnection.cookie.hasLoginSession,false);
  checks.push('主动退出删除加密缓存；再次重启不复活旧账号');
  await stop();await writeFile(file,'{"version":1,"cipherText":"damaged"}');await start();
  status=await api('/api/status');assert.equal(status.douyin.webcastConnection.cookie.hasLoginSession,false);
  assert.equal(status.douyin.webcastConnection.cookie.persistence.state,'error');
  checks.push('损坏缓存不恢复，接口提供中文重新扫码提示');
  console.log(JSON.stringify({ok:true,isolated:true,realPlatformVerified:false,checks},null,2));
} finally {await stop();}
