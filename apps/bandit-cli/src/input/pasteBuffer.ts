/**
 * Coalesces a burst of `line` events that look like a multi-line paste
 * into a single submission.
 *
 * Background: terminal pastes deliver each line in rapid succession
 * (< 10-20 ms apart on common terminals); typed input has > 100 ms
 * between Enter keypresses. A 50 ms debounce timer reliably distinguishes
 * the two. The pure logic lives here so the ink refactor of the input
 * layer can swap the underlying line-event source (readline today, ink
 * tomorrow) without changing the "multi-line paste arrives as one
 * message, not N queued turns" contract this fixed in v1.7.287.
 *
 * The buffer is opt-in: callers push lines AS they arrive on the line-
 * event, and the buffer fires `onFlush` once with the merged content
 * after `flushMs` of quiet. Callers can also force `flush()` (e.g. when
 * a sub-flow needs immediate control) or `discard()` the buffered
 * content (when context says it must not leak through).
 *
 * The timer is parameterized so tests can inject a deterministic clock
 * instead of waiting 50 ms on every assertion.
 */

export interface PasteBufferOptions {
  /** Receives the (possibly multi-line) merged content when the
   *  buffer flushes. Called with the joined string. */
  onFlush: (merged: string) => void;
  /** Milliseconds of quiet before the buffer auto-flushes. Default 50.
   *  Tuned for real terminal paste behavior: a 50+ line paste arrives
   *  within ~5-15ms total, fast typing has > 100ms between Enters. */
  flushMs?: number;
  /** Timer factory — defaults to setTimeout. Tests inject a virtual
   *  timer so they can advance time deterministically. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Mirrors setTimer's factory. Must clear whatever setTimer returned. */
  clearTimer?: (handle: unknown) => void;
}

export class PasteBuffer {
  private buffer: string[] = [];
  private timer: unknown = null;
  private readonly flushMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onFlush: (merged: string) => void;

  constructor(options: PasteBufferOptions) {
    this.flushMs = options.flushMs ?? 50;
    this.onFlush = options.onFlush;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Number of lines currently buffered (not yet flushed). */
  get size(): number {
    return this.buffer.length;
  }

  /** Push a line into the buffer and (re)arm the flush timer. */
  push(line: string): void {
    this.buffer.push(line);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.flush(), this.flushMs);
  }

  /**
   * Force-flush immediately. Called by sub-flows that need to consume
   * the buffered content before the debounce window expires.
   */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const merged = this.buffer.join('\n');
    this.buffer = [];
    this.onFlush(merged);
  }

  /**
   * Drop the buffered content without flushing. Used when context
   * switches mid-paste — e.g. a permission prompt opens while a paste
   * is in flight; the buffered lines should NOT leak into the prompt's
   * input handler.
   */
  discard(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }
}
