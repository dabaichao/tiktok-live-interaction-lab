export type SourceKind = "tiktok" | "douyin" | "replay" | "simulator";

export type SourceStatusName =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "offline"
  | "error";

export interface SourceConfig {
  username?: string;
  roomId?: string;
  speed?: number | "MAX";
  [key: string]: unknown;
}

export interface SourceStatus {
  source: SourceKind;
  status: SourceStatusName;
  message?: string;
  roomId?: string;
  username?: string;
  connectedAt?: number;
  error?: string;
}

export interface SourceEvent {
  type: string;
  data?: unknown;
  platformTimestamp?: number;
  raw?: unknown;
  decoded?: unknown;
  debug?: boolean;
  originalEvent?: unknown;
}

export interface LiveEventSource {
  connect(config: SourceConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  onEvent(callback: (event: SourceEvent) => void): void;
  onStatus(callback: (status: SourceStatus) => void): void;
}
