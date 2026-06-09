/**
 * Reads from a `ReadableStreamDefaultReader` with an idle-byte timeout.
 *
 * Wraps `reader.read()` so we can recover when an LLM stream stalls mid-
 * response (gateway hairpin drop, upstream Ollama hang post-headers, etc.).
 * Node's underlying fetch has a multi-minute default before it errors a
 * stalled body, which leaves the agent loop suspended on `for await` with
 * no events firing. This helper trips at a tighter threshold (default 90 s)
 * and throws, which the tool-use-loop's existing try/catch converts into a
 * normal `tool_loop:llm_retry` recovery — same path that handles 5xx and
 * network blips.
 *
 * The timer resets on every successful read, so legitimate slow generation
 * (model thinking, large chunks) doesn't fire. Even a single byte (SSE
 * keep-alive newline, partial JSON token) keeps the stream alive.
 *
 * A `warnAfterMs` callback fires once before the abort threshold so hosts
 * can surface "stream went quiet — still waiting…" status in the UI without
 * waiting the full idle window. The warning is observational only; it does
 * not cancel the read.
 */
export interface IdleTimeoutOptions {
  /** Abort after this many ms of no data. Default 90_000. */
  idleMs?: number;
  /** Fire `onWarn` once after this many ms of silence. Skipped if undefined or >= idleMs. */
  warnAfterMs?: number;
  /** Callback invoked once at `warnAfterMs`. Errors thrown here are swallowed. */
  onWarn?: (elapsedMs: number) => void;
  /** Label embedded in the thrown error message for log clarity. */
  abortLabel?: string;
}

export const DEFAULT_STREAM_IDLE_MS = 90_000;
export const DEFAULT_STREAM_WARN_MS = 30_000;

export async function readWithIdleTimeout<T>(
  reader: { read(): Promise<ReadableStreamReadResult<T>>; cancel?: () => Promise<void> | void },
  opts: IdleTimeoutOptions = {}
): Promise<ReadableStreamReadResult<T>> {
  const idleMs = opts.idleMs ?? DEFAULT_STREAM_IDLE_MS;
  const warnAfterMs = opts.warnAfterMs;
  const onWarn = opts.onWarn;
  const abortLabel = opts.abortLabel ?? 'LLM stream';

  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (warnTimer) {clearTimeout(warnTimer);}
    if (abortTimer) {clearTimeout(abortTimer);}
  };

  try {
    return await new Promise<ReadableStreamReadResult<T>>((resolve, reject) => {
      if (typeof warnAfterMs === 'number' && warnAfterMs > 0 && warnAfterMs < idleMs && onWarn) {
        warnTimer = setTimeout(() => {
          try { onWarn(warnAfterMs); } catch { /* observability only */ }
        }, warnAfterMs);
      }
      abortTimer = setTimeout(() => {
        try { void reader.cancel?.(); } catch { /* best effort */ }
        reject(new Error(`${abortLabel} stalled — no data for ${idleMs}ms`));
      }, idleMs);
      reader.read().then(resolve, reject);
    });
  } finally {
    cleanup();
  }
}
