/**
 * /graph inspection surface — pure ops over spec + checkpoint. Properties:
 * status renders every node with its state, inspect surfaces evidence and
 * contract violations, why walks to the ROOT-CAUSE ancestor (not just the
 * immediate dep), and retry invalidates the node + its transitive dependents
 * while leaving unrelated finished work restorable.
 */
import { describe, it, expect } from 'vitest';
import { graphFingerprint, type GraphCheckpoint, type GraphSpec } from '@burtson-labs/agent-core';
import { parseCheckpoint, renderStatus, renderInspect, explainWhy, invalidateForRetry } from '../src/graphOps';

const SPEC: GraphSpec = {
  nodes: [
    { id: 'root' },
    { id: 'left', dependsOn: ['root'] },
    { id: 'right', dependsOn: ['root'], contract: { outputNonEmpty: true } },
    { id: 'join', dependsOn: ['left', 'right'] },
    { id: 'publish', dependsOn: ['join'] },
  ],
};

function checkpoint(nodes: GraphCheckpoint['nodes']): string {
  return JSON.stringify({ version: 1, specFingerprint: graphFingerprint(SPEC), nodes });
}

const FAILED_RIGHT = checkpoint({
  root: { id: 'root', state: 'done', output: 'R', durationMs: 1200 },
  left: { id: 'left', state: 'done', output: 'L', evidence: [{ kind: 'file-changed', detail: 'a.ts' }] },
  right: { id: 'right', state: 'failed', error: 'contract: output is empty', contractViolations: ['contract: output is empty'] },
  join: { id: 'join', state: 'skipped' },
  publish: { id: 'publish', state: 'skipped' },
});

function view(raw: string) {
  const parsed = parseCheckpoint(SPEC, raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.view;
}

describe('parseCheckpoint', () => {
  it('rejects malformed JSON, non-checkpoints, and mismatched shapes', () => {
    expect(parseCheckpoint(SPEC, '{oops')).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/) });
    expect(parseCheckpoint(SPEC, '{"hello":1}')).toMatchObject({ ok: false, error: expect.stringMatching(/not a graph checkpoint/) });
    const other = JSON.stringify({ version: 1, specFingerprint: 'nope', nodes: {} });
    expect(parseCheckpoint(SPEC, other)).toMatchObject({ ok: false, error: expect.stringMatching(/different graph shape/) });
  });
});

describe('renderStatus', () => {
  it('shows every node with state and deps', () => {
    const out = renderStatus(view(FAILED_RIGHT));
    for (const id of ['root', 'left', 'right', 'join', 'publish']) expect(out).toContain(id);
    expect(out).toContain('2/5 done');
    expect(out).toContain('← root'); // dependency arrows render
  });
});

describe('renderInspect', () => {
  it('surfaces evidence, contract, violations, and output', () => {
    const out = renderInspect(view(FAILED_RIGHT), 'left');
    expect(out).toContain('evidence: file-changed — a.ts');
    const failed = renderInspect(view(FAILED_RIGHT), 'right');
    expect(failed).toContain('contract violations: contract: output is empty');
    expect(failed).toContain('contract: {"outputNonEmpty":true}');
  });

  it('names the valid nodes on a typo', () => {
    expect(renderInspect(view(FAILED_RIGHT), 'nope')).toMatch(/No node "nope".*root, left, right, join, publish/s);
  });
});

describe('explainWhy', () => {
  it('walks past the immediate dep to the ROOT-CAUSE ancestor', () => {
    // publish ← join ← right(failed): the walk must name right, not join.
    const out = explainWhy(view(FAILED_RIGHT), 'publish');
    expect(out).toContain('publish is blocked');
    expect(out).toContain('chain: publish ← join ← right');
    expect(out).toContain('right failed: contract: output is empty');
    expect(out).toContain('--resume');
  });

  it('answers directly for done / failed nodes', () => {
    expect(explainWhy(view(FAILED_RIGHT), 'root')).toMatch(/done — nothing is blocking/);
    expect(explainWhy(view(FAILED_RIGHT), 'right')).toMatch(/failed its completion contract/);
  });

  it('a pending node with met deps is just waiting for a resume', () => {
    const pendingJoin = checkpoint({
      root: { id: 'root', state: 'done' },
      left: { id: 'left', state: 'done' },
      right: { id: 'right', state: 'done' },
      join: { id: 'join', state: 'pending' },
      publish: { id: 'publish', state: 'pending' },
    });
    expect(explainWhy(view(pendingJoin), 'join')).toMatch(/all dependencies met.*next resume/);
  });
});

describe('invalidateForRetry', () => {
  it('drops the node + transitive dependents, keeps unrelated done work', () => {
    const result = invalidateForRetry(view(FAILED_RIGHT), 'right');
    if ('error' in result) throw new Error(result.error);
    expect(result.invalidated.sort()).toEqual(['join', 'publish', 'right']);
    expect(Object.keys(result.checkpoint.nodes).sort()).toEqual(['left', 'root']); // restorable work survives
    expect(result.checkpoint.nodes.root.state).toBe('done');
  });

  it('retrying a DONE node also invalidates its consumers', () => {
    const result = invalidateForRetry(view(FAILED_RIGHT), 'root');
    if ('error' in result) throw new Error(result.error);
    expect(result.invalidated.sort()).toEqual(['join', 'left', 'publish', 'right', 'root']);
    expect(Object.keys(result.checkpoint.nodes)).toEqual([]);
  });

  it('rejects unknown nodes', () => {
    expect(invalidateForRetry(view(FAILED_RIGHT), 'ghost')).toMatchObject({ error: expect.stringMatching(/No node "ghost"/) });
  });
});
