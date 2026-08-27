/**
 * The crash guard's whole job is to make an unexpected error survivable for the
 * USER: terminal restored, work preserved, a clear path back. These tests drive
 * the handler directly (no real crash) and assert those three outcomes.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  installCrashGuard,
  formatCrashReport,
  formatUserMessage,
} from '../src/crashGuard';

function harness(overrides: Partial<Parameters<typeof installCrashGuard>[0]> = {}) {
  const writes: string[] = [];
  const exits: number[] = [];
  let restored = 0;
  const logs: string[] = [];
  const guard = installCrashGuard({
    restoreTerminal: () => { restored++; },
    sessionInfo: () => ({ id: '20260826-120000-abcd', path: '/home/u/.bandit/sessions/x.jsonl' }),
    writeCrashLog: (report) => { logs.push(report); return '/home/u/.bandit/crashes/crash-x.log'; },
    write: (t) => { writes.push(t); },
    exit: (code) => { exits.push(code); },
    ...overrides,
  });
  return { guard, writes, exits, logs, restored: () => restored };
}

describe('installCrashGuard', () => {
  it('restores the terminal, logs, tells the user, and exits(1)', () => {
    const h = harness();
    h.guard.handle('uncaughtException', new Error('boom'));
    expect(h.restored()).toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.exits).toEqual([1]);
    const out = h.writes.join('');
    expect(out).toContain('boom');
    // The reassurance + the exact resume command are the point.
    expect(out).toContain('--resume 20260826-120000-abcd');
    expect(out).toContain('Crash details written to');
  });

  it('restores the terminal FIRST, even if the log write throws', () => {
    let restored = false;
    const h = harness({
      restoreTerminal: () => { restored = true; },
      writeCrashLog: () => { throw new Error('disk full'); },
    });
    expect(() => h.guard.handle('uncaughtException', new Error('x'))).not.toThrow();
    expect(restored).toBe(true);
    // A failed log still exits cleanly and tells the user what happened.
    expect(h.exits).toEqual([1]);
    expect(h.writes.join('')).toContain('Could not write a crash log');
  });

  it('is re-entrant-safe — a second crash mid-handling is ignored', () => {
    const h = harness({
      // Simulate the restore itself throwing, which must not recurse.
      restoreTerminal: () => { throw new Error('terminal gone'); },
    });
    expect(() => h.guard.handle('uncaughtException', new Error('first'))).not.toThrow();
    expect(h.exits).toEqual([1]);
  });

  it('handles an early crash with no session yet', () => {
    const h = harness({ sessionInfo: () => null });
    h.guard.handle('unhandledRejection', new Error('startup failed'));
    const out = h.writes.join('');
    expect(out).not.toContain('--resume');
    expect(h.exits).toEqual([1]);
  });

  it('registers and unregisters process listeners', () => {
    const before = process.listenerCount('uncaughtException');
    const h = harness();
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    h.guard.uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});

describe('formatCrashReport', () => {
  it('captures origin, session, message, and stack', () => {
    const report = formatCrashReport('uncaughtException', new Error('kaboom'), 'sess-1', '2026-08-26T00:00:00Z');
    expect(report).toContain('origin:  uncaughtException');
    expect(report).toContain('session: sess-1');
    expect(report).toContain('kaboom');
    expect(report).toContain('stack:');
  });

  it('handles a non-Error throw', () => {
    const report = formatCrashReport('unhandledRejection', 'a string', null, '2026-08-26T00:00:00Z');
    expect(report).toContain('a string');
    expect(report).toContain('session: (none)');
  });
});

describe('formatUserMessage', () => {
  it('leads with the reassurance when a session exists', () => {
    const msg = formatUserMessage(new Error('x'), { id: 'abc', path: '/p' }, '/log', (t) => t);
    expect(msg).toContain('Your conversation is saved');
    expect(msg).toContain('bandit --resume abc');
  });
});
