/**
 * The runner's HTTP surface. Two endpoints, nothing clever:
 *
 *   GET  /healthz    — liveness + protocol version, for the gateway and k8s
 *   POST /v1/turns   — TurnRequest in, NDJSON RunnerEvents out
 *
 * The stream contract the gateway relies on: `turn.completed` or
 * `turn.error` is ALWAYS the final line. A connection that closes without
 * one means the runner died mid-turn, and the caller must fail the task —
 * never mark it completed. That rule is what makes "completed but did
 * nothing" impossible to reintroduce at this seam.
 *
 * Security boundary (SEC-001): when `AGENT_RUNNER_TOKEN` is set, every
 * request except `GET /healthz` must carry `Authorization: Bearer <token>`
 * or it gets a 401 — including unknown routes, so nothing about the surface
 * leaks unauthenticated. Without a token the runner is a dev instance and
 * `loadRunnerConfig` has already forced the bind to loopback (a non-loopback
 * bind without a token refuses to start). `/healthz` stays unauthenticated
 * on purpose: k8s probes and the image HEALTHCHECK hit it without headers,
 * and it exposes nothing beyond liveness and the protocol version.
 */
import * as http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ContractError, PROTOCOL_VERSION, parseTurnRequest } from './contract.js';
import { runTurn } from './turn.js';
import { loadRunnerConfig, type RunnerConfig } from './config.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) reject(new ContractError('BAD_REQUEST', 'body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Constant-time bearer comparison. Both sides are hashed first so a length
 * mismatch can't short-circuit `timingSafeEqual` (which requires equal-size
 * buffers) into a measurable early exit.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

export function createRunnerServer(config: RunnerConfig): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
        return;
      }

      if (config.token && !bearerMatches(req.headers.authorization, config.token)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/turns') {
        let turn;
        try {
          turn = parseTurnRequest(JSON.parse(await readBody(req)));
        } catch (err) {
          const ce = err instanceof ContractError ? err : new ContractError('BAD_REQUEST', String(err));
          res.writeHead(ce.code === 'PROTOCOL_MISMATCH' ? 426 : 400, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({ code: ce.code, message: ce.message }));
          return;
        }

        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-cache',
        });
        const emit = (e: unknown) => res.write(JSON.stringify(e) + '\n');
        try {
          await runTurn(turn, emit);
        } catch (err) {
          emit({
            type: 'turn.error',
            taskId: turn.taskId,
            code: 'RUNNER_ERROR',
            message: String(err instanceof Error ? err.message : err),
          });
        }
        res.end();
        return;
      }

      res.writeHead(404).end();
    })().catch(() => res.destroy());
  });
}

/* Bootstrap — only when executed directly (`node dist/server.js`), so tests
 * can import `createRunnerServer` without a listener side effect. */
if (require.main === module) {
  let config: RunnerConfig;
  try {
    config = loadRunnerConfig();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[agent-runner] refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const server = createRunnerServer(config);
  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[agent-runner] listening on ${config.host}:${config.port} (protocol v${PROTOCOL_VERSION}) — ` +
        (config.token
          ? 'bearer auth enabled'
          : 'NO AGENT_RUNNER_TOKEN: unauthenticated dev mode, loopback bind only'),
    );
  });
}
