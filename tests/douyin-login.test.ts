import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DouyinLoginService } from "../src/douyin/DouyinLoginService.js";

const { loginCookieHeader, loginCookieExpiry, isOfficialPage } = createRequire(import.meta.url)("../tools/douyin-login/policy.cjs");
class FakeChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  sent: any[] = [];
  send(value: unknown, callback?: Function) { this.sent.push(value); callback?.(); }
  kill = vi.fn(() => { this.exitCode = 0; this.connected = false; this.emit("exit", 0); return true; });
}
function setup(timeoutMs = 300_000) {
  const children: FakeChild[] = [];
  const accept = vi.fn();
  const service = new DouyinLoginService({ projectRoot:process.cwd(), timeoutMs, executable:()=>"electron-test-only", acceptCookie:accept,
    launch:()=>{ const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; } });
  return { service, children, accept };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("Douyin isolated login lifecycle", () => {
  it("waits for secure persistence and ignores completion after explicit logout", async () => {
    vi.useFakeTimers();
    let release!:()=>void;
    const accepted = vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
    const child = new FakeChild();
    const service = new DouyinLoginService({projectRoot:process.cwd(),executable:()=>"fake",launch:()=>child as unknown as ChildProcess,acceptCookie:accepted});
    const {login}=service.start();
    const message={type:"credentials",attemptId:login.attemptId,cookie:"sessionid=synthetic-only",expiresAt:Date.now()+60000};
    child.emit("message",message);child.emit("message",message);
    expect(service.status().phase).toBe("syncing");expect(accepted).toHaveBeenCalledTimes(1);
    service.cleared();release();await Promise.resolve();
    expect(service.status().phase).toBe("cancelled");
    expect(child.sent.some(message=>message.type==="accepted")).toBe(false);
    service.close();
  });
  it("restored credentials do not open another automatic login window",()=>{
    const {service,children}=setup();service.restored();
    expect(service.start(true).created).toBe(false);expect(children).toHaveLength(0);
    expect(service.status().phase).toBe("ready");
  });
  it("preserves acquired login on stop/switch; only explicit logout clears the phase",()=>{
    vi.useFakeTimers();
    const {service,children}=setup();
    const {login}=service.start();
    children[0].emit("message",{type:"credentials",attemptId:login.attemptId,cookie:"sessionid=synthetic-only"});
    expect(service.cancel().phase).toBe("ready");
    service.cleared();
    expect(service.status()).toMatchObject({phase:"cancelled",message:expect.stringContaining("清除")});
    service.close();
  });
  it("deduplicates tabs, delivers credentials exactly once and exposes no cookie", () => {
    vi.useFakeTimers();
    const {service, children, accept} = setup();
    const first = service.start(true);
    const child = children[0];
    expect(first.created).toBe(true);
    expect(service.start(true).created).toBe(false);
    expect(children).toHaveLength(1);
    child.emit("message", {type:"boot"});
    expect(child.sent.at(-1)).toEqual({type:"init",attemptId:first.login.attemptId});
    child.emit("message", {type:"waiting",attemptId:first.login.attemptId});
    expect(service.status().phase).toBe("waiting-user");
    child.emit("message", {type:"credentials",attemptId:"wrong",cookie:"sessionid=synthetic-secret"});
    expect(accept).not.toHaveBeenCalled();
    const message = {type:"credentials",attemptId:first.login.attemptId,cookie:"sessionid=synthetic-secret; ttwid=synthetic"};
    child.emit("message", message); child.emit("message", message);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(service.status().phase).toBe("ready");
    expect(child.sent.at(-1)).toEqual({type:"accepted"});
    expect(JSON.stringify(service.status())).not.toMatch(/synthetic|sessionid|ttwid/);
    expect(JSON.stringify(child.sent)).not.toContain("synthetic-secret");
    child.emit("message", {type:"cancelled",attemptId:first.login.attemptId});
    expect(service.status().phase).toBe("ready");
    expect(service.start(true).created).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("cancels safely and rejects late credentials even after another attempt starts", () => {
    vi.useFakeTimers();
    const {service, children, accept} = setup();
    const first = service.start();
    service.cancel();
    expect(service.start(true).created).toBe(false);
    const second = service.start();
    children[0].emit("message", {type:"credentials",attemptId:first.login.attemptId,cookie:"sessionid=stale"});
    children[0].emit("exit",0);
    expect(service.status().attemptId).toBe(second.login.attemptId);
    expect(accept).not.toHaveBeenCalled();
    expect(service.status().phase).toBe("opening");
    service.close();
    children[1].emit("message", {type:"credentials",attemptId:second.login.attemptId,cookie:"sessionid=too-late"});
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(["ttwid=anonymous", "sessionid=bad\r\nInjected=yes", { sessionid:"not-a-string" }])("rejects invalid credentials without leaking them: %j", cookie => {
    vi.useFakeTimers();
    const {service, children, accept} = setup();
    const {login} = service.start();
    children[0].emit("message", {type:"credentials",attemptId:login.attemptId,cookie});
    expect(service.status().phase).toBe("error");
    expect(accept).not.toHaveBeenCalled();
    expect(JSON.stringify(service.status())).not.toMatch(/anonymous|Injected|sessionid/);
  });

  it("handles timeout, child crash, spawn failure and missing binary in Chinese", () => {
    vi.useFakeTimers();
    const {service,children} = setup(100);
    service.start();
    vi.advanceTimersByTime(100);
    expect(service.status().phase).toBe("expired");
    service.start(); children[1].emit("error",new Error("secret-token-should-not-appear"));
    expect(service.status().phase).toBe("error");
    expect(service.status().message).not.toContain("secret-token");
    const missing = new DouyinLoginService({projectRoot:"missing",acceptCookie:()=>{},executable:()=>undefined});
    expect(missing.start().login).toMatchObject({phase:"error",available:false});
    const failed = new DouyinLoginService({projectRoot:"missing",acceptCookie:()=>{},executable:()=>"fake",launch:()=>{throw new Error("secret");}});
    expect(failed.start().login.message).toBe("登录窗口启动失败，请检查本机登录组件。");
  });
});

describe("Login helper credential and navigation boundaries", () => {
  const base = {domain:".douyin.com",path:"/",secure:true,httpOnly:true};
  it("exports only known authentication-cookie expiry without inventing a session lifetime",()=>{
    expect(loginCookieExpiry([{...base,name:'sessionid',value:'synthetic'}],1000)).toBeUndefined();
    expect(loginCookieExpiry([{...base,name:'sessionid',value:'synthetic',expirationDate:2000},{...base,name:'ttwid',value:'synthetic',expirationDate:1001}],1000)).toBe(2000000);
    expect(loginCookieExpiry([{...base,name:'sessionid',value:'synthetic',domain:'unrelated.example',expirationDate:2000}],1000)).toBeUndefined();
  });
  it("collects only live-origin cookies including HttpOnly without exposing other accounts", () => {
    const header = loginCookieHeader([
      {...base,name:"sessionid",value:"test-session"}, {...base,name:"ttwid",value:"test-device"},
      {...base,domain:"evil-douyin.com",name:"evil",value:"secret"},
      {...base,domain:"passport.douyin.com",name:"passport-only",value:"secret"},
      {...base,path:"/unrelated",name:"path-only",value:"secret"},
      {...base,name:"expired",value:"secret",expirationDate:1},
      {...base,name:"injection",value:"hello; sessionid=x"},
    ]);
    expect(header).toBe("sessionid=test-session; ttwid=test-device");
    expect(loginCookieHeader([{...base,name:"ttwid",value:"anonymous"}])).toBe("");
    expect(loginCookieHeader([{...base,name:"sessionid",value:"x".repeat(17000)}])).toBe("");
  });
  it.each(["https://live.douyin.com/","https://www.douyin.com/","https://passport.douyin.com/"])("permits official HTTPS login navigation %s", url => {
    expect(isOfficialPage(url)).toBe(true);
  });
  it.each(["http://live.douyin.com/","file:///C:/", "https://douyin.com.evil.test/", "https://evildouyin.com/", "https://user:pass@live.douyin.com/", "https://live.douyin.com:1234/", "javascript:alert(1)"])("blocks unsafe navigation %s", url => {
    expect(isOfficialPage(url)).toBe(false);
  });
});
