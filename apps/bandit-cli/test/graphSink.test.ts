/**
 * Publish-capable graph sink — buildRunnableGraph's core contract:
 *  - a research→artifact task grants publish_artifact to the SINK node ONLY,
 *    and only when signed in (publishTools present); research nodes stay
 *    strictly read-only (they fan out first, the last node writes).
 *  - the sink prompt is augmented with a publish instruction (and that
 *    augmentation lands in nodePrompts, which resume rebuilds executors from).
 *  - an analysis task, or a signed-out session, keeps every node read-only.
 * Executors are built but never invoked here, so a stub deps is enough.
 */
import { describe, it, expect } from 'vitest';
import { createCoreToolRegistry, type GraphProposal, type GraphSpec } from '@burtson-labs/agent-core';
import { buildRunnableGraph } from '../src/graphPlan';
import type { LoopNodeHostDeps } from '../src/graphRun';

const deps = {
  registry: createCoreToolRegistry(),
  ctx: {},
  chatFactory: () => { throw new Error('executors are not run in this test'); },
  loopOptions: { maxIterations: 1 },
} as unknown as LoopNodeHostDeps;

function researchProposal(): GraphProposal {
  return {
    kind: 'graph',
    nodes: [
      { id: 'research-a', prompt: 'Research burtson.ai' },
      { id: 'research-b', prompt: 'Research x.ai news' },
      { id: 'synth', prompt: 'Combine the findings into a briefing', dependsOn: ['research-a', 'research-b'] },
    ],
  };
}

const PUBLISH_TOOLS = ['publish_artifact', 'share_artifact'];
const ARTIFACT_TASK = 'research burtson.ai and x.ai news, then create a briefing';

const allowOf = (spec: GraphSpec, id: string): string[] =>
  spec.nodes.find((n) => n.id === id)?.envelope?.allowTools ?? [];

describe('buildRunnableGraph — publish-capable sink', () => {
  it('grants publish_artifact to the SINK node only (research nodes stay read-only)', () => {
    const { spec, artifactIntent } = buildRunnableGraph(researchProposal(), deps, PUBLISH_TOOLS, ARTIFACT_TASK);
    expect(artifactIntent).toBe(true);
    expect(allowOf(spec, 'synth')).toContain('publish_artifact');
    expect(allowOf(spec, 'synth')).toContain('share_artifact');
    expect(allowOf(spec, 'research-a')).not.toContain('publish_artifact');
    expect(allowOf(spec, 'research-b')).not.toContain('publish_artifact');
    // research nodes keep the read-only research tools
    expect(allowOf(spec, 'research-a')).toContain('web_fetch');
    // and so does the sink (publish is ADDED to read-only, not replacing it)
    expect(allowOf(spec, 'synth')).toContain('web_fetch');
  });

  it('augments the sink prompt with a publish instruction, persisted for resume', () => {
    const { nodePrompts } = buildRunnableGraph(researchProposal(), deps, PUBLISH_TOOLS, ARTIFACT_TASK);
    expect(nodePrompts.synth).toMatch(/publish_artifact/);
    expect(nodePrompts['research-a']).not.toMatch(/publish_artifact/);
  });

  it('stays fully read-only when signed out (no publish tools), even for an artifact task', () => {
    const { spec, artifactIntent, nodePrompts } = buildRunnableGraph(researchProposal(), deps, [], ARTIFACT_TASK);
    expect(artifactIntent).toBe(false);
    expect(allowOf(spec, 'synth')).not.toContain('publish_artifact');
    expect(nodePrompts.synth).not.toMatch(/publish_artifact/);
  });

  it('stays read-only for an analysis task even when signed in', () => {
    const task = 'compare these two configs and summarize the differences between them';
    const { spec, artifactIntent } = buildRunnableGraph(researchProposal(), deps, PUBLISH_TOOLS, task);
    expect(artifactIntent).toBe(false);
    expect(allowOf(spec, 'synth')).not.toContain('publish_artifact');
  });
});
