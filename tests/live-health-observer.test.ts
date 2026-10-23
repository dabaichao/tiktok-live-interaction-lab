import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBase, safeSample, summaryOf, observe } from "../tools/observe-live-health.mjs";

const fixture = (uptimeSeconds = 10) => ({
  runtime: { uptimeSeconds, memory: { rss: 100, heapUsed: 50 }, gameDelivery: { pendingFrames: 0, slowClientsDisconnected: 0 }, recentEventCount: 200 },
  sources: { douyin: { status: "connected", connectedAt: 90000 } },
  douyin: { cookie: "secret-cookie", webcast: { acceptedMessages: 50, reconnectCount: 0, decoder: { frames: 10, frameErrors: 0, lastFrameAt: 100000, decodeErrors: {} }, lastMessageAt: 100000 }, webcastConnection: { transport: { state: "connected" } } },
  game: { round: { roundNo: 2, answer: "秘密答案" }, metrics: { validGuesses: 10 }, embedding: { mode: "embedding", dimensions: 1024, cacheEntries: 30, answerContextMode: "reviewed-when-specific" },
    hintModel: { configured: true, apiKey: "secret-key", baseUrl: "https://secret-endpoint", lastModelUsed: "hy3", lastRequest: { model: "hy3", httpStatus: 200, finishReason: "stop", acceptedWords: 20 } },
    topGuesses: [{ nickname: "个人姓名" }] },
});

it("restricts observation to the literal loopback origin without credentials or redirects", () => {
  expect(localBase("http://127.0.0.1:3002")).toBe("http://127.0.0.1:3002");
  for (const value of ["https://external.test", "http://localhost:3002", "http://key@127.0.0.1:3002", "http://127.0.0.1:3002/other", "http://127.0.0.1:3002?secret=key"]) {
    expect(() => localBase(value)).toThrow();
  }
});

it("logs only allowlisted numeric health fields, never credentials or player/answer data", () => {
  const sample = safeSample(fixture(), 12, 100000);
  expect(sample.embedding.dimensions).toBe(1024);
  expect(sample.connectionStartedAt).toBe(90000);
  expect(sample.embedding.answerContextMode).toBe("reviewed-when-specific");
  const unexpected=fixture();unexpected.game.embedding.answerContextMode="secret-key";
  expect(safeSample(unexpected,12,100000).embedding.answerContextMode).toBeNull();
  expect(sample.model.lastRequest.acceptedWords).toBe(20);
  for (const secret of ["secret-cookie", "secret-key", "secret-endpoint", "秘密答案", "个人姓名"]) expect(JSON.stringify(sample)).not.toContain(secret);
});

it("does not count ended-room, restart, timeout, or suspended gaps as continuous live time", () => {
  const sample = (time: number, uptime: number) => safeSample(fixture(uptime), 1, time);
  const a = sample(100000, 10), b = sample(130000, 40), c = { ...sample(160000, 70), source: "disconnected" };
  const d = sample(190000, 1), e = sample(600000, 411), failed = { at: new Date(630000).toISOString(), ok: false };
  const report = summaryOf([a, b, c, d, e, failed], 530, 30);
  expect(report.connectedObservedSeconds).toBe(30);
  expect(report.longestConnectedObservedSeconds).toBe(30);
  expect(report.longestVerifiedConnectionSeconds).toBe(30);
  expect(report.serviceRestarts).toBe(1);
  expect(report.failed).toBe(1);
  expect(report.mismatchedTransportSamples).toBe(1);
});

it("keeps separate live periods separate instead of calling their sum continuous", () => {
  const sample = (time: number) => {
    const data = fixture(time / 1000);
    data.douyin.webcast.decoder.lastFrameAt = time;
    data.douyin.webcast.lastMessageAt = time;
    return safeSample(data, 1, time);
  };
  const samples = [sample(100000), sample(130000), sample(160000),
    { ...sample(190000), source: "disconnected", transport: "disconnected" },
    sample(220000), sample(250000), sample(280000)];
  const report = summaryOf(samples, 180, 30);
  expect(report.connectedObservedSeconds).toBe(120);
  expect(report.longestConnectedObservedSeconds).toBe(60);
  expect(report.longestVerifiedConnectionSeconds).toBe(60);
});

it("breaks continuous observation for reconnects hidden between two connected samples", () => {
  const a = safeSample(fixture(10), 1, 100000);
  const b = safeSample(fixture(40), 1, 130000);
  for (const changed of [{ ...b, reconnectCount: 1 }, { ...b, frames: 1 }, { ...b, connectionStartedAt: 115000 }]) {
    const report = summaryOf([a, changed], 30, 30);
    expect(report.longestConnectedObservedSeconds).toBe(0);
    expect(report.longestVerifiedConnectionSeconds).toBe(0);
    expect(report.connectionBreaks).toBe(1);
  }
});

it("does not treat legacy samples without connection identity as same-connection acceptance", () => {
  const a = { ...safeSample(fixture(10), 1, 100000), connectionStartedAt: null };
  const b = { ...safeSample(fixture(40), 1, 130000), connectionStartedAt: null };
  const report = summaryOf([a, b], 30, 30);
  expect(report.longestConnectedObservedSeconds).toBe(30);
  expect(report.longestVerifiedConnectionSeconds).toBe(0);
  expect(report.connectionIdentitySamples).toBe(0);
  const identified = { ...b, connectionStartedAt: 90000 };
  expect(summaryOf([a, identified], 30, 30).longestConnectedObservedSeconds).toBe(0);
});

it("rejects missing or invalid continuity counters and never logs nonnumeric connection identity", () => {
  const a = safeSample(fixture(10), 1, 100000);
  const b = safeSample(fixture(40), 1, 130000);
  for (const changed of [{ ...b, reconnectCount: null }, { ...b, frames: NaN }, { ...b, uptimeSeconds: undefined }]) {
    const report = summaryOf([a, changed], 30, 30);
    expect(report.longestVerifiedConnectionSeconds).toBe(0);
  }
  const malformed = fixture();
  malformed.sources.douyin.connectedAt = "secret-session-token" as unknown as number;
  const sample = safeSample(malformed, 1, 100000);
  expect(sample.connectionStartedAt).toBeNull();
  expect(JSON.stringify(sample)).not.toContain("secret-session-token");
});

it("excludes a business/transport mismatch and nonpositive sample gaps", () => {
  const data = fixture();
  const a = safeSample(data, 1, 100000);
  const b = { ...safeSample(fixture(40), 1, 130000), transport: "disconnected" };
  const report = summaryOf([a, a, b], 30, 30);
  expect(report.connectedObservedSeconds).toBe(0);
  expect(report.longestConnectedObservedSeconds).toBe(0);
});

it("persists a complete bounded observation without mutating a server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-health-test-"));
  const requests: string[] = [];
  const result = await observe({ base: "http://127.0.0.1:3002", durationSeconds: 1, intervalSeconds: 1, outputRoot: directory,
    fetchStatus: async (url: string) => { requests.push(url); return fixture(); } });
  expect(result.running).toBe(false);
  expect(result.successful).toBeGreaterThanOrEqual(2);
  expect(requests.every(url => url === "http://127.0.0.1:3002/api/status")).toBe(true);
  // Bad configuration is rejected before a network request.
  await expect(observe({ base: "http://external.test", outputRoot: directory })).rejects.toThrow();
  const runs = await readdir(directory);
  expect(runs).toHaveLength(1);
  const saved = JSON.parse(await readFile(join(directory, runs[0], "summary.json"), "utf8"));
  expect(saved.running).toBe(false);
  const journal = await readFile(join(directory, runs[0], "samples.jsonl"), "utf8");
  expect(journal.trim().split("\n")).toHaveLength(result.samples);
  expect(journal).not.toContain("secret-key");
});
