import type { LiveEventSource, SourceConfig, SourceEvent, SourceStatus } from "./LiveEventSource.js";

/** Deterministic source used by CI tests; it never contacts TikTok. */
export class FakeLiveEventSource implements LiveEventSource {
  private connected = false;
  private readonly eventListeners: Array<(event: SourceEvent) => void> = [];
  private readonly statusListeners: Array<(status: SourceStatus) => void> = [];

  async connect(_config: SourceConfig = {}): Promise<void> {
    this.connected = true;
    this.statusListeners.forEach((listener) => listener({ source: "simulator", status: "connected" }));
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.statusListeners.forEach((listener) => listener({ source: "simulator", status: "disconnected" }));
  }

  isConnected(): boolean { return this.connected; }
  onEvent(callback: (event: SourceEvent) => void): void { this.eventListeners.push(callback); }
  onStatus(callback: (status: SourceStatus) => void): void { this.statusListeners.push(callback); }
  emit(event: SourceEvent): void { this.eventListeners.forEach((listener) => listener(event)); }
}
