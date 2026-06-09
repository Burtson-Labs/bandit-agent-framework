/**
 * Contract tests for PasteBuffer — pins the multi-line-paste-as-one-
 * message behavior that v1.7.287 shipped and that the upcoming ink
 * refactor must preserve.
 *
 * The tests inject a virtual timer (no real setTimeout) so we can
 * deterministically advance time across the 50 ms flush window
 * without waiting wall-clock time.
 */
import { describe, expect, it } from 'vitest';
import { PasteBuffer } from '../src/input/pasteBuffer';

/**
 * Lightweight controllable clock for tests. setTimer returns a handle,
 * clearTimer cancels it, tick(ms) fires every scheduled callback whose
 * deadline has elapsed.
 */
function makeFakeClock() {
  let now = 0;
  const scheduled: Array<{ id: number; fireAt: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.push({ id, fireAt: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const idx = scheduled.findIndex((t) => t.id === handle);
      if (idx >= 0) scheduled.splice(idx, 1);
    },
    tick: (ms: number) => {
      now += ms;
      const ready = scheduled.filter((t) => t.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
      for (const t of ready) {
        const idx = scheduled.findIndex((s) => s.id === t.id);
        if (idx >= 0) scheduled.splice(idx, 1);
        t.fn();
      }
    },
    scheduledCount: () => scheduled.length
  };
}

describe('PasteBuffer', () => {
  it('flushes a single pushed line as itself after the debounce window', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    buf.push('hello world');
    expect(flushed).toEqual([]);                          // not yet — timer not fired
    clock.tick(50);
    expect(flushed).toEqual(['hello world']);             // flushed once
    expect(buf.size).toBe(0);
  });

  it('coalesces a burst of lines (paste shape) into one merged flush', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    // Simulate a 4-line paste arriving with 5 ms between lines.
    buf.push('line 1');
    clock.tick(5);
    buf.push('line 2');
    clock.tick(5);
    buf.push('line 3');
    clock.tick(5);
    buf.push('line 4');
    expect(flushed).toEqual([]);                          // burst still arriving
    clock.tick(50);                                       // quiet window completes
    expect(flushed).toEqual(['line 1\nline 2\nline 3\nline 4']);
  });

  it('treats slowly-typed Enter presses as separate flushes', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    buf.push('first');
    clock.tick(50);                                       // 50 ms quiet — flush
    buf.push('second');
    clock.tick(50);
    buf.push('third');
    clock.tick(50);
    expect(flushed).toEqual(['first', 'second', 'third']);
  });

  it('respects a custom flushMs configuration', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      flushMs: 200,
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    buf.push('x');
    clock.tick(100);
    expect(flushed).toEqual([]);                          // < 200 ms, not flushed yet
    clock.tick(100);                                      // total 200 ms — flush
    expect(flushed).toEqual(['x']);
  });

  it('flush() force-empties the buffer and clears the pending timer', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    buf.push('a');
    buf.push('b');
    expect(clock.scheduledCount()).toBe(1);               // one pending timer
    buf.flush();
    expect(flushed).toEqual(['a\nb']);
    expect(buf.size).toBe(0);
    expect(clock.scheduledCount()).toBe(0);               // timer cleared

    // Subsequent tick does NOT re-fire (would mean a stale timer leaked).
    clock.tick(100);
    expect(flushed).toEqual(['a\nb']);
  });

  it('flush() is a no-op when buffer is empty (no spurious empty submission)', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    buf.flush();
    expect(flushed).toEqual([]);
  });

  it('discard() drops buffered content and clears the timer without firing onFlush', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    buf.push('paste line 1');
    buf.push('paste line 2');
    buf.discard();
    expect(buf.size).toBe(0);
    expect(clock.scheduledCount()).toBe(0);

    // Timer doesn't fire later either (regression guard: stale timer firing
    // after a sub-flow took priority would land the discarded paste in
    // the wrong handler).
    clock.tick(500);
    expect(flushed).toEqual([]);
  });

  it('size reflects the buffer count between pushes and flushes', () => {
    const clock = makeFakeClock();
    const buf = new PasteBuffer({
      onFlush: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    expect(buf.size).toBe(0);
    buf.push('1');
    expect(buf.size).toBe(1);
    buf.push('2');
    buf.push('3');
    expect(buf.size).toBe(3);
    clock.tick(50);
    expect(buf.size).toBe(0);
  });

  it('handles empty-string lines inside a paste (preserves them in the merge)', () => {
    const clock = makeFakeClock();
    const flushed: string[] = [];
    const buf = new PasteBuffer({
      onFlush: (m) => flushed.push(m),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    // Pasted block with a blank line in the middle (common in markdown
    // or code snippets).
    buf.push('paragraph one');
    buf.push('');
    buf.push('paragraph two');
    clock.tick(50);
    expect(flushed).toEqual(['paragraph one\n\nparagraph two']);
  });
});
