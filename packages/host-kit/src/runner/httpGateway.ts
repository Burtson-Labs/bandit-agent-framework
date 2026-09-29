/**
 * HTTP implementation of the RunnerGateway seam.
 *
 * Inbox: a long-lived SSE stream (`GET {base}/api/stealth/runner/inbox`) — the
 * device reaches OUT to the gateway (so no inbound port / NAT hole is needed),
 * and tasks assigned to it arrive as `data:` lines. Reconnects with backoff on
 * a dropped stream; the async iterator only returns when `signal` aborts.
 *
 * Publish: `POST {base}/api/stealth/tasks/{taskId}/events` — one event per call.
 *
 * Both carry the Bandit cloud JWT as a bearer token and a stable device id, so
 * the gateway can authorize the device and scope tasks to its owner. This file
 * is the WIRE CONTRACT the gateway side must implement. The SSE reader and the
 * stall watchdog are covered in test/httpGateway.test.ts with a fake fetch.
 *
 * Proxies: the gateway sits behind ingress-nginx and Cloudflare, which drops a
 * connection after 100 s with no bytes. The gateway writes `: ping` comments
 * every few seconds, so the reader ignores comments and non-`data` fields
 * (`event: ping` included) and treats ANY bytes as proof of life. A stream
 * that goes silent for `stallTimeoutMs` is a half-open connection (a dropped
 * tunnel, a sleeping laptop) — it is torn down and reconnected rather than
 * waited on forever.
 */
import type { RemoteTask, RunnerEvent, RunnerGateway } from './contract';

export interface HttpGatewayOptions {
  /** Gateway base URL, e.g. https://gateway.burtson.ai (no trailing slash). */
  baseUrl: string;
  /** Bandit cloud JWT / API key for the signed-in account. */
  token: string;
  /** Stable id for this device (so the gateway can target it + show presence). */
  deviceId: string;
  /** Human label shown in the web device picker (hostname by default). */
  deviceLabel?: string;
  /** Injectable for tests / non-global-fetch runtimes. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Reconnect backoff ceiling (ms). */
  maxBackoffMs?: number;
  /**
   * Reconnect when the inbox stream delivers no bytes at all for this long
   * (ms). The gateway pings every few seconds, so silence means the
   * connection is dead even if the socket has not noticed. Default 60 s.
   */
  stallTimeoutMs?: number;
}

const DEFAULT_INBOX_STALL_MS = 60_000;

export class HttpRunnerGateway implements RunnerGateway {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpGatewayOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      'x-bandit-device-id': this.opts.deviceId,
      'x-bandit-device-label': this.opts.deviceLabel ?? this.opts.deviceId,
      ...extra
    };
  }

  async *inbox(signal: AbortSignal): AsyncIterable<RemoteTask> {
    const url = `${this.opts.baseUrl}/api/stealth/runner/inbox`;
    const ceil = this.opts.maxBackoffMs ?? 30_000;
    let backoff = 1_000;
    while (!signal.aborted) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.headers({ accept: 'text/event-stream' }),
          signal
        });
        if (!res.ok || !res.body) {
          throw new Error(`inbox ${res.status} ${res.statusText}`);
        }
        backoff = 1_000; // healthy connection resets the backoff
        const stallMs = this.opts.stallTimeoutMs ?? DEFAULT_INBOX_STALL_MS;
        for await (const data of readSseData(res.body, signal, stallMs)) {
          const task = parseTask(data);
          if (task) yield task;
        }
        // Stream ended cleanly (server closed) — reconnect after a short pause.
      } catch (err) {
        if (signal.aborted) return;
        // Surface nothing to the model — this is runner plumbing. Backoff+retry.
        void err;
      }
      if (signal.aborted) return;
      await delay(backoff, signal);
      backoff = Math.min(ceil, backoff * 2);
    }
  }

  async publish(taskId: string, event: RunnerEvent): Promise<void> {
    const url = `${this.opts.baseUrl}/api/stealth/tasks/${encodeURIComponent(taskId)}/events`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(event)
    });
    if (!res.ok) {
      throw new Error(`publish ${res.status} ${res.statusText}`);
    }
  }
}

function parseTask(data: string): RemoteTask | null {
  try {
    const obj = JSON.parse(data) as RemoteTask;
    if (obj && typeof obj.taskId === 'string' && typeof obj.prompt === 'string') return obj;
  } catch {
    /* keep-alive comment or malformed line — ignore */
  }
  return null;
}

/**
 * Minimal SSE reader over a fetch ReadableStream: yields the `data:` payload of
 * each event (concatenating multi-line data blocks), ignoring comments and
 * other fields. Enough for the inbox, which only sends `data:` task JSON +
 * keep-alive comments. CRLF line endings are normalised. When no bytes arrive
 * for `stallMs` the read is cancelled and an error thrown, so the caller
 * reconnects.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  stallMs = DEFAULT_INBOX_STALL_MS
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await readWithStall(reader, stallMs);
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let sep: number;
      // Events are separated by a blank line.
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''));
        if (dataLines.length) yield dataLines.join('\n');
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** `reader.read()` that rejects when nothing — not even a keepalive — arrives in `stallMs`. */
function readWithStall<T>(
  reader: ReadableStreamDefaultReader<T>,
  stallMs: number
): Promise<ReadableStreamReadResult<T>> {
  if (!(stallMs > 0) || !Number.isFinite(stallMs)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject BEFORE cancelling: cancel settles the pending read as
      // `done`, which would otherwise win the race and look like a clean end.
      reject(new Error(`inbox stream stalled: no bytes for ${stallMs}ms`));
      reader.cancel().catch(() => { /* already closed */ });
    }, stallMs);
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
