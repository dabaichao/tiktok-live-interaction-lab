import { createServer } from "node:http";
import { once } from "node:events";
import { request as secureRequest } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DouyinWebcastProxy, summarizeWebcastHandshake } from "../src/douyin/DouyinWebcastProxy.js";

vi.mock("node:https", async () => {
  const { PassThrough } = await import("node:stream");
  return { request: vi.fn((_options, callback) => {
    const request = Object.assign(new PassThrough(), { setTimeout() { return this; } });
    queueMicrotask(() => {
      const response = Object.assign(new PassThrough(), { statusCode:200, headers:{ "set-cookie":["ttwid=upstream-test; Domain=.douyin.com; Secure; Path=/"] } });
      callback(response); response.end("room-page-test");
    });
    return request;
  }) };
});

describe("credential-bearing HTTP proxy", () => {
  afterEach(() => vi.clearAllMocks());
  async function setup() {
    const proxy = new DouyinWebcastProxy();
    const server = createServer((req, res) => proxy.handleHttp(req, res));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    return { proxy, base:`http://127.0.0.1:${address.port}`, async close() { proxy.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
  }
  it("sends supplied cookies only upstream and never exposes Set-Cookie or values to the browser", async () => {
    const test = await setup();
    try {
      test.proxy.setCookie("sessionid=private-test");
      const response = await fetch(`${test.base}/dylive/123456789`, {headers:{cookie:"localhost-secret=must-not-forward"}});
      expect(await response.text()).toBe("room-page-test");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const options = vi.mocked(secureRequest).mock.calls[0][0] as {hostname:string;headers:{cookie:string}};
      expect(options.hostname).toBe("live.douyin.com");
      expect(options.headers.cookie).toBe("sessionid=private-test");
      expect(JSON.stringify(test.proxy.diagnostics())).not.toContain("private-test");
    } finally { await test.close(); }
  });
  it("reports handshake identity health without exposing identifiers or signatures",()=>{
    const result=summarizeWebcastHandshake("/webcast/im/push/v2/?room_id=room-1&user_unique_id=user-9&identity=audience&signature=secret-signature&msToken=secret-token",true);
    expect(result).toEqual({signaturePresent:true,signatureLength:16,msTokenPresent:true,identity:"audience",userUniqueIdPresent:true,userUniqueIdLength:6,roomIdMatchesUserId:false,cookieAttached:true});
    expect(JSON.stringify(result)).not.toMatch(/secret|room-1|user-9/);
  });
  it("blocks foreign-origin and arbitrary proxy targets before making an upstream request", async () => {
    const test = await setup();
    try {
      for (const path of ["/dylive//example.com/123456789", "/dylive/webcast/not-allowed/"]) {
        const response = await fetch(test.base + path);
        expect(response.status).toBe(400);
      }
      expect((await fetch(`${test.base}/dylive/123456789`, {headers:{origin:"https://example.com"}})).status).toBe(403);
      expect(secureRequest).not.toHaveBeenCalled();
    } finally { await test.close(); }
  });
  it("ignores late Set-Cookie after logout and after switching account", async()=>{
    for(const replacement of [undefined,"sessionid=synthetic-next-account"]) {
      const test=await setup();
      try {
        await test.proxy.setCookie("sessionid=synthetic-old-account");
        let release!:()=>void, started!:()=>void;
        const observed=new Promise<void>(resolve=>{started=resolve;});
        (vi.mocked(secureRequest) as any).mockImplementationOnce((_options:unknown,callback:Function)=>{
          const request=Object.assign(new PassThrough(),{setTimeout(){return this;}});
          release=()=>{const response=Object.assign(new PassThrough(),{statusCode:200,headers:{"set-cookie":["sessionid=synthetic-late"]}});callback(response);response.end("test");};
          started();return request;
        });
        const response=fetch(`${test.base}/dylive/123456789`);
        await observed;
        if(replacement)await test.proxy.setCookie(replacement);else await test.proxy.clearCookie();
        release();await (await response).text();
        expect(test.proxy.diagnostics().cookie.hasLoginSession).toBe(Boolean(replacement));
        await (await fetch(`${test.base}/dylive/123456789`)).text();
        const options=vi.mocked(secureRequest).mock.calls.at(-1)![0] as any;
        expect(options.headers.cookie).toBe(replacement || "");
      } finally {await test.close();}
    }
  });
  it("requires login again on HTTP 401 but does not clear credentials on 403 or network failures",async()=>{
    const test=await setup();
    try {
      for(const code of [403,502,401]) {
        await test.proxy.setCookie("sessionid=synthetic-auth-check");
        (vi.mocked(secureRequest) as any).mockImplementationOnce((_options:unknown,callback:Function)=>{
          const request=Object.assign(new PassThrough(),{setTimeout(){return this;}});
          queueMicrotask(()=>{const response=Object.assign(new PassThrough(),{statusCode:code,headers:{}});callback(response);response.end("test");});
          return request;
        });
        await (await fetch(`${test.base}/dylive/123456789`)).text();
        expect(test.proxy.diagnostics().cookie.hasLoginSession).toBe(code!==401);
      }
      expect(test.proxy.diagnostics().cookie.validation).toBe("rejected");
    }finally{await test.close();}
  });
});
