/**
 * The remote-runner safety gate. Remote control drives the agent on the user's
 * real machine with nobody at the keyboard, so the gate must never let a
 * mutating call through unattended. It reuses host-kit's decidePermission, so
 * these lock the runner-specific translation: allow → run, deny → block with
 * reason, ask → block (can't prompt remotely).
 */
import { describe, it, expect } from 'vitest';
import { createPlanModeGate } from '../src/runner/planModeGate';

const ROOT = '/repo';
const call = (name: string, params: Record<string, string> = {}) => ({ name, params });

describe('createPlanModeGate — plan mode (read-only)', () => {
  const gate = createPlanModeGate('plan', ROOT);

  it('allows read-only tools and read-only shell', () => {
    expect(gate(call('read_file', { path: 'a.ts' })).allow).toBe(true);
    expect(gate(call('search_code', { pattern: 'foo' })).allow).toBe(true);
    expect(gate(call('run_command', { cmd: 'git diff' })).allow).toBe(true);
    expect(gate(call('run_command', { cmd: 'ls -la' })).allow).toBe(true);
  });

  it('blocks every mutation with a reason the model can act on', () => {
    for (const c of [
      call('apply_edit', { path: 'a.ts' }),
      call('write_file', { path: 'a.ts' }),
      call('delete_file', { path: 'a.ts' }),
      call('run_command', { cmd: 'npm install' }),
      call('run_command', { cmd: 'git commit -m x' })
    ]) {
      const r = gate(c);
      expect(r.allow, c.name + ' ' + (c.params.cmd ?? '')).toBe(false);
      expect(r.reason && r.reason.length, c.name).toBeGreaterThan(0);
    }
  });
});

describe('createPlanModeGate — auto mode', () => {
  const gate = createPlanModeGate('auto', ROOT);

  it('allows routine in-workspace edits', () => {
    expect(gate(call('apply_edit', { path: 'a.ts' })).allow).toBe(true);
    expect(gate(call('replace_range', { path: 'a.ts' })).allow).toBe(true);
  });

  it('still blocks destructive / non-routine calls (no human to approve the floor)', () => {
    expect(gate(call('delete_file', { path: 'a.ts' })).allow).toBe(false);
    expect(gate(call('run_command', { cmd: 'git push --force' })).allow).toBe(false);
    expect(gate(call('write_file', { path: 'a.ts' })).allow).toBe(false); // elevated → ask → blocked remotely
  });

  it('the ask-blocked reason tells the model to describe instead of retry', () => {
    const r = gate(call('write_file', { path: 'a.ts' }));
    expect(r.reason).toMatch(/nobody is at this machine|describe what you would/i);
  });
});
