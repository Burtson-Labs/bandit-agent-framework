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
 */
import * as http from 'node:http';
import { ContractError, PROTOCOL_VERSION, parseTurnRequest } from './contract.js';
import { runTurn } from './turn.js';

const PORT = Number(process.env.PORT ?? 8790);

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

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
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

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[agent-runner] listening on :${PORT} (protocol v${PROTOCOL_VERSION})`);
});
