/**
 * Graph runtime contract tests — the "first PR" proof set:
 * A→B ∥ C→D genuinely runs in parallel, the concurrency cap holds, invalid
 * graphs are rejected before anything runs, a failure skips its dependents
 * while independent branches finish, cancellation is honored, and one
 * ToolUseLoop turn runs as a node (the loop is wrapped, not rewritten).
 */
import { describe, it, expect } from 'vitest';
import { runGraph, validateGraph, wrapLoopAsNode, defaultNodePrompt } from '../src/graph';
import type { GraphSpec, NodeExecutor } from '../src/graph';
import { createCoreToolRegistry } from '../src/tools/core-tools';
import type { ChatFn, ToolExecutionContext, ToolLoopMessage } from '../src/tools/tool-types';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('validateGraph', () => {
  it('rejects duplicates, unknown deps, self-deps, and cycles by name', () => {
    expect(validateGraph({ nodes: [{ id: 'a' }, { id: 'a' }] }).errors[0]).toMatch(/duplicate/);
    expect(validateGraph({ nodes: [{ id: 'a', dependsOn: ['ghost'] }] }).errors[0]).toMatch(/unknown/);
    expect(validateGraph({ nodes: [{ id: 'a', dependsOn: ['a'] }] }).errors[0]).toMatch(/itself/);
    const cyclic = validateGraph({
      nodes: [
        { id: 'a', dependsOn: ['c'] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['b'] },
      ],
    });
    expect(cyclic.ok).toBe(false);
    expect(cyclic.errors[0]).toMatch(/cycle/);
    expect(cyclic.errors[0]).toMatch(/a.*b.*c|a, b, c/);
  });

  it('accepts a valid diamond', () => {
    const v = validateGraph({
      nodes: [
        { id: 'root' },
        { id: 'left', dependsOn: ['root'] },
        { id: 'right', dependsOn: ['root'] },
        { id: 'join', dependsOn: ['left', 'right'] },
      ],
    });
    expect(v.ok).toBe(true);
  });
});

describe('runGraph — parallelism', () => {
  it('runs A→B ∥ C→D: A and C are simultaneously in flight', async () => {
    // Deterministic proof, no timing guesses: A and C each refuse to finish
    // until BOTH have started. A serial scheduler deadlocks here and the test
    // times out — parallel schedulers pass instantly.
    let aStarted: () => void;
    let cStarted: () => void;
    const bothStarted = Promise.all([
      new Promise<void>((r) => { aStarted = r; }),
      new Promise<void>((r) => { cStarted = r; }),
    ]);
    const order: string[] = [];
    const executors: Record<string, NodeExecutor> = {
      a: async () => { order.push('a:start'); aStarted!(); await bothStarted; order.push('a:end'); return { output: 'A' }; },
      c: async () => { order.push('c:start'); cStarted!(); await bothStarted; order.push('c:end'); return { output: 'C' }; },
      b: async ({ upstream }) => { order.push('b'); return { output: `B(${upstream.a.output})` }; },
      d: async ({ upstream }) => { order.push('d'); return { output: `D(${upstream.c.output})` }; },
    };
    const spec: GraphSpec = {
      nodes: [
        { id: 'a' }, { id: 'b', dependsOn: ['a'] },
        { id: 'c' }, { id: 'd', dependsOn: ['c'] },
      ],
    };
    const result = await runGraph(spec, executors, { maxConcurrency: 2 });
    expect(result.status).toBe('completed');
    // Both chains completed with upstream data threaded through.
    expect(result.nodes.b.output).toBe('B(A)');
    expect(result.nodes.d.output).toBe('D(C)');
    // Both roots started before either finished — real concurrency.
    expect(order.indexOf('c:start')).toBeLessThan(order.indexOf('a:end'));
    expect(order.indexOf('a:start')).toBeLessThan(order.indexOf('c:end'));
  });

  it('honors maxConcurrency=1 (never two nodes in flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    const exec: NodeExecutor = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return {};
    };
    const spec: GraphSpec = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };
    const result = await runGraph(spec, exec, { maxConcurrency: 1 });
    expect(result.status).toBe('completed');
    expect(peak).toBe(1);
  });

  it('default cap is conservative (2): four independent nodes never exceed it', async () => {
    let inFlight = 0;
    let peak = 0;
    const exec: NodeExecutor = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return {};
    };
    const spec: GraphSpec = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };
    await runGraph(spec, exec);
    expect(peak).toBe(2);
  });
});

describe('runGraph — failure containment', () => {
  it('a failed node skips its transitive dependents; independent branches finish', async () => {
    const ran: string[] = [];
    const executors: Record<string, NodeExecutor> = {
      a: async () => { throw new Error('boom'); },
      b: async () => { ran.push('b'); return {}; },       // depends on a → must skip
      e: async () => { ran.push('e'); return {}; },       // depends on b → must skip (transitive)
      c: async () => { ran.push('c'); return {}; },       // independent branch
      d: async () => { ran.push('d'); return {}; },
    };
    const spec: GraphSpec = {
      nodes: [
        { id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'e', dependsOn: ['b'] },
        { id: 'c' }, { id: 'd', dependsOn: ['c'] },
      ],
    };
    const events: string[] = [];
    const result = await runGraph(spec, executors, {
      emitEvent: (type, p) => events.push(`${type}:${(p as { id?: string })?.id ?? ''}`),
    });
    expect(result.status).toBe('failed');
    expect(result.nodes.a.state).toBe('failed');
    expect(result.nodes.a.error).toMatch(/boom/);
    expect(result.nodes.b.state).toBe('skipped');
    expect(result.nodes.e.state).toBe('skipped');
    expect(result.nodes.c.state).toBe('done');
    expect(result.nodes.d.state).toBe('done');
    expect(ran).not.toContain('b');
    expect(ran).not.toContain('e');
    expect(events).toContain('graph:node_failed:a');
    expect(events).toContain('graph:node_skipped:b');
    expect(events.some((e) => e.startsWith('graph:done'))).toBe(true);
  });
});

describe('runGraph — cancellation', () => {
  it('abort stops launching; unstarted nodes end cancelled; status is cancelled', async () => {
    const controller = new AbortController();
    const executors: Record<string, NodeExecutor> = {
      a: async () => { controller.abort(); await tick(); return {}; },
      b: async () => ({}),
    };
    const spec: GraphSpec = { nodes: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] };
    const result = await runGraph(spec, executors, { signal: controller.signal, maxConcurrency: 1 });
    expect(result.status).toBe('cancelled');
    expect(result.nodes.a.state).toBe('done');       // was already running — allowed to settle
    expect(result.nodes.b.state).toBe('cancelled');  // never launched
  });
});

describe('runGraph — guardrails', () => {
  it('throws on an invalid graph before running anything', async () => {
    await expect(runGraph({ nodes: [{ id: 'a', dependsOn: ['a'] }] }, async () => ({})))
      .rejects.toThrow(/invalid graph/);
  });

  it('throws when a node has no executor (before any node starts)', async () => {
    const ran: string[] = [];
    await expect(runGraph(
      { nodes: [{ id: 'a' }, { id: 'b' }] },
      { a: async () => { ran.push('a'); return {}; } } as Record<string, NodeExecutor>,
    )).rejects.toThrow(/no executor/);
    expect(ran).toEqual([]);
  });
});

describe('wrapLoopAsNode — one loop turn as a node', () => {
  function fakeContext(): ToolExecutionContext {
    return {
      workspaceRoot: '/repo',
      readFile: async () => 'file body',
      writeFile: async () => undefined,
      listFiles: async () => ['README.md'],
      listDirectoryEntries: async () => ['README.md'],
      searchCode: async () => '',
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as ToolExecutionContext;
  }

  it('runs the loop (tool call + answer) and threads upstream output into the prompt', async () => {
    const seenPrompts: string[] = [];
    let call = 0;
    const chat: ChatFn = async function* (messages: ToolLoopMessage[]) {
      const user = messages.find((m) => m.role === 'user');
      if (user) seenPrompts.push(user.content);
      call += 1;
      if (call === 1) {
        yield '<tool_call>{"name":"read_file","params":{"path":"README.md"}}</tool_call>';
      } else {
        yield 'Summary: it reads files.';
      }
    };
    const node = wrapLoopAsNode(
      { registry: createCoreToolRegistry(), ctx: fakeContext(), chat },
      defaultNodePrompt('Summarize the README.'),
    );
    const outcome = await node({
      nodeId: 'summarize',
      signal: new AbortController().signal,
      upstream: {
        scan: { id: 'scan', state: 'done', output: 'README.md is the only doc file.', summary: 'found README.md' },
      },
    });
    expect(String(outcome.output)).toMatch(/Summary/);
    // The upstream section made it into the model's prompt.
    expect(seenPrompts[0]).toMatch(/Upstream results/);
    expect(seenPrompts[0]).toMatch(/found README.md/);
  });
});
