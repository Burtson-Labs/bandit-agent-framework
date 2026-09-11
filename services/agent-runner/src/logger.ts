/**
 * The runner's logging seam (SEC-006) — one module, one line format, no
 * `console.log` scattered through the request path.
 *
 * Every line is a single JSON object so a collector can parse it without a
 * grok pattern, and the key order is fixed on purpose:
 *
 *   {"ts":"…","level":"info","requestId":"…","event":"request.start", …}
 *
 * `event` is a stable dotted name (`request.start`, `turn.failed`), never a
 * prose sentence — logs are queried, not read like a story. Everything
 * situational goes in the trailing fields.
 *
 * Correlation: `resolveRequestId` accepts the caller's `X-Request-Id` when
 * it is well-formed and mints one otherwise, so a turn can be followed from
 * whatever sits in front of the runner all the way into this service's
 * logs. The value is echoed back on the response (see `server.ts`), which is
 * also why the accepted charset is strict: an id that reaches a response
 * header must never be able to carry CR/LF or other header syntax.
 *
 * Deliberately dependency-free. A logging library here would be the only
 * runtime dependency of the service that is not part of the framework, and
 * it would buy nothing this file does not already do.
 */
import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogLevelSetting = LogLevel | 'silent';

const RANK: Record<LogLevelSetting, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Derive a logger with fields pinned on every line (e.g. `requestId`). */
  child(bound: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. `silent` drops everything. Default `info`. */
  level?: LogLevelSetting;
  /** Where lines go. Default: stdout for debug/info, stderr for warn/error. */
  sink?: (line: string, level: LogLevel) => void;
  /** Clock seam so tests can pin `ts`. */
  now?: () => Date;
  /** Fields merged into every line (see `child`). */
  bound?: LogFields;
}

export function parseLogLevel(raw: string | undefined): LogLevelSetting {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'info';
  if (v in RANK) return v as LogLevelSetting;
  throw new Error(
    `invalid AGENT_RUNNER_LOG_LEVEL '${raw}' — expected debug | info | warn | error | silent`,
  );
}

function defaultSink(line: string, level: LogLevel): void {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = RANK[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const bound = options.bound ?? {};

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (RANK[level] < min) return;
    const merged = { ...bound, ...(fields ?? {}) } as LogFields;
    // requestId is hoisted so the correlation key is always in the same
    // position, whether it arrived bound or per-call.
    const { requestId, ...rest } = merged;
    const record: LogFields = { ts: now().toISOString(), level };
    if (requestId !== undefined) record.requestId = requestId;
    record.event = event;
    Object.assign(record, rest);
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // A field that cannot be serialized must never take down a request.
      line = JSON.stringify({ ts: now().toISOString(), level, event, logError: 'unserializable fields' });
    }
    sink(line, level);
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (extra) => createLogger({ ...options, bound: { ...bound, ...extra } }),
  };
}

/** The header the runner reads and echoes for correlation. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Printable, header-safe, bounded. Anything else (CR/LF, spaces, 200-char
 * ids, arrays from a duplicated header) is discarded in favour of a fresh
 * uuid — the runner still gets a correlation id, it just refuses to echo an
 * attacker-chosen string into its own response headers.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:+/=@-]{1,128}$/;

export function resolveRequestId(raw: string | string[] | undefined): string {
  const candidate = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}
