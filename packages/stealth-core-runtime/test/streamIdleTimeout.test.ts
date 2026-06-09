import { describe, expect, it, vi } from 'vitest';
import { readWithIdleTimeout } from '../src/streamIdleTimeout';

type ReadStep =
  | { kind: 'value'; value: Uint8Array; delayMs: number }
  | { kind: 'done'; delayMs: number }
  | { kind: 'hang' };

function createMockReader(steps: ReadStep[]): {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => void;
  cancelled: () => boolean;
} {
  let i = 0;
  let cancelled = false;
  return {
    read: () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const step = steps[i++];
        if (!step || step.kind === 'hang') {
          // Never resolve — simulates a stalled stream.
          return;
        }
        if (step.kind === 'done') {
          setTimeout(() => resolve({ value: undefined, done: true }), step.delayMs);
          return;
        }
        setTimeout(() => resolve({ value: step.value, done: false }), step.delayMs);
      }),
    cancel: () => {
      cancelled = true;
    },
    cancelled: () => cancelled
  };
}

describe('readWithIdleTimeout', () => {
  it('returns the chunk when read completes before idleMs', async () => {
    vi.useFakeTimers();
    const reader = createMockReader([{ kind: 'value', value: new Uint8Array([1, 2]), delayMs: 50 }]);
    const promise = readWithIdleTimeout(reader, { idleMs: 1000 });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;
    expect(result.done).toBe(false);
    expect(result.value).toEqual(new Uint8Array([1, 2]));
    expect(reader.cancelled()).toBe(false);
    vi.useRealTimers();
  });

  it('throws with the configured abortLabel when no data arrives within idleMs', async () => {
    vi.useFakeTimers();
    const reader = createMockReader([{ kind: 'hang' }]);
    const promise = readWithIdleTimeout(reader, { idleMs: 200, abortLabel: 'Test stream' });
    const expectation = expect(promise).rejects.toThrow(/Test stream stalled — no data for 200ms/);
    await vi.advanceTimersByTimeAsync(200);
    await expectation;
    expect(reader.cancelled()).toBe(true);
    vi.useRealTimers();
  });

  it('fires onWarn exactly once at warnAfterMs but does not abort', async () => {
    vi.useFakeTimers();
    const reader = createMockReader([{ kind: 'value', value: new Uint8Array([7]), delayMs: 500 }]);
    const onWarn = vi.fn();
    const promise = readWithIdleTimeout(reader, { idleMs: 1000, warnAfterMs: 100, onWarn });
    await vi.advanceTimersByTimeAsync(100);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(100);
    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;
    expect(result.value).toEqual(new Uint8Array([7]));
    expect(reader.cancelled()).toBe(false);
    expect(onWarn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not fire onWarn when the chunk arrives before warnAfterMs', async () => {
    vi.useFakeTimers();
    const reader = createMockReader([{ kind: 'value', value: new Uint8Array([3]), delayMs: 20 }]);
    const onWarn = vi.fn();
    const promise = readWithIdleTimeout(reader, { idleMs: 1000, warnAfterMs: 100, onWarn });
    await vi.advanceTimersByTimeAsync(20);
    await promise;
    await vi.advanceTimersByTimeAsync(200);
    expect(onWarn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips onWarn wiring when warnAfterMs >= idleMs', async () => {
    vi.useFakeTimers();
    const reader = createMockReader([{ kind: 'hang' }]);
    const onWarn = vi.fn();
    const promise = readWithIdleTimeout(reader, { idleMs: 100, warnAfterMs: 100, onWarn });
    const expectation = expect(promise).rejects.toThrow(/stalled/);
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    expect(onWarn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('propagates underlying reader.read() errors without waiting for the timer', async () => {
    const reader = {
      read: () => Promise.reject(new Error('socket closed')),
      cancel: vi.fn()
    };
    await expect(readWithIdleTimeout(reader, { idleMs: 5000 })).rejects.toThrow(/socket closed/);
  });

  it('handles done=true cleanly (end of stream)', async () => {
    vi.useFakeTimers();
    const reader = createMockReader([{ kind: 'done', delayMs: 10 }]);
    const promise = readWithIdleTimeout(reader, { idleMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
    vi.useRealTimers();
  });
});
