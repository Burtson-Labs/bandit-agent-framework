/**
 * Sandbox execution seam. Properties: the local backend actually runs commands
 * (stdout/exit/timeout), the factory defaults to local, and selecting the
 * not-yet-built microVM backend FAILS LOUDLY rather than silently running on
 * the host — silent degrade would defeat the entire safety purpose.
 */
import { describe, it, expect } from 'vitest';
import { LocalSandboxExecutor, AntonSandboxExecutor, createSandboxExecutor, ANTON_EXEC_CONTRACT } from '../src/sandbox';

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

  it('microvm WITHOUT anton config throws — never silently runs on the host', () => {
    expect(() => createSandboxExecutor({ mode: 'microvm' }))
      .toThrow(/requires antonBaseUrl \+ token|Refusing to fall back/);
  });

  it('microvm WITH config returns the anton client (isolation or a loud error, never host)', () => {
    const ex = createSandboxExecutor({ mode: 'microvm', antonBaseUrl: 'http://anton', token: 't' });
    expect(ex.kind).toBe('microvm');
    expect(ex).toBeInstanceOf(AntonSandboxExecutor);
  });

  it('documents the anton contract so the two-repo work has one source of truth', () => {
    expect(ANTON_EXEC_CONTRACT).toMatch(/sessions\/\{id\}\/exec/);
  });
});

describe('AntonSandboxExecutor (contract client)', () => {
  it('creates a VM, execs, and always tears the VM down', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 'vm-1' }) } as Response;
      }
      if (url.endsWith('/sessions/vm-1/exec')) {
        return { ok: true, json: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response; // DELETE
    }) as unknown as typeof fetch;

    const ex = new AntonSandboxExecutor({ baseUrl: 'http://anton', token: 't', fetchImpl });
    const r = await ex.exec('echo ok', { cwd: '/work' });
    expect(r).toMatchObject({ stdout: 'ok', exitCode: 0 });
    expect(calls).toEqual([
      'POST http://anton/sessions',
      'POST http://anton/sessions/vm-1/exec',
      'DELETE http://anton/sessions/vm-1',
    ]);
  });

  it('tears the VM down even when exec fails', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/sessions') && init?.method === 'POST') return { ok: true, json: async () => ({ id: 'vm-2' }) } as Response;
      if (url.endsWith('/exec')) return { ok: false, status: 500 } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const ex = new AntonSandboxExecutor({ baseUrl: 'http://anton', token: 't', fetchImpl });
    await expect(ex.exec('boom')).rejects.toThrow(/exec failed/);
    expect(calls).toContain('DELETE http://anton/sessions/vm-2'); // still torn down
  });
});
