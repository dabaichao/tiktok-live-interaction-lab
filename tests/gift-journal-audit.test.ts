import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GiftAudit, auditGiftJournals, journalOrder } from "../tools/audit-gift-executions.mjs";

const record = (id = "gift", patch = {}) => ({
  id, createdAt: 100, trigger: "gift", roomKey: "webcast:testroom", status: "completed",
  plan: { randomWords: 10 }, completedWords: 10, aiWords: 10, localWords: 0,
  actor: { nickname: "不输出的姓名" }, cookie: "private-cookie", apiKey: "private-key", ...patch,
});

it("orders archived journals before the current journal and ignores unrelated names", () => {
  expect(journalOrder(["executions.jsonl", "executions-200-abcd.jsonl", "notes.jsonl", "executions-100-abcd.jsonl", "../executions-1-abcd.jsonl"]))
    .toEqual(["executions-100-abcd.jsonl", "executions-200-abcd.jsonl", "executions.jsonl"]);
});

it("counts each execution's last state once without actor, key, event or room identifiers", () => {
  const audit = new GiftAudit({ since: 0, roomKey: "webcast:testroom" });
  audit.accept(JSON.stringify(record("one", { status: "queued", completedWords: 0, aiWords: 0 })));
  audit.accept(JSON.stringify(record("one")));
  audit.accept(JSON.stringify(record("two", { status: "cancelled", completedWords: 7, aiWords: 7 })));
  const report = audit.summary({ files: ["executions.jsonl"] });
  expect(report).toMatchObject({ executionCount: 2, expectedWords: 20, completedWords: 17, remainingWords: 3,
    statuses: { completed: 1, cancelled: 1 }, fullyCompletedExecutions: 1, incompleteExecutions: 1, coverageComplete: true, allSelectedExecutionsCompleted: false });
  for (const value of ["不输出的姓名", "private-cookie", "private-key", "testroom", '"one"', '"two"']) expect(JSON.stringify(report)).not.toContain(value);
});

it("does not include other rooms, times or likes in gift totals", () => {
  const audit = new GiftAudit({ since: 50, until: 150, roomKey: "webcast:testroom" });
  for (const value of [record(), record("other", { roomKey: "webcast:another" }), record("old", { createdAt: 10 }),
    record("future", { createdAt: 200 }), record("like", { trigger: "like" })]) audit.accept(JSON.stringify(value));
  expect(audit.summary({ files: ["executions.jsonl"] })).toMatchObject({ executionCount: 1, expectedWords: 10 });
});

it("does not silently treat damaged rows or missing files as full coverage", () => {
  const audit = new GiftAudit({ since: 0 });
  audit.accept("{unfinished"); audit.accept(JSON.stringify(record()));
  expect(audit.summary({ files: ["executions.jsonl"] })).toMatchObject({ coverageComplete: false, malformedRows: 1 });
  expect(new GiftAudit({ since: 0 }).summary()).toMatchObject({ coverageComplete: false, executionCount: 0 });
});

it("flags inconsistent completion counts and does not treat queued as a live job", () => {
  const audit = new GiftAudit({ since: 0 });
  audit.accept(JSON.stringify(record("false-success", { completedWords: 9, aiWords: 9 })));
  audit.accept(JSON.stringify(record("pending", { status: "running", completedWords: 0, aiWords: 0 })));
  expect(audit.summary({ files: ["executions.jsonl"] })).toMatchObject({ coverageComplete: false,
    inconsistentExecutions: 1, fullyCompletedExecutions: 0, awaitingTerminalState: 1, incompleteExecutions: 2 });
});

it("streams rotated files and uses the later terminal update without writing to the ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gift-journal-test-"));
  await writeFile(join(directory, "executions-100-abcd.jsonl"), JSON.stringify(record("one", { status: "running", completedWords: 3, aiWords: 3 })) + "\n");
  await writeFile(join(directory, "executions.jsonl"), JSON.stringify(record("one")) + "\n");
  expect(await auditGiftJournals(directory, { since: 0 })).toMatchObject({ coverageComplete: true,
    executionCount: 1, rows: 2, expectedWords: 10, completedWords: 10, allSelectedExecutionsCompleted: true });
});

it("rejects an invalid time or room filter before touching files", () => {
  for (const options of [{ since: NaN }, { since: 100, until: 50 }, { since: 0, roomKey: "private=token" }]) expect(() => new GiftAudit(options)).toThrow();
});
