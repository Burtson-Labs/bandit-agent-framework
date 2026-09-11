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
 *
 * Observability (SEC-006): every request gets a correlation id — the
 * caller's `X-Request-Id` when it is well-formed, a fresh uuid otherwise —
 * which is echoed on the response and stamped on every log line the request
 * produces. Logs are single-line JSON via `logger.ts`; there is no
 * `console.log` on the request path.
 */
import * as http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ContractError, PROTOCOL_VERSION, parseTurnRequest } from './contract.js';
import { runTurn } from './turn.js';
import { loadRunnerConfig, type RunnerConfig } from './config.js';
import { createLogger, REQUEST_ID_HEADER, resolveRequestId, type Logger } from './logger.js';
import { resolveWorkspacePath, validateProvider } from './policy.js';

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

export interface RunnerServerDeps {
  /** Structured logger (SEC-006). Defaults to one built from the config. */
  logger?: Logger;
}

export function createRunnerServer(config: RunnerConfig, deps: RunnerServerDeps = {}): http.Server {
  const baseLogger = deps.logger ?? createLogger({ level: config.logLevel });
  return http.createServer((req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? 'GET';
    const route = (req.url ?? '/').split('?')[0];
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    const log = baseLogger.child({ requestId });
    // Set before any branch so EVERY response carries it — 401 and 404
    // included. A caller can quote the id in a report before it has a body.
    res.setHeader(REQUEST_ID_HEADER, requestId);
    // Liveness probes fire every few seconds forever; they are debug-level
    // so the info stream stays readable.
    const level = method === 'GET' && route === '/healthz' ? 'debug' : 'info';
    log[level]('request.start', { method, route });
    res.on('close', () =>
      log[level]('request.end', {
        method,
        route,
        status: res.statusCode,
        // false = the connection died before the response finished, which
        // for /v1/turns means the NDJSON stream was cut mid-turn.
        completed: res.writableFinished,
        durationMs: Date.now() - startedAt,
      }),
    );

    void (async () => {
      if (method === 'GET' && route === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
        return;
      }

      if (config.token && !bearerMatches(req.headers.authorization, config.token)) {
        log.warn('request.unauthorized', { method, route });
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' }));
        return;
      }

      if (method === 'POST' && route === '/v1/turns') {
        let turn;
        try {
          turn = parseTurnRequest(JSON.parse(await readBody(req)));
          // SEC-002: constrain the two caller-controlled reach-out values,
          // and hand the turn the CANONICAL workspace path so the jail root
          // is the realpath the containment check approved.
          validateProvider(turn.provider, config.allowedProviderHosts);
          turn = { ...turn, workspacePath: resolveWorkspacePath(turn.workspacePath, config.workspaceRoot) };
        } catch (err) {
          const ce = err instanceof ContractError ? err : new ContractError('BAD_REQUEST', String(err));
          const status =
            ce.code === 'PROTOCOL_MISMATCH' ? 426 : ce.code === 'RUNNER_MISCONFIGURED' ? 500 : 400;
          log.warn('request.rejected', { code: ce.code, status, message: ce.message });
          res.writeHead(status, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({ code: ce.code, message: ce.message }));
          return;
        }

        log.info('turn.accepted', { taskId: turn.taskId, provider: turn.provider.kind });
        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-cache',
        });
        const emit = (e: unknown) => res.write(JSON.stringify(e) + '\n');
        try {
          await runTurn(turn, emit, { permissionMode: config.permissionMode });
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err);
          log.error('turn.failed', { taskId: turn.taskId, message });
          emit({
            type: 'turn.error',
            taskId: turn.taskId,
            code: 'RUNNER_ERROR',
            message,
          });
        }
        res.end();
        return;
      }

      log.warn('request.not_found', { method, route });
      res.writeHead(404).end();
    })().catch((err: unknown) => {
      log.error('request.crashed', { message: String(err instanceof Error ? err.message : err) });
      res.destroy();
    });
  });
}

/* Bootstrap — only when executed directly (`node dist/server.js`), so tests
 * can import `createRunnerServer` without a listener side effect. */
if (require.main === module) {
  let config: RunnerConfig;
  try {
    config = loadRunnerConfig();
  } catch (err) {
    // No config yet, so no configured level — start-up refusals are always
    // reported, on stderr, in the same JSON shape as everything else.
    createLogger().error('server.start_refused', {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
  const logger = createLogger({ level: config.logLevel });
  const server = createRunnerServer(config, { logger });
  server.listen(config.port, config.host, () => {
    logger.info('server.listening', {
      host: config.host,
      port: config.port,
      protocol: PROTOCOL_VERSION,
      auth: config.token ? 'bearer' : 'none',
      permissionMode: config.permissionMode,
      // Loud, because an unauthenticated runner is only ever acceptable on
      // loopback and someone reading the logs should see that spelled out.
      ...(config.token ? {} : { warning: 'AGENT_RUNNER_TOKEN unset: unauthenticated dev mode, loopback bind only' }),
    });
  });
}
