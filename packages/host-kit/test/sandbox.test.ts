/**
 * Sandbox execution seam. Properties: the local backend actually runs commands
 * (stdout/exit/timeout), the factory defaults to local, and selecting the
 * not-yet-built microVM backend FAILS LOUDLY rather than silently running on
 * the host — silent degrade would defeat the entire safety purpose.
 */
import { describe, it, expect } from 'vitest';
import { LocalSandboxExecutor, createSandboxExecutor, ANTON_EXEC_CONTRACT } from '../src/sandbox';

describe('LocalSandboxExecutor', () => {
  it('runs a command and captures stdout + exit code', async () => {
    const r = await new LocalSandboxExecutor().exec('echo hello');
    expect(r.stdout.trim()).toBe('hello');
    expect(r.exitCode).toBe(0);
    expect(r.kind ?? 'local').toBeDefined();
  });

  it('reports a non-zero exit code', async () => {
    const r = await new LocalSandboxExecutor().exec('exit 3');
    expect(r.exitCode).toBe(3);
  });

  it('honors cwd', async () => {
    const r = await new LocalSandboxExecutor().exec('pwd', { cwd: '/tmp' });
    expect(r.stdout).toMatch(/tmp/);
  });

  it('kills at timeoutMs and flags timedOut', async () => {
    const r = await new LocalSandboxExecutor().exec('sleep 5', { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });
});

describe('createSandboxExecutor', () => {
  it('defaults to the local backend', () => {
    expect(createSandboxExecutor().kind).toBe('local');
    expect(createSandboxExecutor({ mode: 'local' }).kind).toBe('local');
  });

  it('FAILS LOUDLY on microvm until anton exec exists (never silently local)', () => {
    expect(() => createSandboxExecutor({ mode: 'microvm', antonBaseUrl: 'http://anton' }))
      .toThrow(/not available yet|anton needs the exec endpoint/);
  });

  it('documents the anton contract so the two-repo work has one source of truth', () => {
    expect(ANTON_EXEC_CONTRACT).toMatch(/sessions\/\{id\}\/exec/);
  });
});
