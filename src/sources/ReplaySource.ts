import type { NormalizedLiveEvent } from "../core/events.js";
import type { LiveEventSource, SourceConfig, SourceEvent, SourceStatus } from "./LiveEventSource.js";

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 5 | 10 | "MAX";

export type ReplayState = "idle" | "playing" | "paused" | "stopped" | "completed";

export class ReplaySource implements LiveEventSource {
  private events: NormalizedLiveEvent[] = [];
  private index = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private state: ReplayState = "idle";
  private speed: ReplaySpeed = 1;
  private eventListeners: Array<(event: SourceEvent) => void> = [];
  private statusListeners: Array<(status: SourceStatus) => void> = [];

  async connect(config: SourceConfig = {}): Promise<void> {
    this.speed = normalizeSpeed(config.speed);
    this.connected = true;
    this.state = "idle";
    this.emitStatus({ source: "replay", status: "connected", username: "Replay", connectedAt: Date.now() });
  }

  async disconnect(): Promise<void> {
    this.clearTimer();
    this.connected = false;
    this.state = "stopped";
    this.emitStatus({ source: "replay", status: "disconnected", username: "Replay" });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(callback: (event: SourceEvent) => void): void {
    this.eventListeners.push(callback);
  }

  onStatus(callback: (status: SourceStatus) => void): void {
    this.statusListeners.push(callback);
  }

  load(events: NormalizedLiveEvent[], speed: ReplaySpeed = 1): void {
    this.clearTimer();
    this.events = [...events].sort((a, b) => a.sequence - b.sequence);
    this.index = 0;
    this.speed = speed;
    this.state = "idle";
  }

  play(): void {
    if (!this.connected || this.events.length === 0) return;
    this.state = "playing";
    this.emitStatus({ source: "replay", status: "connected", username: "Replay", message: `Playing ${this.speed}x` });
    this.scheduleNext();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.clearTimer();
    this.state = "paused";
    this.emitStatus({ source: "replay", status: "connected", username: "Replay", message: "Paused" });
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "playing";
    this.scheduleNext();
  }

  stop(): void {
    this.clearTimer();
    this.index = 0;
    this.state = "stopped";
    this.emitStatus({ source: "replay", status: "connected", username: "Replay", message: "Stopped" });
  }

  restart(): void {
    this.stop();
    this.play();
  }

  getState(): { state: ReplayState; speed: ReplaySpeed; index: number; total: number } {
    return { state: this.state, speed: this.speed, index: this.index, total: this.events.length };
  }

  private scheduleNext(): void {
    if (this.state !== "playing" || this.index >= this.events.length) {
      if (this.index >= this.events.length && this.events.length > 0) {
        this.state = "completed";
        this.emitStatus({ source: "replay", status: "disconnected", username: "Replay", message: "Replay completed" });
      }
      return;
    }
    const current = this.events[this.index];
    const previous = this.index > 0 ? this.events[this.index - 1] : undefined;
    const delay = this.speed === "MAX" ? 0 : Math.max(0, Math.round(((current.receivedAt - (previous?.receivedAt ?? current.receivedAt)) / this.speed)));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.state !== "playing") return;
      this.eventListeners.forEach((listener) => listener({ type: current.type, data: current, originalEvent: current }));
      this.index += 1;
      this.scheduleNext();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emitStatus(status: SourceStatus): void {
    this.statusListeners.forEach((listener) => listener(status));
  }
}

function normalizeSpeed(value: unknown): ReplaySpeed {
  if (value === "MAX") return value;
  const parsed = Number(value);
  return [0.25, 0.5, 1, 2, 5, 10].includes(parsed) ? (parsed as ReplaySpeed) : 1;
}
