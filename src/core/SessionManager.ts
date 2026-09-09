import { randomUUID } from "node:crypto";
import type { SourceKind } from "../sources/LiveEventSource.js";

export interface SessionMeta {
  sessionId: string;
  source: SourceKind;
  username?: string;
  roomId?: string;
  startedAt: number;
  endedAt?: number;
  schemaVersion: 1;
}

interface SessionState {
  meta: SessionMeta;
  sequence: number;
}

export class SessionManager {
  private readonly sessions = new Map<SourceKind, SessionState>();

  start(source: SourceKind, details: { username?: string; roomId?: string } = {}): SessionMeta {
    const startedAt = Date.now();
    const safeName = (details.username ?? source).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const sessionId = `${startedAt}_${safeName}_${randomUUID().slice(0, 8)}`;
    const meta: SessionMeta = {
      sessionId,
      source,
      username: details.username,
      roomId: details.roomId,
      startedAt,
      endedAt: 0,
      schemaVersion: 1,
    };
    this.sessions.set(source, { meta, sequence: 0 });
    return meta;
  }

  ensure(source: SourceKind, details: { username?: string; roomId?: string } = {}): SessionMeta {
    return this.sessions.get(source)?.meta ?? this.start(source, details);
  }

  nextSequence(source: SourceKind): { session: SessionMeta; sequence: number } {
    const state = this.sessions.get(source) ?? (() => {
      this.start(source);
      return this.sessions.get(source)!;
    })();
    state.sequence += 1;
    return { session: state.meta, sequence: state.sequence };
  }

  update(source: SourceKind, details: { roomId?: string; username?: string }): void {
    const state = this.sessions.get(source);
    if (!state) return;
    if (details.roomId) state.meta.roomId = details.roomId;
    if (details.username) state.meta.username = details.username;
  }

  end(source: SourceKind): SessionMeta | undefined {
    const state = this.sessions.get(source);
    if (!state) return undefined;
    state.meta.endedAt = Date.now();
    return state.meta;
  }

  current(source: SourceKind): SessionMeta | undefined {
    return this.sessions.get(source)?.meta;
  }
}
