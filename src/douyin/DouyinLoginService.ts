import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DouyinCookieJar } from "./DouyinCookieJar.js";

type LoginPhase = "idle" | "opening" | "waiting-user" | "syncing" | "ready" | "cancelled" | "expired" | "error";
export interface LoginStatus {
  phase: LoginPhase;
  available: boolean;
  attemptId?: string;
  startedAt?: number;
  expiresAt?: number;
  message: string;
}
interface Options {
  projectRoot: string;
  acceptCookie: (cookie: string, expiresAt?: number) => void | Promise<void>;
  timeoutMs?: number;
  // Dependency injection keeps tests independent of an actual browser/account.
  executable?: () => string | undefined;
  launch?: (executable: string, helper: string) => ChildProcess;
}
const active = new Set<LoginPhase>(["opening", "waiting-user", "syncing"]);

/** A private child-process IPC channel, never an HTTP credential callback. */
export class DouyinLoginService {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private current: Omit<LoginStatus, "available"> = { phase: "idle", message: "尚未打开抖音登录窗口。" };
  private readonly executable: () => string | undefined;

  constructor(private readonly options: Options) {
    // Do not require('electron') here: recent versions may synchronously download
    // a binary. A missing helper must never prevent the live service from starting.
    this.executable = options.executable ?? (() => {
      try {
        const packageDir = join(options.projectRoot, "node_modules", "electron");
        const dist = resolve(packageDir, "dist");
        const binary = resolve(dist, readFileSync(join(packageDir, "path.txt"), "utf8").trim());
        return binary.startsWith(dist + sep) && existsSync(binary) ? binary : undefined;
      } catch { return undefined; }
    });
  }

  status(): LoginStatus { return { ...this.current, available: Boolean(this.executable()) }; }
  restored(): void { this.current = { phase: "ready", message: "已恢复本机保存的登录态，无需重复扫码；平台有效性待连接验证。" }; }

  start(automatic = false): { login: LoginStatus; created: boolean } {
    if (active.has(this.current.phase)) {
      this.send(this.child, { type: "focus" });
      return { login: this.status(), created: false };
    }
    // Multiple admin tabs / refreshes must not repeatedly reopen a cancelled window.
    if (automatic && this.current.phase !== "idle") return { login: this.status(), created: false };
    const binary = this.executable();
    if (!binary) {
      this.current = { phase: "error", message: "本机登录组件未安装，请在项目目录运行 npm run setup:douyin-login 后重试。" };
      return { login: this.status(), created: false };
    }
    const attemptId = randomUUID();
    const startedAt = Date.now();
    const timeout = this.options.timeoutMs ?? 300_000;
    this.current = { phase: "opening", attemptId, startedAt, expiresAt: startedAt + timeout, message: "正在打开独立的抖音官方登录窗口……" };
    try {
      const helper = join(this.options.projectRoot, "tools", "douyin-login", "main.cjs");
      const child = this.options.launch ? this.options.launch(binary, helper) : spawn(binary, [helper], {
        // This is the user-requested interactive login window, not a hidden
        // worker. Electron is a GUI executable and does not need a console.
        stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: false,
        env: loginEnvironment(),
      });
      this.child = child;
      const isCurrent = () => this.child === child && this.current.attemptId === attemptId && active.has(this.current.phase);
      child.on("message", (input: unknown) => {
        if (!isCurrent() || !input || typeof input !== "object") return;
        const message = input as Record<string, unknown>;
        if (message.type === "boot") { this.send(child, { type: "init", attemptId }); return; }
        if (message.attemptId !== attemptId) return;
        if (message.type === "waiting") {
          this.current = { ...this.current, phase: "waiting-user", message: "请在抖音官方窗口点击登录，扫码并确认；验证码需由你本人完成。" };
        } else if (message.type === "credentials") {
          if (this.current.phase === "syncing") return;
          try {
            this.current = { ...this.current, phase: "syncing", message: "正在把登录态安全同步到本机服务……" };
            const cookie = message.cookie;
            const validation = new DouyinCookieJar();
            validation.setUserCookie(cookie as string);
            if (!validation.status().hasLoginSession) throw new Error("missing login");
            validation.clear();
            const expiresAt = typeof message.expiresAt === "number" && Number.isFinite(message.expiresAt) ? message.expiresAt : undefined;
            const accepted = this.options.acceptCookie(cookie as string, expiresAt);
            const complete = () => { if (isCurrent()) this.finish("ready", "登录态已获取；缓存保存结果见账号状态，平台有效性仍需实际连接验证。", child); };
            const failed = () => { if (isCurrent()) this.finish("error", "登录态同步失败，请重新打开登录窗口。", child); };
            if (accepted) void accepted.then(complete, failed);
            else complete();
          } catch { this.finish("error", "登录态同步失败，请重新打开登录窗口。", child); }
        } else if (message.type === "cancelled") {
          this.finish("cancelled", "已取消登录；需要时可再次点击登录按钮。", child);
        } else if (message.type === "error") {
          // Never reflect browser exceptions, URLs or credential-bearing content.
          this.finish("error", "抖音登录页未能正常加载，请检查网络后重试。", child);
        }
      });
      child.once("error", () => { if (isCurrent()) this.finish("error", "登录窗口启动失败，请检查本机登录组件。", child); });
      child.once("exit", () => {
        if (isCurrent()) this.finish("cancelled", "登录窗口已关闭，尚未获取登录态。", child);
        if (this.child === child) this.child = undefined;
      });
      this.timer = setTimeout(() => {
        if (isCurrent()) this.finish("expired", "扫码等待已超时，请点击登录按钮重新打开。", child);
      }, timeout);
      this.timer.unref();
    } catch { this.finish("error", "登录窗口启动失败，请检查本机登录组件。"); }
    return { login: this.status(), created: true };
  }

  cancel(): LoginStatus {
    // Cancelling a pending login is not logging out of an acquired account.
    if (!active.has(this.current.phase)) return this.status();
    this.finish("cancelled", "已取消自动登录，不会继续同步登录态。", this.child);
    return this.status();
  }

  cleared(): void {
    this.cancel();
    this.current = { phase:"cancelled", message:"已退出本机账号并清除登录态，需要时可重新扫码。" };
  }

  close(): void { this.cancel(); }

  private finish(phase: LoginPhase, message: string, child?: ChildProcess): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.current = { ...this.current, phase, message };
    if (child) {
      this.send(child, { type: phase === "ready" ? "accepted" : "cancel" });
      // Permit cookie/cache cleanup before force-closing a stuck helper.
      const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 4000);
      killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
    }
  }

  private send(child: ChildProcess | undefined, message: object): void {
    if (child?.connected) { try { child.send(message, () => undefined); } catch { /* exiting */ } }
  }
}

function loginEnvironment(): NodeJS.ProcessEnv {
  // Do not inherit API keys, application credentials, Node preloads or debugging
  // switches into the browser helper. Keep only OS and networking necessities.
  const keep = /^(SystemRoot|WINDIR|SystemDrive|PATH|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles(?:\(x86\))?|COMSPEC|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|HOME|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
}
