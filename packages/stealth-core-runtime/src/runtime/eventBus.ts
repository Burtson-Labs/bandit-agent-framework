export type EventListener<T = unknown> = (payload: T) => void | Promise<void>;

export interface EventBus {
  emit<T = unknown>(event: string, payload: T): Promise<void>;
  on<T = unknown>(event: string, listener: EventListener<T>): () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<EventListener>>();

  async function emit<T>(event: string, payload: T): Promise<void> {
    const handlers = listeners.get(event);
    if (!handlers || handlers.size === 0) {
      return;
    }
    for (const handler of Array.from(handlers)) {
      try {
        await handler(payload);
      } catch (error) {
        console.warn(`Event handler for "${event}" failed`, error);
      }
    }
  }

  function on<T>(event: string, listener: EventListener<T>): () => void {
    const existing = listeners.get(event) ?? new Set<EventListener>();
    existing.add(listener as EventListener);
    listeners.set(event, existing);
    return () => existing.delete(listener as EventListener);
  }

  return { emit, on };
}
