/**
 * The HTTP surface: auth (SEC-001), input policy at the seam (SEC-002),
 * correlation ids (SEC-006), the body cap (TD-004), cancellation
 * (COMP-004) and the stream-termination contract.
 *
 * The turn executor is injected in most cases — this file is about the
 * boundary, not the agent. `turn.test.ts` covers the loop side.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRunnerServer, readBody, type RunnerServerDeps } from '../src/server';
import { DEFAULT_MAX_BODY_BYTES, type RunnerConfig } from '../src/config';
import { createLogger } from '../src/logger';
import type { RunnerEvent, TurnRequest } from '../src/contract';

const open: Server[] = [];
const tmpDirs: string[] = [];

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
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; ws: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-http-'));
  tmpDirs.push(root);
  const ws = path.join(root, 'task-1');
  fs.mkdirSync(ws);
  return { root, ws };
}

interface Harness {
  url: string;
  logs: Array<Record<string, unknown>>;
}

async function start(config: Partial<RunnerConfig>, deps: RunnerServerDeps = {}): Promise<Harness> {
  const logs: Array<Record<string, unknown>> = [];
  const logger =
    deps.logger ?? createLogger({ level: 'debug', sink: (line) => logs.push(JSON.parse(line)) });
  const server = createRunnerServer(
    {
      port: 0,
      host: '127.0.0.1',
      permissionMode: 'standard',
      logLevel: 'silent',
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      ...config,
    },
    { ...deps, logger },
  );
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, logs };
}

/** A turn executor that never touches a model: two events and done. */
const stubTurn = async (req: TurnRequest, emit: (e: RunnerEvent) => void): Promise<void> => {
  emit({ type: 'turn.started', taskId: req.taskId, protocol: 1, runnerVersion: 'test' });
  emit({ type: 'turn.completed', taskId: req.taskId, artifacts: 1, assistantText: 'done' });
};

function turnBody(ws: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: 1,
    taskId: 'task-1',
    workspacePath: ws,
    prompt: 'Say hello.',
    provider: { kind: 'deterministic' },
    ...overrides,
  });
}

/** Poll until `predicate` holds — for the log lines the server writes just
 *  after the handler resolves, which no client-side await can observe. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/v1/turns`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('auth (SEC-001)', () => {
  it('rejects a turn with no bearer token when a token is configured', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ token: 'sekret', workspaceRoot: root }, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws));

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await res.json()).code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong bearer token', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ token: 'sekret', workspaceRoot: root }, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws), { authorization: 'Bearer not-the-token' });

    expect(res.status).toBe(401);
  });

  it('accepts the configured bearer token', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ token: 'sekret', workspaceRoot: root }, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws), { authorization: 'Bearer sekret' });

    expect(res.status).toBe(200);
  });

  it('authenticates unknown routes too, so the surface does not leak', async () => {
    const { url } = await start({ token: 'sekret' });

    expect((await fetch(`${url}/v1/secret-admin`)).status).toBe(401);
  });

  it('leaves /healthz open for probes', async () => {
    const { url } = await start({ token: 'sekret' });

    const res = await fetch(`${url}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocol: 1 });
  });

  it('runs unauthenticated when no token is configured (loopback dev mode)', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ workspaceRoot: root }, { runTurn: stubTurn });

    expect((await post(url, turnBody(ws))).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });
});

describe('request validation at the seam (SEC-002)', () => {
  it('rejects a workspacePath outside the configured root', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ workspaceRoot: path.join(root, 'task-1') }, { runTurn: stubTurn });

    const res = await post(url, turnBody(path.join(ws, '..')));

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/workspace root/);
  });

  it('refuses every turn when no containment root is configured', async () => {
    const { ws } = workspace();
    const { url } = await start({}, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws));

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('RUNNER_MISCONFIGURED');
  });

  it('rejects a provider host outside the allowlist', async () => {
    const { root, ws } = workspace();
    const { url } = await start(
      { workspaceRoot: root, allowedProviderHosts: ['models.example.com'] },
      { runTurn: stubTurn },
    );

    const res = await post(
      url,
      turnBody(ws, { provider: { kind: 'ollama', baseUrl: 'http://169.254.169.254', model: 'm' } }),
    );

    expect(res.status).toBe(400);
  });

  it('answers a protocol mismatch with 426 rather than guessing', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ workspaceRoot: root }, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws, { protocol: 99 }));

    expect(res.status).toBe(426);
    expect((await res.json()).code).toBe('PROTOCOL_MISMATCH');
  });

  it('answers malformed JSON with 400', async () => {
    const { root } = workspace();
    const { url } = await start({ workspaceRoot: root }, { runTurn: stubTurn });

    expect((await post(url, '{not json')).status).toBe(400);
  });
});

describe('correlation ids (SEC-006)', () => {
  it('echoes a well-formed caller id and stamps it on the logs', async () => {
    const { root, ws } = workspace();
    const { url, logs } = await start({ workspaceRoot: root }, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws), { 'x-request-id': 'caller-abc-123' });

    expect(res.headers.get('x-request-id')).toBe('caller-abc-123');
    const events = logs.filter((l) => l.requestId === 'caller-abc-123').map((l) => l.event);
    expect(events).toContain('request.start');
    expect(events).toContain('request.end');
  });

  it('generates an id when the caller sends none', async () => {
    const { url } = await start({});

    const res = await fetch(`${url}/healthz`);

    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never echoes a hostile id back into the headers', async () => {
    const { url } = await start({});

    const res = await fetch(`${url}/healthz`, { headers: { 'x-request-id': 'abc$(whoami) spaced' } });

    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes the id on rejected requests too', async () => {
    const { url } = await start({ token: 'sekret' });

    const res = await fetch(`${url}/v1/turns`, { method: 'POST', headers: { 'x-request-id': 'rej-1' } });

    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBe('rej-1');
  });

  it('records the outcome of every request', async () => {
    const { root, ws } = workspace();
    const { url, logs } = await start({ workspaceRoot: root }, { runTurn: stubTurn });

    await post(url, turnBody(ws));

    const end = logs.find((l) => l.event === 'request.end');
    expect(end).toMatchObject({ method: 'POST', route: '/v1/turns', status: 200, completed: true });
    expect(typeof end?.durationMs).toBe('number');
  });
});

describe('body size limit (TD-004)', () => {
  it('answers an oversized body with 413 and closes', async () => {
    const { root } = workspace();
    const { url } = await start({ workspaceRoot: root, maxBodyBytes: 256 }, { runTurn: stubTurn });

    const res = await post(url, 'x'.repeat(4096));

    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('stops consuming the stream instead of buffering the rest of the upload', async () => {
    const stream = new PassThrough();
    const promise = readBody(stream, 8);

    stream.write('0123456789abcdef');

    await expect(promise).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    // The listener is gone and the stream is paused: further bytes are not
    // read, let alone appended to a string nobody will ever look at.
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.isPaused()).toBe(true);
  });

  it('refuses a declared content-length over the limit before reading a byte', async () => {
    const stream = Object.assign(new PassThrough(), { headers: { 'content-length': '9999' } });

    await expect(readBody(stream, 8)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('reads a body under the limit, decoding multi-byte characters across chunks', async () => {
    const stream = new PassThrough();
    const promise = readBody(stream, 1024);
    const bytes = Buffer.from('héllo — ✓', 'utf8');

    stream.write(bytes.subarray(0, 2));
    stream.write(bytes.subarray(2));
    stream.end();

    await expect(promise).resolves.toBe('héllo — ✓');
  });
});

describe('turn streaming', () => {
  it('streams NDJSON events and ends with turn.completed', async () => {
    const { root, ws } = workspace();
    const { url } = await start({ workspaceRoot: root }, { runTurn: stubTurn });

    const res = await post(url, turnBody(ws));
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as RunnerEvent);

    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(lines.map((e) => e.type)).toEqual(['turn.started', 'turn.completed']);
  });

  it('hands the turn the canonical workspace path, not the caller string', async () => {
    const { root, ws } = workspace();
    let seen: TurnRequest | undefined;
    const { url } = await start(
      { workspaceRoot: root },
      {
        runTurn: async (req, emit) => {
          seen = req;
          await stubTurn(req, emit);
        },
      },
    );

    await post(url, turnBody(path.join(ws, '.', '..', 'task-1')));

    expect(seen?.workspacePath).toBe(fs.realpathSync(ws));
  });

  it('turns an executor crash into a final turn.error line', async () => {
    const { root, ws } = workspace();
    const { url } = await start(
      { workspaceRoot: root },
      {
        runTurn: (req, emit) => {
          emit({ type: 'turn.started', taskId: req.taskId, protocol: 1, runnerVersion: 'test' });
          return Promise.reject(new Error('provider exploded'));
        },
      },
    );

    const lines = (await (await post(url, turnBody(ws))).text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RunnerEvent);
    const last = lines[lines.length - 1];

    expect(last.type).toBe('turn.error');
    expect(last).toMatchObject({ code: 'RUNNER_ERROR', message: 'provider exploded' });
  });
});

describe('cancellation (COMP-004)', () => {
  it('aborts the in-flight turn when the client disconnects', async () => {
    const { root, ws } = workspace();
    let signal: AbortSignal | undefined;
    let finished!: () => void;
    const turnDone = new Promise<void>((resolve) => (finished = resolve));

    const { url, logs } = await start(
      { workspaceRoot: root },
      {
        runTurn: async (req, emit, deps) => {
          signal = deps?.signal;
          emit({ type: 'turn.started', taskId: req.taskId, protocol: 1, runnerVersion: 'test' });
          // Stands in for a long model call: resolves on abort, or after a
          // ceiling so a broken abort fails the assertion instead of hanging.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            deps?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          });
          finished();
        },
      },
    );

    const client = new AbortController();
    const res = await fetch(`${url}/v1/turns`, {
      method: 'POST',
      body: turnBody(ws),
      signal: client.signal,
    });
    // Wait for the first event so the turn is genuinely in flight.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('turn.started');

    client.abort();
    await turnDone;
    await waitFor(() => logs.some((l) => l.event === 'request.end'));

    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as Error).message).toBe('client disconnected');
    expect(logs.map((l) => l.event)).toContain('turn.cancelled');
    expect(logs.find((l) => l.event === 'request.end')).toMatchObject({ completed: false });
  }, 15_000);

  it('does not abort a turn that completes normally', async () => {
    const { root, ws } = workspace();
    let signal: AbortSignal | undefined;
    const { url } = await start(
      { workspaceRoot: root },
      {
        runTurn: async (req, emit, deps) => {
          signal = deps?.signal;
          await stubTurn(req, emit);
        },
      },
    );

    await (await post(url, turnBody(ws))).text();

    expect(signal?.aborted).toBe(false);
  });
});
