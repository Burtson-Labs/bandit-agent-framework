/**
 * Phase 9 contract set — the planner proposes, the host disposes.
 * Properties: proposals parse from realistic model output (fenced, bare,
 * prose-wrapped), structural garbage is rejected with named errors BEFORE
 * anything could run, direct/loop are first-class outcomes, and
 * materialization keeps executors + envelopes host-owned (a proposal can
 * hint read-only but can never widen anything).
 */
import { describe, it, expect } from 'vitest';
import {
  buildPlannerPrompt,
  parseGraphProposal,
  materializeProposal,
  runGraph,
} from '../src/graph';
import type { GraphProposal, NodeExecutor } from '../src/graph';

const GOOD_GRAPH = {
  kind: 'graph',
  reason: 'two independent surveys then a synthesis',
  nodes: [
    { id: 'scan-a', prompt: 'Survey area A of the codebase.', readOnly: true },
    { id: 'scan-b', prompt: 'Survey area B of the codebase.', readOnly: true },
    { id: 'synth', prompt: 'Combine the surveys into a report.', dependsOn: ['scan-a', 'scan-b'] },
  ],
};

describe('buildPlannerPrompt', () => {
  it('carries the task, the kinds, and the node cap', () => {
    const p = buildPlannerPrompt('audit error handling', { maxNodes: 4 });
    expect(p).toContain('audit error handling');
    expect(p).toContain('"direct"');
    expect(p).toContain('"loop"');
    expect(p).toContain('2-4 separable chunks');
  });
});

describe('parseGraphProposal — accepts realistic model output', () => {
  it('parses a ```json fence', () => {
    const parsed = parseGraphProposal('Here you go:\n```json\n' + JSON.stringify(GOOD_GRAPH) + '\n```\nDone!');
    expect(parsed.ok).toBe(true);
    expect(parsed.proposal?.kind).toBe('graph');
    expect(parsed.proposal?.nodes).toHaveLength(3);
  });

  it('parses bare JSON amid prose (balanced-brace scan, strings with braces survive)', () => {
    const withBraces = {
      ...GOOD_GRAPH,
      nodes: GOOD_GRAPH.nodes.map((n) => ({ ...n, prompt: n.prompt + ' Watch for {edge} cases.' })),
    };
    const parsed = parseGraphProposal('I think:\n' + JSON.stringify(withBraces) + '\nthat is all');
    expect(parsed.ok).toBe(true);
    expect(parsed.proposal?.nodes?.[0].prompt).toContain('{edge}');
  });

  it('direct and loop are first-class (no nodes required)', () => {
    const direct = parseGraphProposal('{"kind":"direct","reason":"single-fact answer"}');
    expect(direct.ok).toBe(true);
    expect(direct.proposal).toMatchObject({ kind: 'direct', reason: 'single-fact answer' });
    const loop = parseGraphProposal('{"kind":"loop"}');
    expect(loop.ok).toBe(true);
  });
});

describe('parseGraphProposal — rejects garbage with named errors', () => {
  it('no JSON / broken JSON / bad kind', () => {
    expect(parseGraphProposal('sure, sounds great!').errors[0]).toMatch(/no JSON object/);
    expect(parseGraphProposal('{"kind": "graph",').errors[0]).toMatch(/no JSON object|does not parse/);
    expect(parseGraphProposal('{"kind":"fleet"}').errors[0]).toMatch(/kind must be/);
  });

  it('graph without nodes, over the cap, duplicate ids, unknown deps, cycles, trivial prompts', () => {
    expect(parseGraphProposal('{"kind":"graph"}').errors[0]).toMatch(/non-empty "nodes"/);

    const many = { kind: 'graph', nodes: Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, prompt: 'do the thing properly' })) };
    expect(parseGraphProposal(JSON.stringify(many)).errors[0]).toMatch(/too many nodes: 7 \(max 6\)/);

    const dup = { kind: 'graph', nodes: [
      { id: 'a', prompt: 'do the first thing' }, { id: 'a', prompt: 'do the second thing' },
    ] };
    expect(parseGraphProposal(JSON.stringify(dup)).errors.join(';')).toMatch(/duplicate/);

    const ghost = { kind: 'graph', nodes: [{ id: 'a', prompt: 'do something real', dependsOn: ['ghost'] }] };
    expect(parseGraphProposal(JSON.stringify(ghost)).errors.join(';')).toMatch(/unknown/);

    const cycle = { kind: 'graph', nodes: [
      { id: 'a', prompt: 'first part of the work', dependsOn: ['b'] },
      { id: 'b', prompt: 'second part of the work', dependsOn: ['a'] },
    ] };
    expect(parseGraphProposal(JSON.stringify(cycle)).errors.join(';')).toMatch(/cycle/);

    const trivial = { kind: 'graph', nodes: [{ id: 'a', prompt: 'x' }] };
    expect(parseGraphProposal(JSON.stringify(trivial)).errors[0]).toMatch(/trivial prompt/);
  });
});

describe('materializeProposal — host stays in charge', () => {
  const proposal = parseGraphProposal(JSON.stringify(GOOD_GRAPH)).proposal as GraphProposal;

  it('builds spec + executors from host factories; every node gets an outputNonEmpty contract', async () => {
    const madeFor: string[] = [];
    const { spec, executors } = materializeProposal(proposal, {
      makeExecutor: (n) => { madeFor.push(n.id); return async () => ({ output: `ran ${n.id}` }); },
      // Host policy: read-only hint → read tools; otherwise still host-chosen.
      envelopeFor: (n) => (n.readOnly ? { allowTools: ['read_file', 'search_code'] } : { denyTools: ['run_command'] }),
    });
    expect(madeFor.sort()).toEqual(['scan-a', 'scan-b', 'synth']);
    expect(spec.nodes.every((n) => n.contract?.outputNonEmpty === true)).toBe(true);
    expect(spec.nodes.find((n) => n.id === 'scan-a')?.envelope).toEqual({ allowTools: ['read_file', 'search_code'] });
    expect(spec.nodes.find((n) => n.id === 'synth')?.envelope).toEqual({ denyTools: ['run_command'] });

    // And the materialized graph actually runs end-to-end.
    const result = await runGraph(spec, executors as Record<string, NodeExecutor>);
    expect(result.status).toBe('completed');
    expect(result.nodes.synth.output).toBe('ran synth');
  });

  it('refuses to materialize direct/loop proposals', () => {
    expect(() => materializeProposal({ kind: 'loop' }, {
      makeExecutor: () => async () => ({}),
      envelopeFor: () => undefined,
    })).toThrow(/only graph proposals/);
  });

  it('an empty-output planned node violates its auto-contract at run time', async () => {
    const { spec, executors } = materializeProposal(proposal, {
      makeExecutor: (n) => async () => (n.id === 'scan-a' ? { output: '' } : { output: 'ok' }),
      envelopeFor: () => undefined,
    });
    const result = await runGraph(spec, executors as Record<string, NodeExecutor>);
    expect(result.status).toBe('failed');
    expect(result.nodes['scan-a'].contractViolations?.[0]).toMatch(/output is empty/);
    expect(result.nodes.synth.state).toBe('skipped');
  });
});
