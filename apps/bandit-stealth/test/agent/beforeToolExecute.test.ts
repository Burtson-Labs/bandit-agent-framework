/**
 * Contract tests for `buildBeforeToolExecute` — the per-call permission
 * gate extracted out of performToolUseCompletion in Phase E.
 *
 * These pin the load-bearing behaviors the extraction was meant to
 * preserve: hook denial, policy deny, the four card-resolution branches
 * (once / session / save / deny), turn-local auto-grant dedup, inflight
 * promise sharing for parallel duplicate calls, and the
 * `agent.autoApproveEdits` config bypass. A regression in any of these
 * is a user-visible UX bug (duplicate prompts, missed denials, the deny-
 * with-notes phrasing the model relies on to NOT retry the same call),
 * not a refactor miss.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';
import { TurnState } from '../../src/agent/turnState';

const vscodeMock = vi.hoisted(() => ({
  autoApproveEdits: false as boolean
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === 'agent.autoApproveEdits') return vscodeMock.autoApproveEdits as unknown as T;
        return defaultValue;
      }
    })
  }
}));

const hostKitMock = vi.hoisted(() => ({
  runHooks: vi.fn<(...args: unknown[]) => Promise<Array<{ exitCode: number; stderr: string; stdout: string }>>>(
    async () => []
  ),
  evaluatePermission: vi.fn<(...args: unknown[]) => 'allow' | 'ask' | 'deny'>(() => 'allow'),
  mergePolicies: vi.fn((a: unknown, _b: unknown) => a),
  persistAllowEntry: vi.fn(async () => undefined),
  previewText: (s: string) => s
}));

vi.mock('@burtson-labs/host-kit', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    runHooks: hostKitMock.runHooks,
    evaluatePermission: hostKitMock.evaluatePermission,
    mergePolicies: hostKitMock.mergePolicies,
    persistAllowEntry: hostKitMock.persistAllowEntry,
    previewText: hostKitMock.previewText,
    SessionPermissionStore: class FakeStore {
      private allow = new Set<string>();
      grant(name: string, primary?: string) { this.allow.add(primary ? `${name}:${primary}` : name); }
      toPolicy() { return { allow: [...this.allow], deny: [], ask: [] }; }
    }
  };
});

import { SessionPermissionStore, type HookSettings } from '@burtson-labs/host-kit';
import { buildBeforeToolExecute, type BeforeToolExecuteDeps } from '../../src/agent/beforeToolExecute';
import type { PermissionGateService } from '../../src/provider/services/permissionGateService';

interface FakeGate {
  service: PermissionGateService;
  resolveNext: (choice: 'once' | 'session' | 'save' | 'deny', notes?: string) => Promise<void>;
  callCount: () => number;
  pendingCount: () => number;
  waitForPending: () => Promise<void>;
}

function makeFakeGate(): FakeGate {
  const resolvers: Array<(v: { choice: 'once' | 'session' | 'save' | 'deny'; notes?: string }) => void> = [];
  let calls = 0;
  const service = {
    request: () => {
      calls += 1;
      return new Promise<{ choice: 'once' | 'session' | 'save' | 'deny'; notes?: string }>((resolve) => {
        resolvers.push(resolve);
      });
    }
  } as unknown as PermissionGateService;
  const waitForPending = async () => {
    // beforeToolExecute reaches `permissionGate.request()` only after a
    // chain of awaits (runHooks → mergePolicies → turnLog.append →
    // notifyUser). Flush the microtask queue until a resolver lands or
    // we time out — both paths surface a clean failure message.
    for (let i = 0; i < 50 && resolvers.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    if (resolvers.length === 0) throw new Error('no pending permission request to resolve after wait');
  };
  return {
    service,
    resolveNext: async (choice, notes) => {
      await waitForPending();
      const r = resolvers.shift()!;
      r({ choice, notes });
    },
    callCount: () => calls,
    pendingCount: () => resolvers.length,
    waitForPending
  };
}

function makeEntry(): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content: '', timestamp: 0, payload: '' };
}

function makeTurnLog() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    log: {
      filePath: '/tmp/turn.jsonl',
      append: async (entry: Record<string, unknown>) => { entries.push(entry); }
    } as unknown as BeforeToolExecuteDeps['turnLog'],
    entries
  };
}

function makeDeps(overrides: Partial<BeforeToolExecuteDeps> = {}): BeforeToolExecuteDeps {
  const gate = makeFakeGate();
  return {
    state: new TurnState(makeEntry()),
    assistantEntry: makeEntry(),
    permissionGate: gate.service,
    permissionStore: new SessionPermissionStore(),
    hookSettings: { permissions: { allow: [], deny: [], ask: [] } } as unknown as HookSettings,
    workspaceRoot: '/tmp/ws',
    userGoal: 'do the thing',
    turnLog: null,
    notifyUser: vi.fn(),
    ...overrides
  };
}

beforeEach(() => {
  vscodeMock.autoApproveEdits = false;
  hostKitMock.runHooks.mockReset();
  hostKitMock.runHooks.mockResolvedValue([]);
  hostKitMock.evaluatePermission.mockReset();
  hostKitMock.evaluatePermission.mockReturnValue('allow');
  hostKitMock.mergePolicies.mockClear();
  hostKitMock.persistAllowEntry.mockClear();
});

describe('buildBeforeToolExecute', () => {
  it('denies when a PreToolUse hook exits non-zero, with the hook stderr as the reason', async () => {
    const { log, entries } = makeTurnLog();
    hostKitMock.runHooks.mockResolvedValueOnce([{ exitCode: 1, stderr: 'blocked by policy script', stdout: '' }]);
    const before = buildBeforeToolExecute(makeDeps({ turnLog: log }));

    const result = await before({ name: 'run_command', params: { cmd: 'rm', args: '-rf /' } });

    expect(result).toEqual({ allow: false, reason: 'blocked by policy script' });
    expect(entries[0]).toMatchObject({ type: 'permission-denied', source: 'hook', name: 'run_command' });
  });

  it('denies when policy returns "deny" without ever opening a card', async () => {
    const { log, entries } = makeTurnLog();
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValueOnce('deny');
    const before = buildBeforeToolExecute(makeDeps({ turnLog: log, permissionGate: gate.service }));

    const result = await before({ name: 'write_file', params: { path: 'foo.ts', content: 'x' } });

    expect(result).toMatchObject({ allow: false });
    expect((result as { reason: string }).reason).toContain('denied by permission policy');
    expect(gate.callCount()).toBe(0);
    expect(entries[0]).toMatchObject({ type: 'permission-denied', source: 'policy' });
  });

  it('on "ask" → user picks "once": allows, sets toolStartedAt, logs the decision', async () => {
    const { log, entries } = makeTurnLog();
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const deps = makeDeps({ turnLog: log, permissionGate: gate.service });
    const before = buildBeforeToolExecute(deps);

    const pending = before({ name: 'write_file', params: { path: 'foo.ts', content: 'x' } });
    await gate.resolveNext('once');
    const result = await pending;

    expect(result).toEqual({ allow: true });
    expect(deps.state.toolStartedAt.get('write_file')).toBeTypeOf('number');
    expect(entries.some((e) => e.type === 'permission-decision' && e.choice === 'once')).toBe(true);
  });

  it('on "ask" → "session": grants the tool name in the session store', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const deps = makeDeps({ permissionGate: gate.service });
    const grantSpy = vi.spyOn(deps.permissionStore, 'grant');
    const before = buildBeforeToolExecute(deps);

    const pending = before({ name: 'run_command', params: { cmd: 'git', args: 'status' } });
    await gate.resolveNext('session');
    await pending;

    expect(grantSpy).toHaveBeenCalledWith('run_command');
    expect(grantSpy).toHaveBeenCalledTimes(1);
  });

  it('on "ask" → "save": grants tool+primary AND persists the allow entry to disk', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const deps = makeDeps({ permissionGate: gate.service, workspaceRoot: '/tmp/ws' });
    const grantSpy = vi.spyOn(deps.permissionStore, 'grant');
    const before = buildBeforeToolExecute(deps);

    const pending = before({ name: 'write_file', params: { path: 'foo.ts', content: 'x' } });
    await gate.resolveNext('save');
    await pending;
    // persistAllowEntry is fire-and-forget — flush the microtask queue.
    await new Promise((r) => setImmediate(r));

    expect(grantSpy).toHaveBeenCalledWith('write_file', 'foo.ts');
    expect(hostKitMock.persistAllowEntry).toHaveBeenCalledWith('/tmp/ws', 'write_file:foo.ts');
  });

  it('on "ask" → "deny" with notes: builds a guidance-aware reason that tells the model NOT to retry', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const before = buildBeforeToolExecute(makeDeps({ permissionGate: gate.service }));

    const pending = before({ name: 'run_command', params: { cmd: 'rm', args: '-rf node_modules' } });
    await gate.resolveNext('deny', 'use git clean instead');
    const result = await pending;

    expect(result.allow).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('use git clean instead');
    expect(reason).toContain('Do not retry this tool call with the same arguments');
    expect(reason).toContain('adjust your plan based on the user\'s guidance');
  });

  it('after "once", a second call for the same (tool, primary) skips the gate (turn-local auto-grant)', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const before = buildBeforeToolExecute(makeDeps({ permissionGate: gate.service }));

    const first = before({ name: 'apply_edit', params: { path: 'a.ts' } });
    await gate.resolveNext('once');
    await first;
    const second = await before({ name: 'apply_edit', params: { path: 'a.ts' } });

    expect(second).toEqual({ allow: true });
    expect(gate.callCount()).toBe(1); // only the first call opened a card
  });

  it('two parallel calls for the same (tool, primary) share one card (inflight dedup)', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const before = buildBeforeToolExecute(makeDeps({ permissionGate: gate.service }));

    const first = before({ name: 'apply_edit', params: { path: 'a.ts' } });
    // Let the first call populate the inflight map before we kick off
    // the second — production calls are serialized through agent-core's
    // for-await loop, so this mirrors the real path (the test isn't
    // probing a hypothetical truly-parallel race).
    await gate.waitForPending();
    const second = before({ name: 'apply_edit', params: { path: 'a.ts' } });
    // Flush microtasks so `second` reaches the inflight check + awaits
    // the shared promise rather than racing past it.
    await new Promise((r) => setImmediate(r));

    expect(gate.callCount()).toBe(1);

    await gate.resolveNext('once');
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ allow: true });
    expect(r2).toEqual({ allow: true });
    expect(gate.pendingCount()).toBe(0);
  });

  it('when agent.autoApproveEdits is on, edit tools bypass the card but run_command does not', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    vscodeMock.autoApproveEdits = true;
    const before = buildBeforeToolExecute(makeDeps({ permissionGate: gate.service }));

    const editResult = await before({ name: 'write_file', params: { path: 'foo.ts', content: 'x' } });
    expect(editResult).toEqual({ allow: true });
    expect(gate.callCount()).toBe(0);

    // run_command still requires an explicit choice.
    const runPending = before({ name: 'run_command', params: { cmd: 'ls' } });
    await gate.waitForPending();
    expect(gate.callCount()).toBe(1);
    await gate.resolveNext('once');
    await runPending;
  });

  it('allow path sets state.toolStartedAt on every branch (auto-grant, autoApprove, post-card)', async () => {
    const gate = makeFakeGate();
    hostKitMock.evaluatePermission.mockReturnValue('ask');
    const deps = makeDeps({ permissionGate: gate.service });
    const before = buildBeforeToolExecute(deps);

    // post-card path
    const p1 = before({ name: 'write_file', params: { path: 'a.ts', content: 'x' } });
    await gate.resolveNext('once');
    await p1;
    expect(deps.state.toolStartedAt.get('write_file')).toBeTypeOf('number');

    // turn-local auto-grant path (same key as p1)
    deps.state.toolStartedAt.delete('write_file');
    await before({ name: 'write_file', params: { path: 'a.ts', content: 'y' } });
    expect(deps.state.toolStartedAt.get('write_file')).toBeTypeOf('number');

    // autoApprove path
    vscodeMock.autoApproveEdits = true;
    deps.state.toolStartedAt.delete('apply_edit');
    await before({ name: 'apply_edit', params: { path: 'b.ts' } });
    expect(deps.state.toolStartedAt.get('apply_edit')).toBeTypeOf('number');
  });
});
