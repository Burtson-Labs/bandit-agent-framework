/**
 * Contract tests for `createToolDispatcher` — the per-tool execution
 * factory extracted from ToolUseLoop.runWithMessages (Arc 3 Session 1).
 *
 * Pins the load-bearing behaviors of the per-tool dispatcher:
 *   - Repeat-call breaker fires after `repeatLimit` identical signatures.
 *   - Repeat-key distinguishes "same edit retried" (path + payload hash)
 *     from "different edits to the same file" — the bug captured in the
 *     S3Api 8-method comment-rewrite case.
 *   - beforeToolExecute gate denies a call and the tool never runs.
 *   - Unknown tool emits `tool_not_found` and returns isError.
 *   - Success-only edit counting: failed apply_edit does NOT bump
 *     `editToolsInvoked`. Pre-fix, attempt-counting broke the
 *     false-completion detector.
 *   - filesReadThisTurn / filesWrittenThisTurn capture basenames only.
 */
import { describe, expect, it, vi } from 'vitest';
import { createToolDispatcher } from '../src/tools/loop/singleToolExecute';
import { ToolRegistry } from '../src/tools/tool-registry';
import type { AgentTool, ToolResult, ToolExecutionContext } from '../src/index';
import { testCtx } from './_helpers';

function tc(name: string, params: Record<string, string> = {}) {
  return { name, params, raw: `<tool_call>${name} ${JSON.stringify(params)}</tool_call>` };
}

function buildEditTool(
  name: string,
  exec: (params: Record<string, string>, ctx: ToolExecutionContext) => Promise<ToolResult>
): AgentTool {
  return {
    name,
    description: `edit tool ${name}`,
    parameters: [{ name: 'path', description: 'path', required: true }],
    execute: exec
  };
}

function makeDeps(overrides: Partial<Parameters<typeof createToolDispatcher>[0]> = {}) {
  const registry = overrides.registry ?? new ToolRegistry();
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const emit = (type: string, payload?: unknown) => emitted.push({ type, payload });
  let editSuccesses = 0;
  const deps = {
    registry,
    ctx: testCtx,
    beforeToolExecute: () => ({ allow: true }),
    emit,
    recentCallKeys: [] as string[],
    repeatLimit: 3,
    filesReadThisTurn: new Set<string>(),
    filesWrittenThisTurn: new Set<string>(),
    isFileEditTool: (n: string) =>
      n === 'apply_edit' || n === 'replace_range' || n === 'write_file',
    onEditToolSucceeded: () => { editSuccesses++; },
    ...overrides
  };
  return { deps, emitted, getEditSuccesses: () => editSuccesses };
}

describe('createToolDispatcher — repeat-call breaker', () => {
  it('returns the loop-detected error after `repeatLimit` identical calls', async () => {
    const tool = buildEditTool('write_file', async () => ({ output: 'ok' }));
    const reg = new ToolRegistry();
    reg.register(tool);
    const { deps, emitted } = makeDeps({ registry: reg, repeatLimit: 3 });
    const dispatch = createToolDispatcher(deps);
    const call = tc('write_file', { path: 'a.ts', content: 'X' });
    const r1 = await dispatch(call);
    const r2 = await dispatch(call);
    const r3 = await dispatch(call);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBe(true);
    expect(r3.output).toContain('Loop detected');
    const breaker = emitted.find((e) => e.type === 'tool_loop:repeat_breaker');
    expect(breaker).toBeDefined();
  });

  it('does NOT trip on 3 different edits to the same file (payload-hashed key)', async () => {
    const tool = buildEditTool('apply_edit', async () => ({ output: 'edited' }));
    const reg = new ToolRegistry();
    reg.register(tool);
    const { deps, emitted } = makeDeps({ registry: reg, repeatLimit: 3 });
    const dispatch = createToolDispatcher(deps);
    await dispatch(tc('apply_edit', { path: 'a.ts', find: 'foo', replace: 'bar' }));
    await dispatch(tc('apply_edit', { path: 'a.ts', find: 'baz', replace: 'qux' }));
    const r3 = await dispatch(tc('apply_edit', { path: 'a.ts', find: 'meow', replace: 'woof' }));
    expect(r3.isError).toBeFalsy();
    expect(emitted.find((e) => e.type === 'tool_loop:repeat_breaker')).toBeUndefined();
  });
});

describe('createToolDispatcher — registry lookup', () => {
  it('returns tool_not_found + isError when the tool is not registered', async () => {
    const { deps, emitted } = makeDeps();
    const dispatch = createToolDispatcher(deps);
    const result = await dispatch(tc('does_not_exist', { x: '1' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not registered');
    expect(emitted.find((e) => e.type === 'tool_loop:tool_not_found')).toBeDefined();
  });
});

describe('createToolDispatcher — beforeToolExecute gate', () => {
  it('returns Blocked + isError when the gate denies and never invokes the tool', async () => {
    const executed = vi.fn();
    const tool: AgentTool = {
      name: 'read_file',
      description: 'r',
      parameters: [],
      execute: async () => {
        executed();
        return { output: 'never' };
      }
    };
    const reg = new ToolRegistry();
    reg.register(tool);
    const { deps, emitted } = makeDeps({
      registry: reg,
      beforeToolExecute: () => ({ allow: false, reason: 'policy' })
    });
    const dispatch = createToolDispatcher(deps);
    const result = await dispatch(tc('read_file', { path: 'a.ts' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('policy');
    expect(executed).not.toHaveBeenCalled();
    const blocked = emitted.find((e) => e.type === 'tool_loop:tool_blocked');
    expect(blocked).toBeDefined();
  });

  it('uses the default reason when the gate does not supply one', async () => {
    const tool: AgentTool = { name: 'noop', description: 'n', parameters: [], execute: async () => ({ output: 'k' }) };
    const reg = new ToolRegistry();
    reg.register(tool);
    const { deps } = makeDeps({
      registry: reg,
      beforeToolExecute: () => ({ allow: false })
    });
    const dispatch = createToolDispatcher(deps);
    const result = await dispatch(tc('noop'));
    expect(result.output).toContain('blocked by pre-execute guard');
  });
});

describe('createToolDispatcher — success-only edit counting', () => {
  it('bumps onEditToolSucceeded ONLY when the edit tool returns !isError', async () => {
    const reg = new ToolRegistry();
    reg.register(buildEditTool('apply_edit', async (params) => {
      // Fail when find=miss, succeed otherwise. Matches the
      // false-completion regression: 8 failed edits, model claims done.
      return { output: 'res', isError: params.find === 'miss' };
    }));
    const { deps, getEditSuccesses } = makeDeps({ registry: reg });
    const dispatch = createToolDispatcher(deps);
    await dispatch(tc('apply_edit', { path: 'a.ts', find: 'miss', replace: 'x' }));
    expect(getEditSuccesses()).toBe(0);
    await dispatch(tc('apply_edit', { path: 'a.ts', find: 'hit', replace: 'x' }));
    expect(getEditSuccesses()).toBe(1);
  });

  it('does NOT add to filesWrittenThisTurn on a failed edit', async () => {
    const reg = new ToolRegistry();
    reg.register(buildEditTool('apply_edit', async () => ({ output: 'r', isError: true })));
    const { deps } = makeDeps({ registry: reg });
    const dispatch = createToolDispatcher(deps);
    await dispatch(tc('apply_edit', { path: 'src/a.ts', find: 'x' }));
    expect(deps.filesWrittenThisTurn.size).toBe(0);
  });
});

describe('createToolDispatcher — file-set tracking (basename normalization)', () => {
  it('records basename only — `src/auth/login.ts` collapses to `login.ts`', async () => {
    const reg = new ToolRegistry();
    reg.register(buildEditTool('write_file', async () => ({ output: 'ok' })));
    reg.register({
      name: 'read_file',
      description: 'r',
      parameters: [],
      execute: async () => ({ output: 'contents' })
    });
    const { deps } = makeDeps({ registry: reg });
    const dispatch = createToolDispatcher(deps);
    await dispatch(tc('write_file', { path: 'src/auth/login.ts', content: 'x' }));
    await dispatch(tc('read_file', { path: '/abs/path/to/router.tsx' }));
    expect([...deps.filesWrittenThisTurn]).toEqual(['login.ts']);
    expect([...deps.filesReadThisTurn]).toEqual(['router.tsx']);
  });

  it('lowercases the basename so case differences collide', async () => {
    const reg = new ToolRegistry();
    reg.register(buildEditTool('write_file', async () => ({ output: 'ok' })));
    const { deps } = makeDeps({ registry: reg });
    const dispatch = createToolDispatcher(deps);
    await dispatch(tc('write_file', { path: 'src/App.JSX', content: 'x' }));
    expect([...deps.filesWrittenThisTurn]).toEqual(['app.jsx']);
  });
});

describe('createToolDispatcher — exception path', () => {
  it('catches a thrown error, emits tool_error, returns isError', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'broken',
      description: 'b',
      parameters: [],
      execute: async () => { throw new Error('boom'); }
    });
    const { deps, emitted } = makeDeps({ registry: reg });
    const dispatch = createToolDispatcher(deps);
    const result = await dispatch(tc('broken'));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('boom');
    const err = emitted.find((e) => e.type === 'tool_loop:tool_error');
    expect(err).toBeDefined();
    expect((err?.payload as { error: string }).error).toContain('boom');
  });
});
