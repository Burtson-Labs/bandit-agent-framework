import type { AgentEvent } from "../types/agent";

export type AgentEventListener = (event: AgentEvent) => void;

export class AgentEventEmitter {
  private listeners = new Map<string, Set<AgentEventListener>>();

  on(event: string, listener: AgentEventListener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  once(event: string, listener: AgentEventListener): void {
    const wrapper: AgentEventListener = (evt) => {
      this.off(event, wrapper);
      listener(evt);
    };
    this.on(event, wrapper);
  }

  off(event: string, listener: AgentEventListener): void {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (!listeners.size) {
      this.listeners.delete(event);
    }
  }

  removeListener(event: string, listener: AgentEventListener): void {
    this.off(event, listener);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.clear();
  }

  emit(event: string, payload: AgentEvent): void {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

