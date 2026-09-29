/**
 * The keepalive stream: headers that stop proxies buffering, heartbeat bytes
 * while idle (and only while idle), and a timer that dies with the response.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openKeepaliveStream, type KeepaliveFormat, type KeepaliveStream } from '../src/streaming/keepalive';

const open: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function serve(handler: (res: http.ServerResponse) => void | Promise<void>): Promise<string> {
  const server = http.createServer((_req, res) => void handler(res));
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('openKeepaliveStream', () => {
  it('sends the no-buffering headers before the first record', async () => {
    let stream: KeepaliveStream | undefined;
    const url = await serve((res) => {
      stream = openKeepaliveStream(res, { format: 'sse', intervalMs: 60_000 });
    });

    // Headers arrive although nothing has been written yet — flushHeaders.
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    stream?.end();
    await res.text();
  });

  it.each<[KeepaliveFormat, string]>([
    ['ndjson', ' '],
    ['sse', ': ping\n\n'],
  ])('writes %s keepalives while idle', async (format, bytes) => {
    const url = await serve(async (res) => {
      const stream = openKeepaliveStream(res, { format, intervalMs: 30 });
      await sleep(120);
      stream.end();
    });

    const body = await (await fetch(url)).text();

    expect(body.length).toBeGreaterThan(0);
    expect(body.split(bytes).join('')).toBe('');
  });

  it('keeps an NDJSON stream parseable: keepalives only ever sit between lines', async () => {
    const url = await serve(async (res) => {
      const stream = openKeepaliveStream(res, { format: 'ndjson', intervalMs: 20 });
      stream.write(JSON.stringify({ n: 1 }) + '\n');
      await sleep(80);
      stream.write(JSON.stringify({ n: 2 }) + '\n');
      await sleep(80);
      stream.end();
    });

    const body = await (await fetch(url)).text();
    const lines = body.split('\n').filter((l) => l.trim());

    expect(body).toMatch(/\n +\{/); // a keepalive really did land before line 2
    expect(lines.map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([1, 2]);
  });

  it('does not ping a stream that is busy', async () => {
    const url = await serve(async (res) => {
      const stream = openKeepaliveStream(res, { format: 'ndjson', intervalMs: 250 });
      for (let i = 0; i < 8; i++) {
        stream.write(`{"i":${i}}\n`);
        await sleep(15);
      }
      stream.end();
    });

    const body = await (await fetch(url)).text();
    expect(body).not.toContain(' ');
  });

  it('stops pinging and drops writes once the client has gone', async () => {
    let stream: KeepaliveStream | undefined;
    const closed = new Promise<void>((resolve) => {
      void serve((res) => {
        stream = openKeepaliveStream(res, { format: 'sse', intervalMs: 10 });
        res.on('close', () => resolve());
      }).then(async (url) => {
        const controller = new AbortController();
        const res = await fetch(url, { signal: controller.signal });
        await res.body?.getReader().read();
        controller.abort();
      });
    });
    await closed;

    expect(stream?.closed).toBe(true);
    expect(() => stream?.write('data: late\n\n')).not.toThrow();
    expect(() => stream?.end()).not.toThrow();
  });
});
