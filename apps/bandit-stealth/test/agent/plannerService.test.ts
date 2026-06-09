import { describe, expect, it } from 'vitest';
import { plannerService } from '../../src/agent/plannerService';

function getLocateStep(plan: { steps?: Array<{ action?: { type?: string; name?: string; primaryPathHint?: string } }> }) {
  return (plan.steps ?? []).find(
    (step) => step.action?.type === 'internal' && step.action?.name === 'locateFiles'
  );
}

function getRewriteStep(plan: {
  steps?: Array<{ action?: { type?: string; instructions?: string }; targetFile?: string; title?: string }>
}) {
  return (plan.steps ?? []).find((step) => step.action?.type === 'llmRewrite');
}

function getReadPrimaryStep(plan: { steps?: Array<{ action?: { name?: string }; title?: string }> }) {
  return (plan.steps ?? []).find((step) => step.action?.name === 'readFile');
}

describe('plannerService locateFiles targeting', () => {
  it('does not force primaryPathHint for multi-file relevant-file lists', async () => {
    const goal = [
      'Add a comment to the top of App.tsx describing what this file does',
      'Relevant files: apps/agent-ui-workbench/src/App.tsx, apps/bandit-stealth-web/src/App.tsx, apps/bandit-stealth/webview/src/App.tsx, apps/bandit-stealth-web/src/components/AuthGuard.tsx'
    ].join('\n');

    const plan = await plannerService.generatePlan(goal);
    const locateStep = getLocateStep(plan);
    const hint = locateStep?.action?.primaryPathHint;

    expect(locateStep).toBeDefined();
    expect(hint).toBeUndefined();
  });

  it('uses dynamic primary path for rewrite/read steps after locateFiles', async () => {
    const goal = [
      'Add a comment to the top of App.tsx describing what this file does',
      'Relevant files: apps/agent-ui-workbench/src/App.tsx, apps/bandit-stealth-web/src/App.tsx, apps/bandit-stealth/webview/src/App.tsx'
    ].join('\n');

    const plan = await plannerService.generatePlan(goal);
    const rewriteStep = getRewriteStep(plan);
    const readStep = getReadPrimaryStep(plan);
    const instructions = rewriteStep?.action?.instructions ?? '';

    expect(readStep?.title).toBe('Read primary match');
    expect(rewriteStep).toBeDefined();
    expect(rewriteStep?.targetFile).toBeUndefined();
    expect(instructions).not.toContain('FILE: apps/agent-ui-workbench/src/App.tsx');
  });

  it('keeps primaryPathHint for explicit single-file goals', async () => {
    const goal = 'Add a comment to the top of apps/bandit-stealth/webview/src/App.tsx.';
    const plan = await plannerService.generatePlan(goal);
    const locateStep = getLocateStep(plan);
    const hint = locateStep?.action?.primaryPathHint;

    expect(locateStep).toBeDefined();
    expect((hint ?? '').toLowerCase()).toBe('apps/bandit-stealth/webview/src/app.tsx');
  });

  it('defers primaryPathHint when goal names a file alongside unrelated runtime files', async () => {
    const goal = [
      'add a comment to the top of app.tsx for the core runtime',
      'Relevant files: apps/agent-ui-workbench/src/App.tsx, packages/stealth-core-runtime/src/runtime/additionalWrites.ts, packages/agent-core/src/runtime/AgentRuntime.ts'
    ].join('\n');

    const plan = await plannerService.generatePlan(goal);
    const locateStep = getLocateStep(plan);

    // Multi-file list should defer primaryPathHint — embeddings should NOT override it
    expect(locateStep?.action?.primaryPathHint).toBeUndefined();
    // locateStep must exist with search patterns
    expect(locateStep).toBeDefined();
    expect((locateStep?.action as any)?.patterns?.length).toBeGreaterThan(0);
  });
});
