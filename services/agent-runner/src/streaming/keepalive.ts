/**
 * Long-lived streaming responses that survive proxies.
 *
 * Every hop between the runner and a caller can cut a quiet stream:
 * Cloudflare's proxy drops a connection after 100 s with no bytes (HTTP 524,
 * not configurable below Enterprise), ingress-nginx buffers upstream
 * responses unless told otherwise, and any compressor on the path can hold
 * small writes back. A turn is quiet for long stretches — a model cold-load,
 * a long tool call, a reasoning pass — so the stream has to prove it is alive
 * on its own.
 *
 * `openKeepaliveStream` owns that: it writes the status line and the
 * no-buffering headers, flushes them straight away, and while the stream is
 * idle writes a keepalive every `intervalMs` that the reader is guaranteed to
 * ignore:
 *
 *   - `ndjson`: a single space. It is only ever written BETWEEN complete
 *     lines, so it becomes leading whitespace on the next line, which every
 *     JSON parser skips (and line readers that trim already drop it).
 *   - `sse`: a `: ping` comment line, which the SSE spec says to ignore.
 *
 * Node runs this on one thread and every `write()` is a complete record, so a
 * keepalive can never land inside a record — that is what "serialized" means
 * here, no lock needed. The timer stops on end, close or error.
 */
import type { ServerResponse } from 'node:http';

export type KeepaliveFormat = 'ndjson' | 'sse';

/** Well under Cloudflare's 100 s idle cut, with room for a slow hop. */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;

export const KEEPALIVE_BYTES: Record<KeepaliveFormat, string> = {
  ndjson: ' ',
  sse: ': ping\n\n',
};

const CONTENT_TYPES: Record<KeepaliveFormat, string> = {
  ndjson: 'application/x-ndjson',
  sse: 'text/event-stream',
};

export interface KeepaliveStreamOptions {
  format: KeepaliveFormat;
  /** Idle time before a keepalive is written. Defaults to 15 s. */
  intervalMs?: number;
  /** Status for the stream response. Defaults to 200. */
  status?: number;
  /** Extra headers; the no-buffering headers win over these. */
  headers?: Record<string, string>;
}

export interface KeepaliveStream {
  /** Write one complete record (an NDJSON line or an SSE event). Dropped after end/close. */
  write(record: string): void;
  /** Stop the heartbeat and end the response. Idempotent. */
  end(): void;
  /** True once the response has ended or the connection has gone. */
  readonly closed: boolean;
}

export function openKeepaliveStream(res: ServerResponse, opts: KeepaliveStreamOptions): KeepaliveStream {
  const intervalMs = opts.intervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  const keepalive = KEEPALIVE_BYTES[opts.format];

  res.writeHead(opts.status ?? 200, {
    ...opts.headers,
    'content-type': CONTENT_TYPES[opts.format],
    // no-transform: no hop may recompress or rewrite the body (compression
    // buffers). X-Accel-Buffering: ingress-nginx streams this response even
    // when the ingress itself has buffering on.
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  // Put the headers on the wire now: a proxy that has not seen a byte yet is
  // already counting towards its idle limit.
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  let lastWriteAt = Date.now();
  let stopped = false;
  const isGone = () => stopped || res.writableEnded || res.destroyed;

  const timer = setInterval(() => {
    if (isGone()) {
      stop();
      return;
    }
    if (Date.now() - lastWriteAt < intervalMs) {return;}
    res.write(keepalive);
    lastWriteAt = Date.now();
  }, Math.max(1, Math.floor(intervalMs / 3)));
  // Never keep the process alive just to ping a stream.
  timer.unref?.();

  function stop(): void {
    if (stopped) {return;}
    stopped = true;
    clearInterval(timer);
  }

  res.once('close', stop);
  res.once('finish', stop);
  res.once('error', stop);

  return {
    write(record: string): void {
      if (isGone()) {return;}
      res.write(record);
      lastWriteAt = Date.now();
    },
    end(): void {
      stop();
      if (!res.writableEnded) {res.end();}
    },
    get closed(): boolean {
      return isGone();
    },
  };
}
