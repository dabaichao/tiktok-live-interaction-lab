import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedLiveEvent } from "../core/events.js";
import type { SessionMeta } from "../core/SessionManager.js";

export interface RecorderOptions {
  dataDir: string;
}

export class Recorder {
  private stream?: WriteStream;
  private activeSession?: SessionMeta;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: RecorderOptions) {}

  get isRecording(): boolean {
    return Boolean(this.stream && this.activeSession);
  }

  get session(): SessionMeta | undefined {
    return this.activeSession;
  }

  async start(meta: SessionMeta): Promise<void> {
    if (this.isRecording) throw new Error("A recording is already active");
    const sessionDir = this.sessionDir(meta.sessionId);
    await mkdir(sessionDir, { recursive: true });
    this.activeSession = { ...meta };
    await writeFile(join(sessionDir, "meta.json"), JSON.stringify(this.activeSession, null, 2), "utf8");
    this.stream = createWriteStream(join(sessionDir, "events.jsonl"), { flags: "a", encoding: "utf8" });
    this.writeChain = Promise.resolve();
  }

  append(event: NormalizedLiveEvent): Promise<void> {
    if (!this.stream || !this.activeSession) return Promise.resolve();
    const stream = this.stream;
    this.writeChain = this.writeChain.then(async () => {
      const line = `${JSON.stringify(event)}\n`;
      if (!stream.write(line)) await onceDrain(stream);
    });
    return this.writeChain;
  }

  async stop(): Promise<SessionMeta | undefined> {
    const stream = this.stream;
    const meta = this.activeSession;
    if (!stream || !meta) return undefined;
    await this.writeChain;
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(() => resolve());
    });
    this.stream = undefined;
    this.activeSession = undefined;
    const completedMeta = { ...meta, endedAt: Date.now() };
    await writeFile(join(this.sessionDir(meta.sessionId), "meta.json"), JSON.stringify(completedMeta, null, 2), "utf8");
    return completedMeta;
  }

  private sessionDir(sessionId: string): string {
    return join(this.options.dataDir, "sessions", sessionId);
  }

  static async readMeta(sessionDir: string): Promise<SessionMeta> {
    return JSON.parse(await readFile(join(sessionDir, "meta.json"), "utf8")) as SessionMeta;
  }
}

function onceDrain(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}
