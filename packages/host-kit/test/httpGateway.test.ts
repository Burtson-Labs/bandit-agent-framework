/**
 * The runner inbox SSE reader against what the gateway (behind ingress-nginx
 * and Cloudflare) actually sends: `: ping` comments, `event: ping` heartbeats,
 * CRLF line endings, events split across chunks, and — when a proxy leaves a
 * connection half-open — silence, which must trigger a reconnect.
 */
import { describe, it, expect } from 'vitest';
import { HttpRunnerGateway, readSseData } from '../src/runner/httpGateway';
import type { RemoteTask } from '../src/runner/contract';

const enc = new TextEncoder();

/** A body that emits `chunks` in order and then either closes or hangs open. */
function body(chunks: string[], hang = false): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
        return;
      }
      if (!hang) controller.close();
      // hang: never enqueue again, never close — a half-open connection.
      return new Promise<void>(() => {});
    }
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of stream) out.push(s);
  return out;
}

const task = (id: string) => JSON.stringify({ taskId: id, prompt: 'p', protocol: 1 });

describe('readSseData', () => {
  it('ignores keepalive comments and event: ping heartbeats', async () => {
    const data = await collect(
      readSseData(
        body([
          ': connected\n\n',
          ': ping\n\n',
          'event: ping\ndata: {"message":"heartbeat"}\n\n',
          `data: ${task('t1')}\n\n`
        ]),
        new AbortController().signal
      )
    );
    // The heartbeat's data is yielded as data (the reader is generic) but it
    // is not a task — parseTask drops it; see the inbox test below.
    expect(data).toEqual(['{"message":"heartbeat"}', task('t1')]);
  });

  it('handles CRLF line endings and events split across chunks', async () => {
    const t = task('t2');
    const data = await collect(
      readSseData(
        body([': ping\r\n\r\n', `data: ${t.slice(0, 10)}`, `${t.slice(10)}\r`, '\n\r\n']),
        new AbortController().signal
      )
    );
    expect(data).toEqual([t]);
  });

  it('gives up on a stream that goes completely silent', async () => {
    await expect(
      collect(readSseData(body([': connected\n\n'], true), new AbortController().signal, 50))
    ).rejects.toThrow(/stalled/);
  });

  it('keepalive bytes count as life: a pinging stream does not stall', async () => {
    let n = 0;
    const pinging = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 20));
        if (n++ < 6) controller.enqueue(enc.encode(': ping\n\n'));
        else controller.close();
      }
    });
    // 6 x 20 ms = 120 ms total, well past the 50 ms stall budget.
    await expect(collect(readSseData(pinging, new AbortController().signal, 50))).resolves.toEqual([]);
  });
});

describe('HttpRunnerGateway.inbox', () => {
  it('yields only real tasks and reconnects after a stalled stream', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const chunks =
        calls === 1
          ? [': connected\n\n', 'event: ping\ndata: {"message":"heartbeat"}\n\n', `data: ${task('a')}\n\n`]
          : [': connected\n\n', `data: ${task('b')}\n\n`];
      // First connection goes half-open after its task; the second is healthy.
      return new Response(body(chunks, calls === 1), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }) as typeof fetch;

    const gw = new HttpRunnerGateway({
      baseUrl: 'https://gw.test',
      token: 't',
      deviceId: 'd',
      fetchImpl,
      stallTimeoutMs: 50,
      maxBackoffMs: 10
    });
    const controller = new AbortController();
    const seen: RemoteTask[] = [];
    for await (const t of gw.inbox(controller.signal)) {
      seen.push(t);
      if (seen.length === 2) controller.abort();
    }
    expect(seen.map((t) => t.taskId)).toEqual(['a', 'b']);
    expect(calls).toBe(2);
  }, 10_000);
});
