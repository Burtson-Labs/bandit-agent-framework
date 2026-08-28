/**
 * Plan mode — the read-only ceiling. The boundary must be crisp and enforced
 * in the ONE place both hosts share (decidePermission), so the CLI and the
 * extension can't drift. These pin: what plan mode lets through (reads +
 * read-only shell), what it blocks (every mutation — DENIED, never prompted,
 * even when a policy allowlist or the risk tier would otherwise pass it), and
 * the shift+tab cycle order.
 */
import { describe, it, expect } from 'vitest';
import { classifyRisk } from '../src/riskTiers';
import {
  decidePermission,
  shouldAutoApprove,
  nextCycleMode,
  CYCLE_MODES,
  isPermissionMode,
  resolvePermissionMode,
  type PermissionMode
} from '../src/permissionMode';

const risk = (name: string, params: Record<string, string> = {}) =>
  classifyRisk({ name, params }, { workspaceRoot: '/repo', homeDir: '/home/u' });
const cmd = (c: string) => ({ cmd: c });

/** Decide a plan-mode call whose policy said `ask` (the default for anything
 *  not explicitly allowlisted). */
const plan = (name: string, params: Record<string, string> = {}, policy: 'allow' | 'ask' | 'deny' = 'ask') =>
  decidePermission({ mode: 'plan', risk: risk(name, params), policyDecision: policy });

describe('plan mode — reads and read-only shell are allowed', () => {
  it('allows read-only tools', () => {
    for (const name of ['read_file', 'list_files', 'search_code', 'find_directory', 'read_memory']) {
      expect(plan(name, { path: 'src/x.ts' }).action, name).toBe('allow');
    }
  });

  it('allows read-only shell commands', () => {
    for (const c of ['ls -la', 'cat README.md', 'grep -r foo src', 'git status', 'git diff', 'git log --oneline', 'wc -l x', 'pwd']) {
      expect(plan('run_command', cmd(c)).action, c).toBe('allow');
    }
  });

  it('allows read-only MCP calls (getX / listX / searchX)', () => {
    expect(plan('gmail.listMessages').action).toBe('allow');
    expect(plan('drive.searchFiles').action).toBe('allow');
  });
});

describe('plan mode — every mutation is DENIED, not prompted', () => {
  it('denies edits and writes even though they are routine/elevated tier', () => {
    expect(plan('apply_edit', { path: 'src/x.ts' }).action).toBe('deny');   // routine tier, but not read-only
    expect(plan('write_file', { path: 'src/new.ts' }).action).toBe('deny');
    expect(plan('apply_patch', {}).action).toBe('deny');
    expect(plan('delete_file', { path: 'src/x.ts' }).action).toBe('deny');
  });

  it('denies mutating and build/test shell commands', () => {
    for (const c of ['npm install', 'git commit -m x', 'git push', 'vitest run', 'tsc --build', 'rm -rf build']) {
      expect(plan('run_command', cmd(c)).action, c).toBe('deny');
    }
  });

  it('denies a mutating call the policy explicitly ALLOWED — the ceiling wins over an allowlist', () => {
    const out = plan('write_file', { path: 'src/x.ts' }, 'allow');
    expect(out.action).toBe('deny');
  });

  it('denies a critical call outright (stronger than the ask-floor)', () => {
    const out = plan('run_command', cmd('git push --force'));
    expect(out.action).toBe('deny'); // NOT 'ask' — plan mode is a harder boundary than the critical floor
  });

  it('still honors an explicit policy deny', () => {
    expect(plan('read_file', { path: 'x' }, 'deny').action).toBe('deny');
  });

  it('deny reason tells the model to present a plan', () => {
    const out = plan('write_file', { path: 'src/x.ts' });
    expect(out.reason).toMatch(/plan/i);
    expect(out.reason).toMatch(/read-only|present your plan/i);
  });
});

describe('plan mode — shouldAutoApprove mirrors the boundary', () => {
  it('auto-approves reads, refuses mutations', () => {
    expect(shouldAutoApprove('plan', risk('read_file', { path: 'x' })).autoApprove).toBe(true);
    expect(shouldAutoApprove('plan', risk('write_file', { path: 'x' })).autoApprove).toBe(false);
    expect(shouldAutoApprove('plan', risk('run_command', cmd('vitest'))).autoApprove).toBe(false);
  });
});

describe('shift+tab cycle', () => {
  it('rotates ask → auto → plan → ask and excludes dangerous', () => {
    expect(nextCycleMode('ask')).toBe('auto');
    expect(nextCycleMode('auto')).toBe('plan');
    expect(nextCycleMode('plan')).toBe('ask');
    expect(CYCLE_MODES).not.toContain('dangerous');
  });

  it('a non-cycle mode (dangerous) lands back at the cycle start', () => {
    expect(nextCycleMode('dangerous')).toBe(CYCLE_MODES[0]);
  });
});

describe('plan mode — resolution', () => {
  it('is a valid mode from env and settings', () => {
    expect(isPermissionMode('plan')).toBe(true);
    expect(resolvePermissionMode({ env: { BANDIT_PERMISSION_MODE: 'plan' } }).mode).toBe('plan');
    expect(resolvePermissionMode({ settingsMode: 'plan' }).mode).toBe('plan');
  });

  it('override wins', () => {
    const modes: PermissionMode[] = ['plan', 'ask', 'auto', 'dangerous'];
    for (const m of modes) expect(resolvePermissionMode({ override: m }).mode).toBe(m);
  });
});
