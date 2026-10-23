import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DouyinWebcastSource } from "../src/sources/DouyinWebcastSource.js";
import type { SourceStatus } from "../src/sources/LiveEventSource.js";

describe("browser bridge lease lifecycle", () => {
  let source: DouyinWebcastSource;
  let token: string;
  let statuses: SourceStatus[];
  let expired: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    source = new DouyinWebcastSource(); statuses = []; expired = vi.fn();
    source.onStatus(status => statuses.push(status)); source.onBridgeExpired(expired);
    await source.connect({ webRid: "isolatedLease" });
    token = source.connectionInstructions().sessionToken;
    source.updateState(token, { status: "connected" });
  });
  afterEach(() => { source.close(); vi.useRealTimers(); });

  it("expires autonomously at the deadline without a status read or browser close request", async () => {
    await vi.advanceTimersByTimeAsync(59_999);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.at(-1)).toMatchObject({ status: "disconnected" });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(source.diagnostics()).toMatchObject({ bridgeExpired: true, ended: false, acceptedMessages: 0 });
    expect(() => source.connectionInstructions()).toThrow("尚未初始化");
    expect(source.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a quiet room alive on valid browser diagnostics without requiring platform messages", async () => {
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      source.updateDiagnostics(token, { frames: 0 });
      expect(source.isConnected()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(expired).not.toHaveBeenCalled();
    expect(source.diagnostics().acceptedMessages).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each(["state", "events", "diagnostics"] as const)("rejects a delayed %s request after event-loop suspension without renewing the lease", kind => {
    // Move wall time without running timers: imitates renderer/server suspension.
    vi.setSystemTime(160_001);
    const request = () => kind === "state" ? source.updateState(token, { status: "connected" })
      : kind === "events" ? source.acceptMessages(token, [{ method: "WebcastLikeMessage", count: 1 }])
      : source.updateDiagnostics(token, { frames: 10 });
    expect(request).toThrow("会话已失效");
    expect(expired).toHaveBeenCalledTimes(1);
    expect(source.diagnostics().acceptedMessages).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connecting", "disconnected", "error"] as const)("still expires an abandoned bridge whose last browser state was %s", async status => {
    source.updateState(token, { status });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.status).toBe("disconnected");
  });

  it("does not renew browser liveness from a server-side transport callback", async () => {
    await vi.advanceTimersByTimeAsync(55_000);
    source.transportState("error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("does not renew the current session from a wrong token", async () => {
    await vi.advanceTimersByTimeAsync(40_000);
    expect(() => source.updateDiagnostics("wrong-session", {})).toThrow("会话已失效");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("isolates an explicitly restarted session from the old deadline and delayed requests", async () => {
    await vi.advanceTimersByTimeAsync(40_000);
    await source.connect({ webRid: "newIsolatedLease" });
    const nextToken = source.connectionInstructions().sessionToken;
    expect(nextToken).not.toBe(token);
    source.updateState(nextToken, { status: "connected" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(() => source.updateState(token, { status: "connected" })).toThrow("会话已失效");
    expect(source.isConnected()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
    expect(source.diagnostics().bridgeExpired).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each(["disconnect", "close"] as const)("clears the timer on %s without reporting a false expiry", async action => {
    await source[action]();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(expired).not.toHaveBeenCalled();
    expect(source.isConnected()).toBe(false);
  });

  it("clears the timer on actual stream end and preserves terminal acknowledgement behavior", async () => {
    expect(source.acceptMessages(token, [{ id: "ended", method: "WebcastControlMessage", room: { status: 3 } }])).toMatchObject({ accepted: 1, ended: true });
    source.updateState(token, { status: "connected" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(source.isConnected()).toBe(false);
    expect(source.diagnostics()).toMatchObject({ ended: true, bridgeExpired: false });
    expect(expired).not.toHaveBeenCalled();
  });

  it("allows normal socket reconnection while the valid browser heartbeat continues", async () => {
    await vi.advanceTimersByTimeAsync(40_000);
    source.transportState("disconnected");
    source.updateDiagnostics(token, {});
    await vi.advanceTimersByTimeAsync(40_000);
    source.updateState(token, { status: "connected", reconnectCount: 1 });
    expect(source.isConnected()).toBe(true);
    expect(source.diagnostics()).toMatchObject({ bridgeExpired: false, reconnectCount: 1 });
    expect(expired).not.toHaveBeenCalled();
  });
});
