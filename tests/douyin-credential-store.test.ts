import { mkdtemp, readFile, readdir, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DouyinCredentialStore, WindowsCredentialCipher, type CredentialCipher } from "../src/douyin/DouyinCredentialStore.js";
import { DouyinWebcastProxy } from "../src/douyin/DouyinWebcastProxy.js";

const dirs: string[] = [];
async function location() {
  const dir = await mkdtemp(join(tmpdir(), "douyin-auth-test-")); dirs.push(dir);
  return join(dir, "login.dpapi.json");
}
function cipher() {
  const sealed = new Map<string, string>();
  return {
    async protect(value: string) { const id = `encrypted-${sealed.size}`; sealed.set(id, value); return id; },
    async unprotect(value: string) { if (!sealed.has(value)) throw new Error("Synthetic private failure details"); return sealed.get(value)!; },
  } satisfies CredentialCipher;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (dirname(dir) !== tmpdir() || !basename(dir).startsWith("douyin-auth-test-")) throw new Error("Unsafe test cleanup target");
    await rm(dir, { recursive: true, force: true });
  }
});

describe("encrypted Douyin login cache", () => {
  it("saves atomically, restores in a fresh instance and exposes only metadata", async () => {
    const file = await location(), crypto = cipher();
    const store = new DouyinCredentialStore(file, crypto);
    expect(await store.load()).toBeNull();
    const expiresAt = Date.now() + 86400_000;
    expect(await store.save("sessionid=synthetic-private; ttwid=synthetic-device", expiresAt)).toBe(true);
    expect(await readFile(file, "utf8")).not.toMatch(/sessionid|synthetic-private|synthetic-device/);
    expect(await readdir(dirname(file))).toEqual(["login.dpapi.json"]);
    const next = new DouyinCredentialStore(file, crypto);
    expect(await next.load()).toMatchObject({ cookie: "sessionid=synthetic-private; ttwid=synthetic-device", expiresAt });
    expect(next.status().state).toBe("restored");
    expect(JSON.stringify(next.status())).not.toMatch(/sessionid|synthetic-private/);
  });
  it("does not restore expired, corrupt or another account's unreadable cache", async () => {
    const file = await location(), crypto = cipher(), store = new DouyinCredentialStore(file, crypto);
    await store.save("sessionid=synthetic-expired", Date.now() - 1000);
    const expired = new DouyinCredentialStore(file, crypto);
    expect(await expired.load()).toBeNull();expect(expired.status().state).toBe("expired");
    await store.save("sessionid=synthetic-new");
    const wrongAccount = new DouyinCredentialStore(file, cipher());
    expect(await wrongAccount.load()).toBeNull();expect(wrongAccount.status().state).toBe("error");
    expect(wrongAccount.status().message).not.toContain("Synthetic");
    await writeFile(file, '{"secret-malformed":');
    const corrupt = new DouyinCredentialStore(file, crypto);
    expect(await corrupt.load()).toBeNull();expect(corrupt.status().message).not.toContain("secret-malformed");
  });
  it("removes previous-account cache when encryption fails, never writes plaintext", async () => {
    const file = await location(), crypto = cipher(), store = new DouyinCredentialStore(file, crypto);
    await store.save("sessionid=synthetic-old");
    const broken = new DouyinCredentialStore(file, { ...crypto, protect: async () => { throw new Error("synthetic-secret"); } });
    expect(await broken.save("sessionid=synthetic-new")).toBe(false);
    expect(broken.status()).toMatchObject({ state: "error" });
    expect(broken.status().message).not.toContain("synthetic-secret");
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serializes save and logout so a delayed write cannot resurrect credentials", async () => {
    const file = await location(), crypto = cipher();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const store = new DouyinCredentialStore(file, { ...crypto, protect: async value => { await barrier; return crypto.protect(value); } });
    const saving = store.save("sessionid=synthetic-pending");
    const clearing = store.clear();
    release();await saving;await clearing;
    expect(store.status().state).toBe("empty");
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects malformed input without erasing an existing account and reports clear failures", async () => {
    const file = await location(), store = new DouyinCredentialStore(file, cipher());
    await store.save("sessionid=synthetic-retained");
    expect(() => store.save("sessionid=bad\r\nInjected=yes")).toThrow();
    expect(store.status().state).toBe("saved");
    await store.clear();await mkdir(file);
    await expect(store.clear()).rejects.toThrow("未能清除");
    expect(store.status().state).toBe("error");
  });
  it("proxy shutdown preserves encrypted login, while explicit logout removes it", async () => {
    const file = await location(), crypto = cipher();
    const first = new DouyinWebcastProxy(new DouyinCredentialStore(file, crypto));
    await first.setCookie("sessionid=synthetic-restart");
    first.disconnectClients();
    expect(first.diagnostics().cookie).toMatchObject({ hasLoginSession: true, storage: "encrypted-local" });
    first.close();
    const second = new DouyinWebcastProxy(new DouyinCredentialStore(file, crypto));
    await second.restoreCredentials();
    expect(second.diagnostics().cookie).toMatchObject({ hasLoginSession: true, validation: "unverified", persistence: { state: "restored" } });
    await second.clearCookie();second.close();
    const third = new DouyinWebcastProxy(new DouyinCredentialStore(file, crypto));
    await third.restoreCredentials();expect(third.diagnostics().cookie.hasLoginSession).toBe(false);third.close();
  });
  it.skipIf(process.platform !== "win32")("round trips a synthetic credential with actual Windows DPAPI", async () => {
    const file = await location(), store = new DouyinCredentialStore(file, new WindowsCredentialCipher());
    expect(await store.save("sessionid=synthetic-dpapi-test-not-a-real-account")).toBe(true);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toMatch(/sessionid|synthetic-dpapi/);
    const restarted = new DouyinCredentialStore(file, new WindowsCredentialCipher());
    expect((await restarted.load())?.cookie).toBe("sessionid=synthetic-dpapi-test-not-a-real-account");
    const parsed = JSON.parse(raw);parsed.cipherText = parsed.cipherText.slice(0, -8) + "AAAAAAAA";
    await writeFile(file, JSON.stringify(parsed));
    expect(await new DouyinCredentialStore(file).load()).toBeNull();
    await restarted.clear();
  }, 30_000);
});
