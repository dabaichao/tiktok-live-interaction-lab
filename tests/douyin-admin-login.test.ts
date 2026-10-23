import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

function harness(created = true) {
  const nodes = new Map<string, any>();
  const requests: Array<{path:string;body:any}> = [];
  let status: any = {connectionMode:"none",douyin:{login:{phase:"idle",available:true},webcastConnection:{cookie:{hasLoginSession:false}}}};
  let failDiagnostics = false;
  let delayStart: Promise<unknown> | undefined;
  const element = (id: string) => {
    if (!nodes.has(id)) nodes.set(id,{value:"",disabled:false,textContent:"",className:"",classList:{toggle(){}},listeners:{},addEventListener(name:string,fn:Function){this.listeners[name]=fn;}});
    return nodes.get(id);
  };
  class FakeClient {
    on() {} async connect() {} close() {} getDiagnostics() { return {frames:0}; }
  }
  const context = createContext({ document:{getElementById:element}, location:{origin:"http://127.0.0.1:3002"}, navigator:{}, console,
    setInterval(){}, confirm:()=>true, loadTestModule:async()=>({DyCast:FakeClient}),
    fetch:async(path:string,init?:{body?:string}) => {
      const body = JSON.parse(init?.body || '{}'); requests.push({path,body});
      if (path.endsWith('/login/start')) {
        await delayStart;
        return {ok:true,json:async()=>({created,login:{phase:'opening',attemptId:'login-1',available:true}})};
      }
      if (path === '/api/status') return {ok:true,json:async()=>status};
      if (path.endsWith('/diagnostics') && failDiagnostics) return {ok:false,json:async()=>({error:'诊断会话已失效'})};
      if (path.endsWith('/webcast/start')) return {ok:true,json:async()=>({connection:{sessionToken:'live-token',webRid:'123456789'}})};
      return {ok:true,json:async()=>({login:{phase:'cancelled',available:true}})};
    },
  });
  const source = readFileSync('tools/douyin-admin/app.js','utf8')
    .replace('await import("/vendor/dycast/index.mjs?v=diagnostics-2")','await loadTestModule()')
    .replace(/\nrefresh\(\);\s*setInterval\(refresh, 2000\);\s*$/, '');
  runInContext(source,context);
  return { element, requests, run:(code:string)=>runInContext(code,context),
    setStatus:(next:any)=>{status=next;}, setDelay:(delay:Promise<unknown>)=>{delayStart=delay;},
    failDiagnostics:()=>{failDiagnostics=true;} };
}
const ready = {connectionMode:'none',douyin:{login:{phase:'ready',attemptId:'login-1',available:true,message:'登录态已获取'},webcastConnection:{cookie:{hasLoginSession:true}}}};

describe('Douyin admin automatic login state machine', () => {
  it('restores a saved login without opening the login helper and reports persistence failures', async () => {
    const h = harness();
    h.setStatus({ ...ready, douyin:{ ...ready.douyin, webcastConnection:{cookie:{hasLoginSession:true,storage:'encrypted-local',persistence:{state:'restored',message:'已恢复本机加密缓存'}}}} });
    await h.run('refresh()');
    expect(h.requests.some(r=>r.path.endsWith('/login/start'))).toBe(false);
    expect(h.element('loginTitle').textContent).toBe('已恢复上次登录');
    expect(h.element('cookieState').textContent).toContain('已恢复本机加密缓存');
    expect(h.element('loginPersistenceNotice').textContent).toContain('记住登录已启用');
    h.setStatus({douyin:{login:{phase:'error'},webcastConnection:{cookie:{hasLoginSession:false,persistence:{state:'error',message:'无法解密，请重新扫码'}}}}});
    await h.run('refresh()');
    expect(h.element('loginTitle').textContent).toBe('需要重新登录');
    expect(h.element('loginMessage').textContent).toContain('无法解密');
    h.setStatus(ready);await h.run('refresh()');
    expect(h.element('loginPersistenceNotice').textContent).toContain('重启到新版');
  });
  it('opens once and connects exactly once when the initiating tab observes readiness', async () => {
    const h = harness(); h.element('webcastRoom').value='123456789';
    await h.run('refresh()'); await h.run('refresh()');
    expect(h.requests.filter(r=>r.path.endsWith('/login/start'))).toHaveLength(1);
    h.setStatus(ready); await h.run('refresh()'); await h.run('refresh()');
    const starts = h.requests.filter(r=>r.path.endsWith('/webcast/start'));
    expect(starts).toHaveLength(1);
    expect(starts[0].body).toEqual({url:'123456789',cookie:''});
    expect(h.element('webcastCookie').value).toBe('');
  });
  it('does not auto-connect from another tab, even if it focuses the login window', async () => {
    const h = harness(false); h.element('webcastRoom').value='123456789';
    await h.run('refresh()'); await h.run('beginLogin(false)');
    h.setStatus(ready); await h.run('refresh()');
    expect(h.requests.some(r=>r.path.endsWith('/webcast/start'))).toBe(false);
  });
  it('prompts for a room if login completes before a room was entered', async () => {
    const h = harness(); await h.run('refresh()'); h.setStatus(ready); await h.run('refresh()');
    expect(h.element('webcastFeedback').textContent).toContain('请输入直播间链接');
    expect(h.requests.some(r=>r.path.endsWith('/webcast/start'))).toBe(false);
  });
  it('cancel invalidates a delayed login-start response and prevents a late auto-connect', async () => {
    const h = harness(); h.element('webcastRoom').value='123456789';
    let resolve!:()=>void; h.setDelay(new Promise<void>(r=>{resolve=r;}));
    const start = h.run('beginLogin(false)');
    await h.element('loginCancel').listeners.click();
    resolve(); await start;
    h.setStatus(ready); await h.run('refresh()');
    expect(h.requests.some(r=>r.path.endsWith('/webcast/start'))).toBe(false);
  });
  it.each(['cancelled','expired','error'])('does not reopen automatically after %s', async phase => {
    const h = harness(); h.setStatus({douyin:{login:{phase,available:true}}});
    await h.run('refresh()'); await h.run('refresh()');
    expect(h.requests.some(r=>r.path.endsWith('/login/start'))).toBe(false);
  });
  it('does not auto-open on an official connection or with an existing login', async () => {
    for (const data of [ready,{connectionMode:'official',douyin:{login:{phase:'idle',available:true}}}]) {
      const h = harness(); h.setStatus(data); await h.run('refresh()');
      expect(h.requests.some(r=>r.path.endsWith('/login/start'))).toBe(false);
    }
  });
  it('still refreshes login status when the old bridge token expires', async () => {
    const h = harness(); h.element('webcastRoom').value='123456789';
    await h.run('connectWebcast()'); h.failDiagnostics(); h.setStatus(ready);
    await h.run('refresh()');
    expect(h.requests.at(-1)?.path).toBe('/api/status');
    expect(h.element('loginTitle').textContent).toBe('登录态已获取');
  });
});
