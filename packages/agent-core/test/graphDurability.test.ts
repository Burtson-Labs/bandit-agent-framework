/**
 * Phase 5 contract set — durable execution: checkpoints, resume, replay.
 * Properties: a checkpoint lands after every settle (JSON-serializable),
 * resume RESTORES done work (executor never re-runs, outputs flow downstream),
 * re-runs failures, refuses a mismatched spec, and a crashed run finishes to
 * the same terminal shape a healthy run would have.
 */
import { describe, it, expect } from 'vitest';
import { runGraph, graphFingerprint } from '../src/graph';
import type { GraphCheckpoint, GraphSpec, NodeExecutor } from '../src/graph';

const DIAMOND: GraphSpec = {
  nodes: [
    { id: 'root' },
    { id: 'left', dependsOn: ['root'] },
    { id: 'right', dependsOn: ['root'] },
    { id: 'join', dependsOn: ['left', 'right'] },
  ],
};

describe('checkpoints', () => {
  it('fires after every settle + terminally, cumulative and JSON round-trippable', async () => {
    const checkpoints: GraphCheckpoint[] = [];
    await runGraph(DIAMOND, (async ({ nodeId }) => ({ output: `out-${nodeId}` })) as NodeExecutor, {
      onCheckpoint: (cp) => checkpoints.push(JSON.parse(JSON.stringify(cp)) as GraphCheckpoint),
    });
    // 4 settles + 1 terminal snapshot.
    expect(checkpoints.length).toBe(5);
    const last = checkpoints[checkpoints.length - 1];
    expect(Object.values(last.nodes).every((n) => n.state === 'done')).toBe(true);
    expect(last.specFingerprint).toBe(graphFingerprint(DIAMOND));
    // Monotone: done-count never decreases across checkpoints.
    const doneCounts = checkpoints.map((cp) => Object.values(cp.nodes).filter((n) => n.state === 'done').length);
    for (let i = 1; i < doneCounts.length; i++) expect(doneCounts[i]).toBeGreaterThanOrEqual(doneCounts[i - 1]);
  });

  it('a throwing onCheckpoint never disturbs the run', async () => {
    const result = await runGraph(DIAMOND, (async () => ({})) as NodeExecutor, {
      onCheckpoint: () => { throw new Error('disk full'); },
    });
    expect(result.status).toBe('completed');
  });
});

describe('resume', () => {
  it('restores done nodes (executor NOT re-run), re-runs the rest, output flows downstream', async () => {
    // First run: root+left succeed, right fails → join skipped.
    let rightAttempts = 0;
    const firstExecutors: Record<string, NodeExecutor> = {
      root: async () => ({ output: 'ROOT' }),
      left: async () => ({ output: 'LEFT' }),
      right: async () => { rightAttempts += 1; throw new Error('flaky'); },
      join: async () => ({ output: 'JOIN' }),
    };
    let lastCheckpoint: GraphCheckpoint | undefined;
    const first = await runGraph(DIAMOND, firstExecutors, {
      onCheckpoint: (cp) => { lastCheckpoint = JSON.parse(JSON.stringify(cp)) as GraphCheckpoint; },
    });
    expect(first.status).toBe('failed');
    expect(first.nodes.join.state).toBe('skipped');

    // Resume: fixed executors. root/left must NOT re-run; right retries; join runs.
    const reran: string[] = [];
    const events: string[] = [];
    const resumedExecutors: Record<string, NodeExecutor> = {
      root: async () => { reran.push('root'); return { output: 'ROOT-2' }; },
      left: async () => { reran.push('left'); return { output: 'LEFT-2' }; },
      right: async ({ upstream }) => {
        rightAttempts += 1;
        return { output: `RIGHT(${upstream.root.output})` }; // restored output visible
      },
      join: async ({ upstream }) => ({ output: `JOIN(${upstream.left.output},${upstream.right.output})` }),
    };
    const resumed = await runGraph(DIAMOND, resumedExecutors, {
      resumeFrom: lastCheckpoint,
      emitEvent: (t, p) => events.push(`${t}:${(p as { id?: string })?.id ?? ''}`),
    });
    expect(resumed.status).toBe('completed');
    expect(reran).toEqual([]);                                  // done work restored, never re-run
    expect(rightAttempts).toBe(2);                              // failure retried exactly once more
    expect(resumed.nodes.right.output).toBe('RIGHT(ROOT)');     // restored upstream output, not ROOT-2
    expect(resumed.nodes.join.output).toBe('JOIN(LEFT,RIGHT(ROOT))');
    expect(events).toContain('graph:node_restored:root');
    expect(events).toContain('graph:node_restored:left');
  });

  it('refuses a checkpoint from a different graph shape', async () => {
    const cp: GraphCheckpoint = { version: 1, specFingerprint: graphFingerprint(DIAMOND), nodes: {} };
    const otherSpec: GraphSpec = { nodes: [{ id: 'root' }, { id: 'left', dependsOn: ['root'] }] };
    await expect(runGraph(otherSpec, (async () => ({})) as NodeExecutor, { resumeFrom: cp }))
      .rejects.toThrow(/does not match this graph/);
  });

  it('label/contract/envelope changes do NOT break resume (fingerprint is structural only)', () => {
    const relabeled: GraphSpec = {
      nodes: DIAMOND.nodes.map((n) => ({
        ...n,
        label: 'renamed',
        contract: { outputNonEmpty: true },
        envelope: { denyTools: ['run_command'] },
      })),
    };
    expect(graphFingerprint(relabeled)).toBe(graphFingerprint(DIAMOND));
  });

  it('mid-run crash: resuming from the crash checkpoint completes only the remainder', async () => {
    // Simulate a crash by cancelling after the first two settles.
    const controller = new AbortController();
    let settles = 0;
    let lastCheckpoint: GraphCheckpoint | undefined;
    const first = await runGraph(DIAMOND, (async ({ nodeId }) => {
      return { output: nodeId };
    }) as NodeExecutor, {
      maxConcurrency: 1,
      signal: controller.signal,
      onCheckpoint: (cp) => {
        lastCheckpoint = JSON.parse(JSON.stringify(cp)) as GraphCheckpoint;
        settles += 1;
        if (settles === 2) controller.abort(); // "power loss" after 2 nodes
      },
    });
    expect(first.status).toBe('cancelled');
    const doneAfterCrash = Object.values(lastCheckpoint!.nodes).filter((n) => n.state === 'done').map((n) => n.id);
    expect(doneAfterCrash.length).toBeGreaterThanOrEqual(2);

    const reran: string[] = [];
    const resumed = await runGraph(DIAMOND, (async ({ nodeId }) => {
      reran.push(nodeId);
      return { output: nodeId };
    }) as NodeExecutor, { resumeFrom: lastCheckpoint });
    expect(resumed.status).toBe('completed');
    // Only the not-yet-done nodes ran on resume.
    for (const id of doneAfterCrash) expect(reran).not.toContain(id);
    expect(reran.length).toBe(4 - doneAfterCrash.length);
  });
});
