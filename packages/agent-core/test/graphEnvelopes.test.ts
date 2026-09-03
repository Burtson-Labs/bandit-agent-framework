/**
 * Phase 6 contract set — per-node capability envelopes.
 * Properties: an envelope only narrows (deny beats allow, allowlist blocks the
 * unlisted), it composes with a host gate (first deny wins, envelope first),
 * the scheduler threads it from spec → executor context, and a loop-wrapped
 * node enforces it so a blocked tool NEVER executes.
 */
import { describe, it, expect } from 'vitest';
import {
  composeGates,
  envelopeGate,
  runGraph,
  wrapLoopAsNode,
  defaultNodePrompt,
} from '../src/graph';
import type { GraphSpec, NodeExecutor } from '../src/graph';
import { createCoreToolRegistry } from '../src/tools/core-tools';
import type { ChatFn, ToolExecutionContext } from '../src/tools/tool-types';

describe('envelopeGate', () => {
  it('no envelope → everything allowed', async () => {
    const gate = envelopeGate(undefined);
    expect((await gate({ name: 'write_file', params: {} })).allow).toBe(true);
  });

  it('denyTools blocks its entries with an actionable reason', async () => {
    const gate = envelopeGate({ denyTools: ['run_command'] });
    const verdict = await gate({ name: 'run_command', params: { cmd: 'ls' } });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/envelope denies "run_command"/);
    expect((await gate({ name: 'read_file', params: {} })).allow).toBe(true);
  });

  it('allowTools blocks everything not listed', async () => {
    const gate = envelopeGate({ allowTools: ['read_file', 'search_code'] });
    expect((await gate({ name: 'read_file', params: {} })).allow).toBe(true);
    const verdict = await gate({ name: 'write_file', params: {} });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/allows only \[read_file, search_code\]/);
  });

  it('deny wins when a tool is in both lists', async () => {
    const gate = envelopeGate({ allowTools: ['read_file'], denyTools: ['read_file'] });
    expect((await gate({ name: 'read_file', params: {} })).allow).toBe(false);
  });
});

describe('composeGates', () => {
  it('first deny wins and short-circuits later gates', async () => {
    const calls: string[] = [];
    const gate = composeGates(
      (c) => { calls.push(`a:${c.name}`); return { allow: false, reason: 'a says no' }; },
      (c) => { calls.push(`b:${c.name}`); return { allow: true }; },
    );
    const verdict = await gate({ name: 'x', params: {} });
    expect(verdict).toMatchObject({ allow: false, reason: 'a says no' });
    expect(calls).toEqual(['a:x']); // b never consulted
  });

  it('skips undefined gates and passes when all allow', async () => {
    const gate = composeGates(undefined, () => ({ allow: true }), undefined);
    expect((await gate({ name: 'x', params: {} })).allow).toBe(true);
  });
});

describe('runGraph — envelope threading', () => {
  it('the spec envelope arrives in the executor context', async () => {
    let seen: unknown = 'unset';
    const spec: GraphSpec = {
      nodes: [{ id: 'a', envelope: { allowTools: ['read_file'] } }, { id: 'b' }],
    };
    const result = await runGraph(spec, {
      a: async (ctx) => { seen = ctx.envelope; return {}; },
      b: async (ctx) => {
        expect(ctx.envelope).toBeUndefined();
        return {};
      },
    } as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');
    expect(seen).toEqual({ allowTools: ['read_file'] });
  });
});

describe('wrapLoopAsNode — envelope enforcement', () => {
  function trackingContext(): { ctx: ToolExecutionContext; writes: string[] } {
    const writes: string[] = [];
    const ctx = {
      workspaceRoot: '/repo',
      readFile: async () => 'body',
      writeFile: async (p: string) => { writes.push(p); },
      listFiles: async () => [],
      listDirectoryEntries: async () => [],
      searchCode: async () => '',
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as ToolExecutionContext;
    return { ctx, writes };
  }

  it('a read-only envelope blocks a write attempt: tool never executes, model recovers, node completes', async () => {
    const { ctx, writes } = trackingContext();
    let call = 0;
    const chat: ChatFn = async function* () {
      call += 1;
      if (call === 1) {
        yield '<tool_call>{"name":"write_file","params":{"path":"x.md","content":"hi"}}</tool_call>';
      } else {
        // The model saw the deny reason as its tool result and replans.
        yield 'Blocked from writing — here is what I would have written instead.';
      }
    };
    const blocked: string[] = [];
    const node = wrapLoopAsNode(
      {
        registry: createCoreToolRegistry(),
        ctx,
        chat,
        loopOptions: {
          emitEvent: (t, p) => {
            if (t === 'tool_loop:tool_blocked') blocked.push(String((p as { reason?: string })?.reason ?? ''));
          },
        },
      },
      defaultNodePrompt('Write a note.'),
    );
    const spec: GraphSpec = {
      nodes: [{ id: 'note', envelope: { allowTools: ['read_file', 'search_code', 'list_files'] } }],
    };
    const result = await runGraph(spec, { note: node } as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');            // model recovered gracefully
    expect(writes).toEqual([]);                          // the write NEVER hit the fs
    expect(blocked.some((r) => /envelope allows only/.test(r))).toBe(true);
    expect(result.nodes.note.evidence ?? []).toEqual([]); // no file-changed evidence
  });

  it('composes with a host gate: envelope passes, host still denies', async () => {
    const { ctx } = trackingContext();
    let call = 0;
    const chat: ChatFn = async function* () {
      call += 1;
      yield call === 1
        ? '<tool_call>{"name":"read_file","params":{"path":"secrets.env"}}</tool_call>'
        : 'Could not read it — host policy refused.';
    };
    const blocked: string[] = [];
    const node = wrapLoopAsNode(
      {
        registry: createCoreToolRegistry(),
        ctx,
        chat,
        loopOptions: {
          // Stand-in for a host-kit gate (e.g. credential-path classification).
          beforeToolExecute: (c) =>
            c.params.path === 'secrets.env'
              ? { allow: false, reason: 'host: credential path' }
              : { allow: true },
          emitEvent: (t, p) => {
            if (t === 'tool_loop:tool_blocked') blocked.push(String((p as { reason?: string })?.reason ?? ''));
          },
        },
      },
      defaultNodePrompt('Read the env file.'),
    );
    const spec: GraphSpec = { nodes: [{ id: 'r', envelope: { allowTools: ['read_file'] } }] };
    const result = await runGraph(spec, { r: node } as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');
    expect(blocked).toContain('host: credential path'); // envelope allowed, host denied
  });
});
