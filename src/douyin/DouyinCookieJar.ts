/** Credentials are deliberately process-local and never exposed by status(). */
export class DouyinCookieJar {
  private readonly values = new Map<string, string>();
  private supplied = false;

  setUserCookie(input: string): void {
    if (typeof input !== "string" || input.length > 16384 || /[\r\n\x00-\x1f\x7f]/.test(input)) {
      throw new Error("Cookie 格式不正确：请仅粘贴请求标头中 Cookie 的单行值。");
    }
    const normalized = input.trim().replace(/^cookie\s*:\s*/i, "");
    const parsed = new Map<string, string>();
    for (const part of normalized.split(";")) {
      if (!part.trim()) continue;
      const match = /^\s*([\w-]+)=([^;\s]*)\s*$/.exec(part);
      if (!match || !/^[\x21-\x7e]*$/.test(match[2])) throw new Error("Cookie 格式不正确：需要 name=value; name=value 格式，不要粘贴整段请求或响应标头。");
      parsed.set(match[1], match[2]);
    }
    if (!parsed.size) throw new Error("Cookie 不能为空。");
    this.values.clear();
    for (const [name, value] of parsed) this.values.set(name, value);
    this.supplied = true;
  }

  acceptUpstreamCookies(cookies: string[]): void {
    for (const cookie of cookies) {
      const first = cookie.split(";", 1)[0];
      const match = /^([\w-]+)=([^;\s]*)$/.exec(first);
      if (!match || !/^[\x21-\x7e]*$/.test(match[2])) continue;
      const maxAge = /;\s*max-age=(-?\d+)(?:;|$)/i.exec(cookie);
      const expires = /;\s*expires=([^;]+)/i.exec(cookie);
      if ((maxAge && Number(maxAge[1]) <= 0) || (!maxAge && expires && Date.parse(expires[1]) <= Date.now())) this.values.delete(match[1]);
      else if (this.values.has(match[1]) || this.values.size < 100) this.values.set(match[1], match[2]);
    }
  }

  header(): string { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }

  status(): { configured: boolean; hasLoginSession: boolean; validation: "unverified"; storage: "memory" } {
    return { configured: this.supplied, hasLoginSession: ["sessionid", "sessionid_ss", "sid_tt"].some(key => Boolean(this.values.get(key))), validation: "unverified", storage: "memory" };
  }

  clear(): void { this.values.clear(); this.supplied = false; }
}
