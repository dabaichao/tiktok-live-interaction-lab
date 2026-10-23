// Read-only soak observation. Never connects rooms, controls games, or calls models.
import { mkdir, appendFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const states = new Set(["idle", "connecting", "connected", "disconnected", "error"]);
const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const safeLabel = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
const sum = value => value && typeof value === "object" ? Object.values(value).reduce((total, n) => total + (count(n) || 0), 0) : 0;

export function localBase(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("只允许无凭据、无查询参数的本机 http://127.0.0.1:端口 地址。");
  }
  return url.origin;
}

// Explicit allowlist: no names, account IDs, answers, prompts, Cookie, or keys.
export function safeSample(status, latencyMs, now = Date.now()) {
  if (!status?.runtime?.memory || !status?.game || !status?.douyin?.webcast) throw new Error("状态接口结构不符合预期。");
  const source = status.sources?.douyin;
  const live = status.douyin.webcast;
  const transport = status.douyin.webcastConnection?.transport;
  const request = status.game.hintModel?.lastRequest;
  return {
    at: new Date(now).toISOString(), ok: true, latencyMs: Math.round(latencyMs),
    uptimeSeconds: count(status.runtime.uptimeSeconds),
    source: states.has(source?.status) ? source.status : "unknown",
    transport: states.has(transport?.state) ? transport.state : "unknown",
    // A server-generated timestamp is sufficient to distinguish connection
    // epochs without persisting room IDs, session tokens, or account identity.
    connectionStartedAt: count(source?.connectedAt),
    lastMessageAgeSeconds: typeof live.lastMessageAt === "number" ? Math.max(0, Math.round((now - live.lastMessageAt) / 1000)) : null,
    lastFrameAgeSeconds: typeof live.decoder?.lastFrameAt === "number" && live.decoder.lastFrameAt > 0 ? Math.max(0, Math.round((now - live.decoder.lastFrameAt) / 1000)) : null,
    frames: count(live.decoder?.frames), frameErrors: count(live.decoder?.frameErrors), decodeErrors: sum(live.decoder?.decodeErrors),
    acceptedMessages: count(live.acceptedMessages), reconnectCount: count(live.reconnectCount),
    maskedNicknameMessages: count(live.maskedNicknameMessages),
    heapUsed: count(status.runtime.memory.heapUsed), rss: count(status.runtime.memory.rss),
    recentEvents: count(status.runtime.recentEventCount),
    pendingFrames: count(status.runtime.gameDelivery?.pendingFrames), slowClientsDisconnected: count(status.runtime.gameDelivery?.slowClientsDisconnected),
    interactions: Object.fromEntries(["pendingJobs","queuedJobs","runningJobs","waitingForRound","modelJobs","remainingWords","oldestPendingMs","oldestQueuedMs"].map(key=>[key,count(status.runtime.interactions?.[key])])),
    bridgeDelivery: Object.fromEntries(["pendingMessages","pendingBytes","retryCount","oldestPendingMs","overflowMessages"].map(key=>[key,count(live.decoder?.delivery?.[key])])),
    roundNo: count(status.game.round?.roundNo), validGuesses: count(status.game.metrics?.validGuesses),
    embedding: { mode: safeLabel(status.game.embedding?.mode), dimensions: count(status.game.embedding?.dimensions), cacheEntries: count(status.game.embedding?.cacheEntries),
      answerContextMode: ["surface","reviewed-when-specific"].includes(status.game.embedding?.answerContextMode) ? status.game.embedding.answerContextMode : null },
    model: {
      configured: status.game.hintModel?.configured === true, lastModelUsed: safeLabel(status.game.hintModel?.lastModelUsed),
      ...(request ? { lastRequest: {
        model: safeLabel(request.model), httpStatus: count(request.httpStatus), durationMs: count(request.durationMs),
        finishReason: ["stop", "length", "content_filter", "tool_calls", "other"].includes(request.finishReason) ? request.finishReason : "other",
        contentChars: count(request.contentChars), acceptedWords: count(request.acceptedWords),
        completionTokens: count(request.completionTokens), reasoningTokens: count(request.reasoningTokens),
      } } : {}),
    },
  };
}

export function summaryOf(samples, elapsedSeconds, intervalSeconds) {
  const successful = samples.filter(sample => sample.ok);
  const max = field => Math.max(0, ...successful.map(sample => sample[field] || 0));
  let connectedObservedSeconds = 0, serviceRestarts = 0;
  let currentConnectedSeconds = 0, longestConnectedSeconds = 0;
  let verifiedConnectionSeconds = 0, currentVerifiedSeconds = 0, longestVerifiedSeconds = 0;
  let connectionBreaks = 0;
  const hasStart = sample => Number.isSafeInteger(sample.connectionStartedAt) && sample.connectionStartedAt > 0;
  const validCounter = value => Number.isSafeInteger(value) && value >= 0;
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1], after = samples[i];
    const gap = (Date.parse(after.at) - Date.parse(before.at)) / 1000;
    const knownRun = validCounter(before.uptimeSeconds) && validCounter(after.uptimeSeconds);
    const sameRun = knownRun && after.uptimeSeconds >= before.uptimeSeconds;
    if (before.ok && after.ok && knownRun && !sameRun) serviceRestarts++;
    const sameCounters = validCounter(before.reconnectCount) && validCounter(after.reconnectCount) &&
      before.reconnectCount === after.reconnectCount && validCounter(before.frames) && validCounter(after.frames) && after.frames >= before.frames;
    const identified = hasStart(before) && hasStart(after);
    const sameStart = identified ? before.connectionStartedAt === after.connectionStartedAt : !hasStart(before) && !hasStart(after);
    if (before.ok && after.ok && sameRun && before.source === "connected" && after.source === "connected" && (!sameCounters || !sameStart)) connectionBreaks++;
    if (before.ok && after.ok && sameRun && sameCounters && sameStart && before.source === "connected" && after.source === "connected" &&
      before.transport === "connected" && after.transport === "connected" &&
      before.lastFrameAgeSeconds !== null && before.lastFrameAgeSeconds <= 120 &&
      after.lastFrameAgeSeconds !== null && after.lastFrameAgeSeconds <= 120 && gap > 0 && gap <= intervalSeconds * 2.5) {
      connectedObservedSeconds += gap;
      currentConnectedSeconds += gap;
      longestConnectedSeconds = Math.max(longestConnectedSeconds, currentConnectedSeconds);
      if (identified) {
        verifiedConnectionSeconds += gap;
        currentVerifiedSeconds += gap;
        longestVerifiedSeconds = Math.max(longestVerifiedSeconds, currentVerifiedSeconds);
      } else currentVerifiedSeconds = 0;
    } else { currentConnectedSeconds = 0; currentVerifiedSeconds = 0; }
  }
  return {
    samples: samples.length, successful: successful.length, failed: samples.length - successful.length,
    elapsedSeconds: Math.round(elapsedSeconds), connectedObservedSeconds: Math.round(connectedObservedSeconds),
    longestConnectedObservedSeconds: Math.round(longestConnectedSeconds), serviceRestarts,
    verifiedConnectionSeconds: Math.round(verifiedConnectionSeconds), longestVerifiedConnectionSeconds: Math.round(longestVerifiedSeconds),
    connectionIdentitySamples: successful.filter(hasStart).length, connectionBreaks,
    maxLatencyMs: max("latencyMs"), maxHeapUsed: max("heapUsed"), maxRss: max("rss"),
    maxPendingFrames: max("pendingFrames"), maxFrameErrors: max("frameErrors"), maxDecodeErrors: max("decodeErrors"),
    mismatchedTransportSamples: successful.filter(sample => sample.source === "disconnected" && sample.transport === "connected").length,
    staleConnectedSamples: successful.filter(sample => sample.source === "connected" && sample.lastFrameAgeSeconds > 120).length,
    latest: samples.at(-1),
    limits: "只读离散采样；旧样本缺连接起点时observed时长不能证明同一次连接。连续验收使用longestVerifiedConnectionSeconds，仍不证明真实礼物全部完成、无内存泄漏或手机验收。pendingFrames是发送缓存，不是模型任务队列深度。",
  };
}

export async function observe({ base, durationSeconds = 7200, intervalSeconds = 30, outputRoot, fetchStatus = async url => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("状态请求失败");
  return response.json();
} }) {
  base = localBase(base);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 14400 ||
      !Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 120) throw new Error("观测时长须为 1～14400 秒，间隔为 1～120 秒。");
  const directory = join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  const started = performance.now(), samples = [];
  let report;
  console.log(JSON.stringify({ observationStarted: true, readOnly: true, directory, durationSeconds, intervalSeconds }));
  do {
    const requestStarted = performance.now();
    let sample;
    try { sample = safeSample(await fetchStatus(`${base}/api/status`), performance.now() - requestStarted); }
    catch { sample = { at: new Date().toISOString(), ok: false, error: "本机状态接口失败、超时或格式不符合预期" }; }
    samples.push(sample);
    await appendFile(join(directory, "samples.jsonl"), JSON.stringify(sample) + "\n", "utf8");
    const elapsed = (performance.now() - started) / 1000;
    report = { running: elapsed < durationSeconds, startedAt: samples[0].at, ...summaryOf(samples, elapsed, intervalSeconds) };
    const reportPath = join(directory, "summary.json");
    await writeFile(reportPath + ".tmp", JSON.stringify(report, null, 2), "utf8");
    await rename(reportPath + ".tmp", reportPath);
    if (elapsed >= durationSeconds) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalSeconds, durationSeconds - elapsed) * 1000));
  } while (true);
  console.log(JSON.stringify({ observationFinished: true, directory, ...report }));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--base", "--duration-seconds", "--interval-seconds"]);
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || !args[i + 1] || allowed.has(args[i + 1])) throw new Error("参数不正确。");
      options[args[i]] = args[i + 1];
    }
    await observe({ base: options["--base"] || "http://127.0.0.1:3002", durationSeconds: Number(options["--duration-seconds"] || 7200),
      intervalSeconds: Number(options["--interval-seconds"] || 30), outputRoot: resolve(import.meta.dirname, "../.runtime/live-health") });
  } catch { console.error("观测未启动或未完整保存，请检查本机地址、参数和目录权限。"); process.exitCode = 1; }
}
