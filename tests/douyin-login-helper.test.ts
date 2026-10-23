import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const policy = createRequire(import.meta.url)('../tools/douyin-login/policy.cjs');
function helper() {
  const outbound: any[] = [];
  const proc = Object.assign(new EventEmitter(), {connected:true, send:(m:unknown, cb:Function)=>{outbound.push(m);cb();}});
  const cookies = [{name:'sessionid',value:'synthetic-test-session',domain:'.douyin.com',path:'/',httpOnly:true}];
  const isolated = Object.assign(new EventEmitter(), {setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),
    cookies:{get:vi.fn(async()=>cookies)},clearStorageData:vi.fn(async()=>{}),clearCache:vi.fn(async()=>{})});
  const fromPartition = vi.fn(()=>isolated);
  const app = Object.assign(new EventEmitter(), {whenReady:async()=>{},exit:vi.fn()});
  const windows: any[] = [];
  class FakeWindow extends EventEmitter {
    options:any; destroyed = false;
    webContents = Object.assign(new EventEmitter(),{setWindowOpenHandler:vi.fn()});
    constructor(options:any) {super();this.options=options;windows.push(this);}
    removeMenu(){} isDestroyed(){return this.destroyed;} setTitle(){} show(){} focus(){}
    destroy(){this.destroyed=true;this.emit('closed');}
    loadURL = vi.fn(async()=>{});
  }
  const ctx = createContext({process:proc,require:(id:string)=>id==='electron'?{app,BrowserWindow:FakeWindow,session:{fromPartition}}:id==='node:crypto'?{randomUUID:()=> 'synthetic-partition'}:policy,
    setTimeout,clearTimeout,setInterval,clearInterval,Date});
  runInContext(readFileSync('tools/douyin-login/main.cjs','utf8'),ctx);
  return {proc,outbound,isolated,fromPartition,app,windows};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('Isolated login helper main process',()=>{
  it('uses an ephemeral sandbox and transfers settled synthetic cookies over IPC then clears them',async()=>{
    vi.useFakeTimers();
    const h=helper(); expect(h.outbound).toEqual([{type:'boot',attemptId:undefined}]);
    h.proc.emit('message',{type:'init',attemptId:'test-attempt'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fromPartition).toHaveBeenCalledWith('douyin-login-synthetic-partition',{cache:false});
    expect(h.windows[0].options.webPreferences).toMatchObject({nodeIntegration:false,sandbox:true,contextIsolation:true,webSecurity:true,webviewTag:false,devTools:false});
    expect(h.windows[0].options.webPreferences.preload).toBeUndefined();
    expect(h.windows[0].loadURL).toHaveBeenCalledWith('https://live.douyin.com/');
    expect(h.outbound.at(-1)).toMatchObject({type:'waiting'});
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.outbound.some(m=>m.type==='credentials')).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.outbound.filter(m=>m.type==='credentials')).toEqual([{type:'credentials',attemptId:'test-attempt',cookie:'sessionid=synthetic-test-session'}]);
    h.proc.emit('message',{type:'accepted'});
    await vi.advanceTimersByTimeAsync(0);
    expect(h.windows[0].destroyed).toBe(true);
    expect(h.isolated.clearStorageData).toHaveBeenCalledOnce();
    expect(h.isolated.clearCache).toHaveBeenCalledOnce();
    expect(h.app.exit).toHaveBeenCalledWith(0);
  });
  it('cannot send credentials after cancellation or parent disconnect',async()=>{
    vi.useFakeTimers();
    const h=helper(); h.proc.emit('message',{type:'init',attemptId:'test-attempt'});
    await vi.advanceTimersByTimeAsync(0);
    h.proc.emit('disconnect');
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.outbound.some(m=>m.type==='credentials')).toBe(false);
    expect(h.app.exit).toHaveBeenCalledWith(0);
  });
});
