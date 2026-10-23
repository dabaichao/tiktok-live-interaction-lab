import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

describe("Douyin admin bridge session lifecycle", () => {
  it("renders fixed failure stages without exposing unknown text or inventing historical causes", () => {
    const nodes = new Map<string, any>();
    const element = (id:string) => {
      if(!nodes.has(id))nodes.set(id,{value:"",disabled:false,textContent:"",className:"",classList:{toggle(){}},addEventListener(){}});
      return nodes.get(id);
    };
    const context=createContext({document:{getElementById:element},location:{origin:"http://127.0.0.1:3002"},navigator:{},console,setInterval(){}});
    const script=readFileSync("tools/douyin-admin/app.js","utf8").replace(/\nrefresh\(\);\s*setInterval\(refresh, 2000\);\s*$/,'');
    runInContext(script,context);
    runInContext(`renderWebcastDiagnostics({douyin:{webcast:{decoder:{
      decodeErrors:{WebcastChatLikeMessage:3},
      decodeFailureReasons:{WebcastChatLikeMessage:{like_count_zero:1,like_payload_decode_failed:2,"private-error-text":99}}
    }}}})`,context);
    const text=element("diagnosticMethods").textContent;
    expect(text).toContain("解析失败 3");
    expect(text).toContain("点赞计数为零或缺省 1");
    expect(text).toContain("点赞载荷解析失败 2");
    expect(text).not.toContain("private-error-text");
    runInContext('renderWebcastDiagnostics({douyin:{webcast:{decoder:{decodeErrors:{WebcastChatLikeMessage:3}}}}})',context);
    expect(element("diagnosticMethods").textContent).toContain("未上报，无法追溯旧记录");
    expect(element("diagnosticMethods").textContent).not.toContain("点赞载荷解析失败");
  });
  it("splits big batches and ignores old client events after reconnect, without persisting the cookie", async () => {
    const nodes = new Map<string, any>();
    const requests: Array<{path:string; body:any}> = [];
    const clients: any[] = [];
    const element = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value:"", disabled:false, textContent:"", className:"", classList:{toggle(){}}, addEventListener(){} });
      return nodes.get(id);
    };
    let session = 0;
    let diagnosticStatus = 0;
    class FakeClient {
      listeners: Record<string, Function> = {};
      closed = 0;
      constructor() { clients.push(this); }
      on(name: string, callback: Function) { this.listeners[name] = callback; }
      async connect() {}
      close() { this.closed++; this.listeners.close?.(1000); }
      getDiagnostics() { return {frames:1}; }
    }
    const context = createContext({ document:{getElementById:element}, location:{origin:"http://127.0.0.1:3002"}, navigator:{}, console,
      setInterval(){}, confirm:()=>true, loadTestModule:async()=>({DyCast:FakeClient}),
      fetch:async (path: string, init?: {body?:string}) => {
        const body = JSON.parse(init?.body || "{}"); requests.push({path,body});
        if(path.endsWith("/diagnostics")&&diagnosticStatus)return {ok:false,status:diagnosticStatus,json:async()=>({error:"isolated diagnostic failure"})};
        const result = path.endsWith("/start") ? {connection:{sessionToken:`session-${++session}`,webRid:"123456789"}} : path.endsWith("/events") ? {accepted:body.messages.length} : {};
        return {ok:true,json:async()=>result};
      },
    });
    // The bundle itself is tested separately. Substitute only module loading to
    // exercise the actual UI event handlers without a browser or live service.
    const source = readFileSync("tools/douyin-admin/app.js", "utf8").replace('await import("/vendor/dycast/index.mjs?v=diagnostics-2")', 'await loadTestModule()');
    runInContext(source, context);
    element("webcastRoom").value = "123456789";
    element("webcastCookie").value = "sessionid=test-only";
    await runInContext("connectWebcast()", context);
    expect(element("webcastCookie").value).toBe("");
    const first = clients[0];
    first.listeners.message(Array.from({length:1200}, (_, i)=>({id:String(i),method:"WebcastLikeMessage",count:1})));
    await new Promise(resolve => setImmediate(resolve));
    expect(requests.filter(r=>r.path.endsWith("/events")).map(r=>r.body.messages.length)).toEqual([500,500,200]);
    await runInContext("connectWebcast()", context);
    const before = requests.length;
    first.listeners.message([{id:"stale"}]); first.listeners.error(new Error("stale")); first.listeners.close(1000);
    await new Promise(resolve => setImmediate(resolve));
    expect(requests.length).toBe(before);
    expect(requests.filter(r=>r.path.endsWith("/start"))[1].body.cookie).toBe("");
    clients[1].listeners.message([{id:"new",method:"WebcastLikeMessage",count:1}]);
    await new Promise(resolve => setImmediate(resolve));
    expect(requests.filter(r=>r.path.endsWith("/events")).at(-1)?.body.sessionToken).toBe("session-2");
    diagnosticStatus=500;
    await runInContext("refresh()",context);
    expect(clients[1].closed).toBe(0);
    diagnosticStatus=401;
    await runInContext("refresh()",context);
    expect(clients[1].closed).toBe(1);
  });
});
