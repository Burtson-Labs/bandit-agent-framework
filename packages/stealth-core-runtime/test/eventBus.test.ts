/**
 * Contract tests for createEventBus — tiny pub-sub primitive used
 * across the runtime for telemetry / lifecycle events. The whole
 * surface is 33 lines but it's hit on every iteration of every loop,
 * so the contract needs to be air-tight:
 *
 *   - emit() is async and awaits every listener (so callers can
 *     reliably know "all handlers have run" by awaiting emit)
 *   - on() returns an unsubscribe function (NOT a Disposable shape;
 *     just a () => void) — pinning the shape because callers store
 *     and call it directly
 *   - listener errors are caught + logged, never propagated (one
 *     bad listener can't break others)
 *   - emit on an unsubscribed event is a no-op
 *   - handler iteration is snapshot-safe — listeners added DURING
 *     an emit don't fire on the in-flight broadcast
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../src/runtime/eventBus';

describe('createEventBus', () => {
  it('emit on a never-subscribed event is a no-op (no throw, no error)', async () => {
    const bus = createEventBus();
    await expect(bus.emit('nothing-here', { x: 1 })).resolves.toBeUndefined();
  });

  it('on() delivers the payload to a single listener', async () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    bus.on<{ a: number }>('tick', (p) => { seen.push(p); });
    await bus.emit('tick', { a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
  });

  it('fans out to multiple listeners in registration order', async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on('go', () => { order.push('first'); });
    bus.on('go', () => { order.push('second'); });
    bus.on('go', () => { order.push('third'); });
    await bus.emit('go', null);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('awaits async listeners before emit() resolves', async () => {
    const bus = createEventBus();
    let resolved = false;
    bus.on('slow', async () => {
      await new Promise((r) => setTimeout(r, 20));
      resolved = true;
    });
    await bus.emit('slow', null);
    expect(resolved).toBe(true);
  });

  it('on() returns an unsubscribe function that stops further deliveries', async () => {
    const bus = createEventBus();
    let calls = 0;
    const off = bus.on('event', () => { calls += 1; });
    await bus.emit('event', null);
    off();
    await bus.emit('event', null);
    expect(calls).toBe(1);
  });

  it('isolates listeners — a throwing handler does not break others', async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    // Silence the console.warn the bus uses to report the failure so
    // the test output stays clean. The behavior we care about is that
    // emit() doesn't reject and the second listener still fires.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    bus.on('e', () => { throw new Error('boom'); });
    bus.on('e', () => { seen.push('still ran'); });
    await expect(bus.emit('e', null)).resolves.toBeUndefined();
    expect(seen).toEqual(['still ran']);
    warnSpy.mockRestore();
  });

  it('handler iteration is snapshot-safe — a listener added during emit does NOT fire on the in-flight broadcast', async () => {
    // The implementation copies the handler set with `Array.from(...)`
    // before iterating, so an `on()` call from inside a handler can't
    // self-trigger. Pin this — otherwise a reentrant listener could
    // form an unbounded recursion.
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('e', () => {
      seen.push('first');
      bus.on('e', () => { seen.push('second-late'); });
    });
    await bus.emit('e', null);
    expect(seen).toEqual(['first']);
    // The late listener IS registered for future emits, just not this one.
    await bus.emit('e', null);
    expect(seen).toEqual(['first', 'first', 'second-late']);
  });

  it('different event names route independently', async () => {
    const bus = createEventBus();
    const a: number[] = [];
    const b: number[] = [];
    bus.on<number>('a', (n) => { a.push(n); });
    bus.on<number>('b', (n) => { b.push(n); });
    await bus.emit('a', 1);
    await bus.emit('b', 2);
    await bus.emit('a', 3);
    expect(a).toEqual([1, 3]);
    expect(b).toEqual([2]);
  });

  it('unsubscribing a listener twice is a safe no-op', () => {
    const bus = createEventBus();
    const off = bus.on('e', () => undefined);
    off();
    expect(() => off()).not.toThrow();
  });

  it('the same listener registered twice fires once per emit (Set dedupe)', async () => {
    // Internal storage is a Set — adding the same function reference
    // twice should be a no-op, not a double-delivery. Pin this so a
    // future refactor to an array doesn't quietly double-fan-out.
    const bus = createEventBus();
    let calls = 0;
    const handler = () => { calls += 1; };
    bus.on('e', handler);
    bus.on('e', handler);
    await bus.emit('e', null);
    expect(calls).toBe(1);
  });
});
