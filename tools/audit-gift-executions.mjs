// Read-only, streaming journal audit. No HTTP, model calls, credentials or writes.
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const states = new Set(["queued", "running", "completed", "partial", "cancelled", "failed", "display-only"]);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const journalName = /^executions-(\d+)-[a-f0-9-]+\.jsonl$/;

export function journalOrder(names) {
  return names.filter(name => journalName.test(name)).sort((a, b) =>
    Number(journalName.exec(a)[1]) - Number(journalName.exec(b)[1]) || a.localeCompare(b))
    .concat(names.includes("executions.jsonl") ? ["executions.jsonl"] : []);
}

export class GiftAudit {
  latest = new Map();
  rows = 0;
  malformedRows = 0;
  constructor({ since, until = Infinity, roomKey } = {}) {
    if (!Number.isFinite(since) || since < 0 || !(until >= since) ||
        (roomKey !== undefined && !/^(webcast|official):[A-Za-z0-9_-]{1,80}$/.test(roomKey))) {
      throw new Error("必须提供有效的开始时间；结束时间和房间筛选需符合格式。");
    }
    Object.assign(this, { since, until, roomKey });
  }
  accept(line) {
    if (!line.trim()) return;
    this.rows++;
    let record;
    try { record = JSON.parse(line); } catch { this.malformedRows++; return; }
    if (!record || typeof record !== "object" || Array.isArray(record)) { this.malformedRows++; return; }
    if (record.trigger !== "gift") return;
    if (!Number.isFinite(record.createdAt)) { this.malformedRows++; return; }
    if (record.createdAt < this.since || record.createdAt > this.until || (this.roomKey && record.roomKey !== this.roomKey)) return;
    if (typeof record.id !== "string" || !record.id || record.id.length > 200 || !states.has(record.status) ||
        !natural(record.plan?.randomWords) || !natural(record.completedWords) || !natural(record.aiWords) || !natural(record.localWords)) {
      this.malformedRows++; return;
    }
    // Keep only count fields; no actor, event payload, answer, prompt or key.
    this.latest.set(record.id, { status: record.status, expected: record.plan.randomWords,
      completed: record.completedWords, ai: record.aiWords, local: record.localWords });
  }
  summary({ files = [], readErrors = 0 } = {}) {
    const statuses = {}, totals = { expectedWords: 0, completedWords: 0, aiWords: 0, localWords: 0 };
    let inconsistentExecutions = 0, incompleteExecutions = 0, fullyCompletedExecutions = 0;
    for (const record of this.latest.values()) {
      statuses[record.status] = (statuses[record.status] || 0) + 1;
      totals.expectedWords += record.expected; totals.completedWords += record.completed;
      totals.aiWords += record.ai; totals.localWords += record.local;
      const consistent = record.completed <= record.expected && record.ai + record.local === record.completed &&
        (record.status !== "completed" || record.completed === record.expected);
      if (!consistent) inconsistentExecutions++;
      if (record.completed < record.expected) incompleteExecutions++;
      if (consistent && record.status === "completed") fullyCompletedExecutions++;
    }
    const coverageComplete = files.length > 0 && readErrors === 0 && this.malformedRows === 0 &&
      inconsistentExecutions === 0 && Object.values(totals).every(natural);
    return { readOnly: true, files, rows: this.rows, malformedRows: this.malformedRows, readErrors,
      coverageComplete, executionCount: this.latest.size, statuses, ...totals,
      remainingWords: totals.expectedWords - totals.completedWords,
      fullyCompletedExecutions, incompleteExecutions, inconsistentExecutions,
      allSelectedExecutionsCompleted: coverageComplete && this.latest.size > 0 &&
        fullyCompletedExecutions + (statuses["display-only"] || 0) === this.latest.size,
      awaitingTerminalState: (statuses.queued || 0) + (statuses.running || 0),
      limits: "仅核查所选时间/房间内已入账的礼物；不证明平台送礼全部到达，不证明 queued/running 任务当前存活，不修改任何状态。" };
  }
}

export async function auditGiftJournals(directory, options) {
  const audit = new GiftAudit(options);
  const files = journalOrder(await readdir(directory));
  let readErrors = 0;
  for (const name of files) {
    const input = createReadStream(join(directory, name), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) audit.accept(line); }
    catch { readErrors++; }
    finally { lines.close(); input.destroy(); }
  }
  return audit.summary({ files, readErrors });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, allowed = new Set(["--since", "--until", "--room", "--directory"]);
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (!allowed.has(key) || !value || value.startsWith("--") || Object.hasOwn(options, key)) throw new Error("参数无效");
      options[key] = value;
    }
    const report = await auditGiftJournals(options["--directory"] || resolve(import.meta.dirname, "../data/douyin"), {
      since: Date.parse(options["--since"]),
      ...(options["--until"] ? { until: Date.parse(options["--until"]) } : {}), roomKey: options["--room"],
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.coverageComplete) process.exitCode = 2;
  } catch { console.error("核查未完成：请检查日志目录，提供 --since ISO时间，可选 --until、--room webcast:房间号；未改动游戏或日志。"); process.exitCode = 1; }
}
