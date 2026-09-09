import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Normalizer } from "../src/core/Normalizer.js";
import { Recorder } from "../src/recording/Recorder.js";

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Recorder", () => {
  it("streams 100 events as 100 ordered JSONL lines", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "tiktok-lab-recorder-"));
    temporaryPaths.push(dataDir);
    const recorder = new Recorder({ dataDir });
    const meta = { sessionId: "session-test", source: "simulator" as const, username: "test", startedAt: Date.now(), schemaVersion: 1 as const };
    const normalizer = new Normalizer();
    await recorder.start(meta);
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      await recorder.append(normalizer.normalize({ type: "chat", data: { text: `event-${sequence}` } }, "simulator", meta.sessionId, sequence));
    }
    await recorder.stop();
    const content = await readFile(join(dataDir, "sessions", meta.sessionId, "events.jsonl"), "utf8");
    const lines = content.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(lines).toHaveLength(100);
    expect(lines.map((line) => line.sequence)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });
});
