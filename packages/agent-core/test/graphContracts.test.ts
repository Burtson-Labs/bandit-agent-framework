/**
 * Phase 3 contract set — completion contracts, evidence, verification nodes.
 * The property under test: a node that "finished" without producing what it
 * promised is a FAILURE the graph contains (dependents skip), and independent
 * verification nodes gate downstream work on a real verdict.
 */
import { describe, it, expect } from 'vitest';
import { checkContract, runGraph, verificationNode, wrapLoopAsNode, defaultNodePrompt } from '../src/graph';
import type { GraphSpec, NodeExecutor } from '../src/graph';
import { createCoreToolRegistry } from '../src/tools/core-tools';
import type { ChatFn, ToolExecutionContext } from '../src/tools/tool-types';

describe('checkContract', () => {
  it('passes when no contract is given', () => {
    expect(checkContract(undefined, { output: '' })).toEqual([]);
  });

  it('enforces outputNonEmpty and outputMatches', () => {
    expect(checkContract({ outputNonEmpty: true }, { output: '   ' })[0]).toMatch(/empty/);
    expect(checkContract({ outputMatches: 'DONE:\\s*\\d+' }, { output: 'DONE: 3 files' })).toEqual([]);
    expect(checkContract({ outputMatches: 'DONE' }, { output: 'nope' })[0]).toMatch(/does not match/);
    // Bad regex is a violation, never a throw.
    expect(checkContract({ outputMatches: '([' }, { output: 'x' })[0]).toMatch(/invalid/);
  });

  it('enforces evidence kinds with minimum counts', () => {
    const contract = { requireEvidence: [{ kind: 'file-changed', min: 2 }, { kind: 'test-run' }] };
    const violations = checkContract(contract, {
      output: 'ok',
      evidence: [{ kind: 'file-changed', detail: 'a.ts' }],
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatch(/2 evidence of kind "file-changed", got 1/);
    expect(violations[1]).toMatch(/"test-run", got 0/);
  });
});

describe('runGraph — contract enforcement', () => {
  it('a contract violation fails the node and skips dependents; evidence lands on the result', async () => {
    const events: string[] = [];
    const spec: GraphSpec = {
      nodes: [
        { id: 'work', contract: { requireEvidence: [{ kind: 'file-changed' }] } },
        { id: 'consume', dependsOn: ['work'] },
      ],
    };
    const executors: Record<string, NodeExecutor> = {
      // Claims success but attaches NO evidence — the classic claim-without-doing.
      work: async () => ({ output: 'I definitely changed the files.', evidence: [] }),
      consume: async () => ({ output: 'should never run' }),
    };
    const result = await runGraph(spec, executors, {
      emitEvent: (t, p) => events.push(`${t}:${(p as { id?: string })?.id ?? ''}`),
    });
    expect(result.status).toBe('failed');
    expect(result.nodes.work.state).toBe('failed');
    expect(result.nodes.work.contractViolations?.[0]).toMatch(/file-changed/);
    expect(result.nodes.consume.state).toBe('skipped');
    expect(events).toContain('graph:node_contract_violation:work');
  });

  it('a satisfied contract passes and carries evidence through', async () => {
    const spec: GraphSpec = {
      nodes: [{ id: 'work', contract: { outputNonEmpty: true, requireEvidence: [{ kind: 'file-changed' }] } }],
    };
    const result = await runGraph(spec, {
      work: async () => ({
        output: 'patched',
        evidence: [{ kind: 'file-changed', detail: 'src/a.ts' }],
      }),
    } as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');
    expect(result.nodes.work.state).toBe('done');
    expect(result.nodes.work.evidence?.[0]).toMatchObject({ kind: 'file-changed', detail: 'src/a.ts' });
  });
});

describe('verificationNode', () => {
  it('gates downstream on the verdict: fail → verify node fails → consumer skips', async () => {
    const { node: verify, executor: verifyExec } = verificationNode('check', 'work', async ({ upstream }) => {
      const out = String(upstream.work.output ?? '');
      return out.includes('TESTS-PASSED')
        ? { pass: true }
        : { pass: false, reasons: ['no test evidence in output'] };
    });
    const spec: GraphSpec = {
      nodes: [{ id: 'work' }, verify, { id: 'consume', dependsOn: ['check'] }],
    };
    const ran: string[] = [];
    const result = await runGraph(spec, {
      work: async () => ({ output: 'changed stuff, ran nothing' }),
      check: verifyExec,
      consume: async () => { ran.push('consume'); return {}; },
    } as Record<string, NodeExecutor>);
    expect(result.status).toBe('failed');
    expect(result.nodes.check.state).toBe('failed');
    expect(result.nodes.check.error).toMatch(/verification failed for work/);
    expect(result.nodes.check.error).toMatch(/no test evidence/);
    expect(result.nodes.consume.state).toBe('skipped');
    expect(ran).toEqual([]);
  });

  it('a passing verdict lets the consumer run and records verification evidence', async () => {
    const { node: verify, executor: verifyExec } = verificationNode('check', 'work', () => ({ pass: true }));
    const spec: GraphSpec = { nodes: [{ id: 'work' }, verify, { id: 'consume', dependsOn: ['check'] }] };
    const result = await runGraph(spec, {
      work: async () => ({ output: 'TESTS-PASSED and shipped' }),
      check: verifyExec,
      consume: async () => ({ output: 'built on verified work' }),
    } as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');
    expect(result.nodes.check.evidence?.[0].kind).toBe('verification');
    expect(result.nodes.consume.state).toBe('done');
  });
});

describe('wrapLoopAsNode — auto evidence', () => {
  it("a loop write becomes 'file-changed' evidence that satisfies the node contract", async () => {
    let call = 0;
    const chat: ChatFn = async function* () {
      call += 1;
      if (call === 1) {
        yield '<tool_call>{"name":"write_file","params":{"path":"note.md","content":"hi"}}</tool_call>';
      } else {
        yield 'Wrote note.md.';
      }
    };
    const ctx = {
      workspaceRoot: '/repo',
      readFile: async () => '',
      writeFile: async () => undefined,
      listFiles: async () => [],
      listDirectoryEntries: async () => [],
      searchCode: async () => '',
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as ToolExecutionContext;
    const node = wrapLoopAsNode(
      { registry: createCoreToolRegistry(), ctx, chat },
      defaultNodePrompt('Write a note.'),
    );
    const spec: GraphSpec = {
      nodes: [{ id: 'write', contract: { requireEvidence: [{ kind: 'file-changed' }] } }],
    };
    const result = await runGraph(spec, { write: node } as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');
    expect(result.nodes.write.evidence?.some((e) => e.kind === 'file-changed' && e.detail === 'note.md')).toBe(true);
  });
});
