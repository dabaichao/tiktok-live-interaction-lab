import type { NormalizedLiveEvent } from "./events.js";

export type NormalizedEventListener = (event: NormalizedLiveEvent) => void | Promise<void>;

export class EventBus {
  private readonly listeners = new Set<NormalizedEventListener>();

  subscribe(listener: NormalizedEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: NormalizedLiveEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          void result.catch(() => undefined);
        }
      } catch {
        // Event consumers must not be able to stop collection for other consumers.
      }
    }
  }
}
