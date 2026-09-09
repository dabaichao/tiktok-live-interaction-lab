import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizedLiveEventSchema, type NormalizedLiveEvent } from "../core/events.js";
import type { SessionMeta } from "../core/SessionManager.js";
import { Recorder } from "./Recorder.js";

export interface SessionSummary extends SessionMeta {
  eventCount: number;
}

export class SessionReader {
  constructor(private readonly dataDir: string) {}

  async list(): Promise<SessionSummary[]> {
    const root = join(this.dataDir, "sessions");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const sessions: SessionSummary[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const dir = join(root, entry.name);
          const meta = await Recorder.readMeta(dir);
          const events = await this.read(meta.sessionId);
          sessions.push({ ...meta, eventCount: events.length });
        } catch {
          // Ignore incomplete or manually removed session folders.
        }
      }
      return sessions.sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return [];
    }
  }

  async read(sessionId: string): Promise<NormalizedLiveEvent[]> {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (safeSessionId !== sessionId || !safeSessionId) throw new Error("Invalid sessionId");
    const path = join(this.dataDir, "sessions", safeSessionId, "events.jsonl");
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return [];
    }
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => normalizedLiveEventSchema.parse(JSON.parse(line)));
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      const path = join(this.dataDir, "sessions", sessionId, "events.jsonl");
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}
