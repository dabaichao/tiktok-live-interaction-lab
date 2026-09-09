import type { LiveEventSource, SourceConfig, SourceEvent, SourceStatus } from "./LiveEventSource.js";

export interface SimulatorMessage {
  type: "chat" | "like" | "gift" | "join" | "follow" | "share";
  user?: Record<string, unknown>;
  [key: string]: unknown;
}

export class SimulatorSource implements LiveEventSource {
  private connected = false;
  private readonly eventListeners: Array<(event: SourceEvent) => void> = [];
  private readonly statusListeners: Array<(status: SourceStatus) => void> = [];

  async connect(_config: SourceConfig = {}): Promise<void> {
    this.connected = true;
    this.emitStatus({ source: "simulator", status: "connected", username: "Simulator", connectedAt: Date.now() });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emitStatus({ source: "simulator", status: "disconnected", username: "Simulator" });
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

  send(message: SimulatorMessage): void {
    if (!this.connected) return;
    this.eventListeners.forEach((listener) => listener({ type: message.type, data: message }));
  }

  private emitStatus(status: SourceStatus): void {
    this.statusListeners.forEach((listener) => listener(status));
  }
}
