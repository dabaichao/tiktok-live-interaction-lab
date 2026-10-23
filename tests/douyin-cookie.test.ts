import { describe, expect, it } from "vitest";
import { DouyinCookieJar } from "../src/douyin/DouyinCookieJar.js";
import { isLocalAdminRequest } from "../src/douyin/LocalAccess.js";
import type { IncomingMessage } from "node:http";

describe("process-local Douyin cookies", () => {
  it("separates presence of credentials from validity and never returns their values in status", () => {
    const jar = new DouyinCookieJar();
    expect(jar.status()).toMatchObject({ configured: false, hasLoginSession: false });
    jar.setUserCookie("Cookie: sessionid=test-private; ttwid=test-anonymous");
    expect(jar.status()).toEqual({ configured: true, hasLoginSession: true, validation: "unverified", storage: "memory" });
    expect(JSON.stringify(jar.status())).not.toContain("test-private");
    expect(jar.header()).toBe("sessionid=test-private; ttwid=test-anonymous");
    jar.clear();
    expect(jar.header()).toBe("");
    expect(jar.status().configured).toBe(false);
  });
  it.each(["sessionid", "sessionid_ss", "sid_tt"])("recognizes %s without claiming the login is valid", key => {
    const jar = new DouyinCookieJar(); jar.setUserCookie(`${key}=test-only`);
    expect(jar.status()).toMatchObject({ hasLoginSession: true, validation: "unverified" });
  });
  it("does not mistake anonymous ttwid for a login", () => {
    const jar = new DouyinCookieJar(); jar.setUserCookie("ttwid=test-only");
    expect(jar.status()).toMatchObject({ configured: true, hasLoginSession: false });
  });
  it("rejects bad input atomically and with generic errors, without echoing secrets", () => {
    const jar = new DouyinCookieJar(); jar.setUserCookie("sessionid=retained-test");
    for (const input of ["", "sessionid=private\r\nHost: example.com", "not-a-cookie", "x=" + "a".repeat(16384)]) {
      expect(() => jar.setUserCookie(input)).toThrow(/Cookie/);
      expect(jar.header()).toBe("sessionid=retained-test");
    }
  });
  it("keeps anonymous Set-Cookie in memory and respects upstream credential expiry", () => {
    const jar = new DouyinCookieJar(); jar.setUserCookie("sessionid=test-only");
    jar.acceptUpstreamCookies(["ttwid=anonymous; Domain=.douyin.com; Secure; Path=/", "sessionid=; Max-Age=0; Path=/"]);
    expect(jar.header()).toBe("ttwid=anonymous");
    expect(jar.status().hasLoginSession).toBe(false);
    expect(new DouyinCookieJar().header()).toBe("");
  });
  it("also honors Expires in the past and negative Max-Age",()=>{
    const jar = new DouyinCookieJar();jar.setUserCookie('sessionid=synthetic; sid_tt=synthetic');
    jar.acceptUpstreamCookies(['sessionid=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT','sid_tt=gone; Max-Age=-1']);
    expect(jar.status().hasLoginSession).toBe(false);
  });
});

describe("local credential request boundary", () => {
  const request = (headers: Record<string, string>, address = "127.0.0.1") => ({ headers, socket: { remoteAddress: address } }) as IncomingMessage;
  it("allows same-origin local UI and local CLI", () => {
    expect(isLocalAdminRequest(request({ host:"127.0.0.1:3002", origin:"http://127.0.0.1:3002" }))).toBe(true);
    expect(isLocalAdminRequest(request({ host:"localhost:3002" }))).toBe(true);
  });
  it("rejects foreign origin, cross-site requests, nonlocal peers and DNS rebinding", () => {
    expect(isLocalAdminRequest(request({ host:"127.0.0.1:3002", origin:"https://example.com" }))).toBe(false);
    expect(isLocalAdminRequest(request({ host:"127.0.0.1:3002", "sec-fetch-site":"cross-site" }))).toBe(false);
    expect(isLocalAdminRequest(request({ host:"malicious.example:3002" }))).toBe(false);
    expect(isLocalAdminRequest(request({ host:"127.0.0.1:3002" }, "192.168.1.20"))).toBe(false);
  });
});
