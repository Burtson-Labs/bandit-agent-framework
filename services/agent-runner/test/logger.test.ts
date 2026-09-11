/**
 * Logger + correlation id (SEC-006).
 *
 * What is pinned here is the shape, not the prose: one JSON object per
 * line, `ts`/`level`/`requestId`/`event` first, and a request id that is
 * safe to echo into a response header. The last one is the security-
 * relevant bit — the id comes from the caller, so a value carrying CRLF
 * would be a header-injection primitive if it were echoed verbatim.
 */
import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel, resolveRequestId } from '../src/logger';

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe('createLogger', () => {
  it('emits one JSON line per call with ts, level, event', () => {
    const { lines, sink } = capture();
    createLogger({ sink, now: () => new Date('2026-01-01T00:00:00.000Z') }).info('request.start', {
      method: 'POST',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0])).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'request.start',
      method: 'POST',
    });
  });

  it('puts requestId ahead of event so the correlation key is always in the same place', () => {
    const { lines, sink } = capture();
    createLogger({ sink }).child({ requestId: 'req-1' }).warn('request.rejected', { code: 'BAD_REQUEST' });

    expect(Object.keys(JSON.parse(lines[0]))).toEqual(['ts', 'level', 'requestId', 'event', 'code']);
  });

  it('binds child fields onto every line and lets per-call fields win', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink }).child({ requestId: 'req-1', service: 'runner' });
    log.info('a');
    log.info('b', { service: 'override' });

    expect(JSON.parse(lines[0]).requestId).toBe('req-1');
    expect(JSON.parse(lines[0]).service).toBe('runner');
    expect(JSON.parse(lines[1]).service).toBe('override');
  });

  it('drops anything below the configured level, and everything when silent', () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(['w', 'e']);

    const quiet = capture();
    createLogger({ sink: quiet.sink, level: 'silent' }).error('boom');
    expect(quiet.lines).toEqual([]);
  });

  it('never throws on unserializable fields', () => {
    const { lines, sink } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => createLogger({ sink }).info('weird', { circular })).not.toThrow();
    expect(JSON.parse(lines[0]).logError).toBe('unserializable fields');
  });
});

describe('parseLogLevel', () => {
  it('defaults to info and accepts the documented levels', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('silent')).toBe('silent');
  });

  it('refuses an unknown level instead of silently logging everything', () => {
    expect(() => parseLogLevel('verbose')).toThrow(/AGENT_RUNNER_LOG_LEVEL/);
  });
});

describe('resolveRequestId', () => {
  it('accepts a well-formed caller id', () => {
    expect(resolveRequestId('7f3b1c2a-0000-4000-8000-abcdefabcdef')).toBe(
      '7f3b1c2a-0000-4000-8000-abcdefabcdef',
    );
    expect(resolveRequestId('  trace:abc-123  ')).toBe('trace:abc-123');
  });

  it('generates one when the header is absent', () => {
    const id = resolveRequestId(undefined);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId(undefined)).not.toBe(id);
  });

  it('refuses header-injection and oversized ids', () => {
    for (const hostile of [
      'abc\r\nX-Injected: yes',
      'abc\nSet-Cookie: a=b',
      'has spaces',
      'x'.repeat(129),
      '<script>',
      '',
    ]) {
      expect(resolveRequestId(hostile)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('ignores a duplicated header rather than joining it', () => {
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });
});
