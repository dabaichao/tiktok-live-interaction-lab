import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DouyinCookieJar } from "./DouyinCookieJar.js";

export interface CredentialCipher {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}

// Only this constant program is a command-line argument. Credential bytes travel
// through private stdin/stdout pipes, never arguments, environment, disk or logs.
const DPAPI_PROGRAM = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $entropy = [Text.Encoding]::UTF8.GetBytes('SemanticLive.Douyin.Login.v1')
  if ($request.operation -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $bytes = [Convert]::FromBase64String([string]$request.value)
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Array]::Clear($result, 0, $result.Length)
} catch { exit 1 }
`;

export class WindowsCredentialCipher implements CredentialCipher {
  private transform(operation: "protect" | "unprotect", value: string): Promise<string> {
    if (process.platform !== "win32") return Promise.reject(new Error("当前系统未配置安全凭证存储，不会明文保存。"));
    return new Promise((resolve, reject) => {
      const binary = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = spawn(binary, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROGRAM], {
        windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|SystemDrive|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))),
      });
      let output = "", settled = false;
      const fail = () => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(new Error("本机登录凭证加密或解密失败。")); };
      const timer = setTimeout(fail, 15_000);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("ascii"); if (output.length > 100_000) fail(); });
      child.on("close", code => {
        if (settled) return;
        if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) { fail(); return; }
        settled = true; clearTimeout(timer);
        resolve(operation === "protect" ? output : Buffer.from(output, "base64").toString("utf8"));
      });
      child.stdin.end(JSON.stringify({ operation, value }));
    });
  }
  protect(value: string) { return this.transform("protect", value); }
  unprotect(value: string) { return this.transform("unprotect", value); }
}

const credentialsSchema = z.object({ version: z.literal(1), cookie: z.string().min(1).max(16384), savedAt: z.number().finite(), expiresAt: z.number().finite().optional() });
const envelopeSchema = z.object({ version: z.literal(1), protection: z.literal("windows-dpapi-current-user"), cipherText: z.string().min(1).max(100_000) });
export type SavedCredentials = z.infer<typeof credentialsSchema>;
export type CredentialState = "empty" | "saving" | "saved" | "restored" | "expired" | "rejected" | "error";
export interface CredentialStatus { state: CredentialState; message: string; savedAt?: number; expiresAt?: number; }

/** One encrypted account per local installation. Never exports credential values. */
export class DouyinCredentialStore {
  private pending: Promise<unknown> = Promise.resolve();
  private current: CredentialStatus = { state: "empty", message: "尚未保存登录态；扫码后将自动在本机加密保存。" };
  constructor(readonly file: string, private readonly cipher: CredentialCipher = new WindowsCredentialCipher()) {}
  status(): CredentialStatus { return { ...this.current }; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }
  async flush(): Promise<void> { await this.pending; }

  load(): Promise<SavedCredentials | null> {
    return this.serial(async () => {
      try {
        if ((await stat(this.file)).size > 120_000) throw new Error("oversize");
        const envelope = envelopeSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
        const payload = credentialsSchema.parse(JSON.parse(await this.cipher.unprotect(envelope.cipherText)));
        const check = new DouyinCookieJar(); check.setUserCookie(payload.cookie);
        if (!check.status().hasLoginSession) throw new Error("missing session");
        check.clear();
        if (payload.expiresAt !== undefined && payload.expiresAt <= Date.now()) {
          this.current = { state: "expired", message: "保存的登录态已到期，请重新扫码。", expiresAt: payload.expiresAt };
          return null;
        }
        this.current = { state: "restored", message: "已从本机加密缓存恢复登录态；平台有效性待连接验证。", savedAt: payload.savedAt, expiresAt: payload.expiresAt };
        return payload;
      } catch (error) {
        this.current = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { state: "empty", message: "尚未保存登录态；扫码后将自动在本机加密保存。" }
          : { state: "error", message: "无法解密或读取保存的登录态，请在当前 Windows 账号重新扫码。" };
        return null;
      }
    });
  }

  save(cookie: string, expiresAt?: number): Promise<boolean> {
    // Validate before queuing; malformed input must not erase an existing login.
    const check = new DouyinCookieJar(); check.setUserCookie(cookie);
    if (!check.status().hasLoginSession) throw new Error("未发现可保存的登录字段。");
    check.clear();
    const payload = credentialsSchema.parse({ version: 1, cookie, savedAt: Date.now(), expiresAt });
    return this.serial(async () => {
      this.current = { state: "saving", message: "正在本机加密保存登录态……" };
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const cipherText = await this.cipher.protect(JSON.stringify(payload));
        await mkdir(dirname(this.file), { recursive: true });
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, protection: "windows-dpapi-current-user", cipherText })); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, this.file);
        this.current = { state: "saved", message: "登录态已在本机加密保存，服务重启后自动恢复。", savedAt: payload.savedAt, expiresAt };
        return true;
      } catch {
        // Do not silently fall back to plaintext or later restore the previous account.
        let removed = true;
        try { await unlink(this.file); } catch (error) { removed = (error as NodeJS.ErrnoException).code === "ENOENT"; }
        this.current = { state: "error", message: removed
          ? "登录态仅在当前运行中可用：加密保存失败，重启后需重新扫码。"
          : "登录态保存失败，且旧缓存未能清除。请检查本机目录权限后退出账号重试。" };
        return false;
      } finally { await unlink(temp).catch(() => undefined); }
    });
  }

  clear(state: "empty" | "expired" | "rejected" = "empty"): Promise<void> {
    return this.serial(async () => {
      try {
        await unlink(this.file).catch(error => { if (error.code !== "ENOENT") throw error; });
        this.current = { state, message: state === "expired" ? "登录态已到期，请重新扫码。" : state === "rejected" ? "平台要求重新登录，请扫码后再连接。" : "已清除本机保存的登录态。" };
      } catch {
        this.current = { state: "error", message: "本次连接已断开，但本机登录缓存未能清除，请检查目录权限后重试退出。" };
        throw new Error(this.current.message);
      }
    });
  }
}
