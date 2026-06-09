/**
 * Contract tests for the plan-run helpers added to `ConversationService`:
 * `startPlanRun`, `getActivePlanRun`, `recordFinalEvaluation`,
 * `updatePlanStep`. These pin the load-bearing behaviors the agent
 * environment bridge depends on.
 *
 * 1. `startPlanRun` caps `planRuns` at 10 entries (the 11th push evicts
 *    the oldest), sets `activePlanRunId` + `activePlan`, clears
 *    `planStates`, and stamps `conversation.updatedAt`.
 * 2. `getActivePlanRun` adopts the latest run by `createdAt` when no
 *    `activePlanRunId` is tracked yet.
 * 3. `recordFinalEvaluation` writes `evaluation` + `completedAt` onto
 *    the active run and returns it; with no active run it returns
 *    undefined.
 * 4. `updatePlanStep` merges partial updates onto the existing step
 *    state and writes back through both the run's `updates` map and
 *    the live `planStates` mirror.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConversationStorage } from '../../src/services/conversationService';
import type { Plan } from '../../src/services/conversationTypes';

vi.mock('vscode', () => ({}));

import { ConversationService } from '../../src/services/conversationService';

function makeStorage(): ConversationStorage {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown) {
      store.set(key, value);
      return Promise.resolve();
    }
  };
}

function makePlan(goal: string, stepCount = 2): Plan {
  return {
    goal,
    steps: Array.from({ length: stepCount }, (_, i) => ({ id: `step-${i + 1}`, title: `Step ${i + 1}` }))
  } as Plan;
}

function makeService(): ConversationService {
  const svc = new ConversationService({
    storage: makeStorage(),
    historyStorageKey: 'history',
    legacyStorageKey: 'legacy'
  });
  // Make sure there's an active conversation in `messages.length === 0`
  // state so subsequent startPlanRun calls have a target.
  svc.ensureActive();
  return svc;
}

describe('ConversationService plan helpers', () => {
  it('startPlanRun caps planRuns at 10 entries, activates the new run, clears step state, and stamps updatedAt', async () => {
    const svc = makeService();
    const before = svc.getCurrent()!;
    const stampBefore = before.updatedAt;

    // Pre-populate a step in planStates so we can confirm it clears.
    svc.startPlanRun({ plan: makePlan('seed'), artifactsEnabled: false });
    svc.updatePlanStep('step-1', { state: 'done', summary: 'old' });
    expect(svc.planStates.size).toBe(1);

    // 10 more plan runs — 1 seed + 10 = 11 attempted pushes, cap is 10.
    for (let i = 0; i < 10; i += 1) {
      // Tiny delay to keep createdAt monotonic on fast machines.
      await new Promise((r) => setTimeout(r, 1));
      svc.startPlanRun({ plan: makePlan(`run-${i}`), artifactsEnabled: false });
    }

    const after = svc.getCurrent()!;
    expect(after.planRuns).toHaveLength(10);
    // The seed run ("seed") must have been evicted.
    expect(after.planRuns.find((r) => r.goal === 'seed')).toBeUndefined();
    // The newest run is active and its planStates are clean.
    expect(svc.activePlanRunId).toBe(after.planRuns[after.planRuns.length - 1].id);
    expect(svc.activePlan?.goal).toBe('run-9');
    expect(svc.planStates.size).toBe(0);
    expect(after.updatedAt).toBeGreaterThanOrEqual(stampBefore);
  });

  it('getActivePlanRun adopts the latest run by createdAt when activePlanRunId is unset', async () => {
    const svc = makeService();
    const a = svc.startPlanRun({ plan: makePlan('a'), artifactsEnabled: false })!;
    await new Promise((r) => setTimeout(r, 2));
    const b = svc.startPlanRun({ plan: makePlan('b'), artifactsEnabled: false })!;

    // Force the "no activePlanRunId" state via clearActivePlan — it
    // empties the active pointer but leaves planRuns intact.
    svc.clearActivePlan();
    expect(svc.activePlanRunId).toBeUndefined();

    const adopted = svc.getActivePlanRun();
    expect(adopted?.id).toBe(b.id);
    expect(svc.activePlanRunId).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  it('recordFinalEvaluation writes evaluation + completedAt + updatedAt onto the active run, or returns undefined without one', () => {
    const svc = makeService();
    const noRun = svc.recordFinalEvaluation({ success: true, confidence: 1, feedback: 'ok' });
    expect(noRun).toBeUndefined();

    const run = svc.startPlanRun({ plan: makePlan('finalize'), artifactsEnabled: false })!;
    const written = svc.recordFinalEvaluation({ success: false, confidence: 0.5, feedback: 'needs work' });
    expect(written?.id).toBe(run.id);
    expect(written?.evaluation).toEqual({ success: false, confidence: 0.5, feedback: 'needs work' });
    expect(typeof written?.completedAt).toBe('number');
    expect(written!.completedAt!).toBeGreaterThanOrEqual(written!.createdAt);
  });

  it('updatePlanStep merges partial updates onto the live planStates mirror and the run updates map', () => {
    const svc = makeService();
    const run = svc.startPlanRun({ plan: makePlan('merge'), artifactsEnabled: false })!;

    const first = svc.updatePlanStep('step-1', { state: 'running', summary: 'kickoff' });
    expect(first?.state).toBe('running');
    expect(first?.summary).toBe('kickoff');

    const merged = svc.updatePlanStep('step-1', { tokens: 42 });
    // Partial second write merges over the first — earlier fields persist.
    expect(merged?.state).toBe('running');
    expect(merged?.summary).toBe('kickoff');
    expect(merged?.tokens).toBe(42);

    expect(svc.planStates.get('step-1')?.tokens).toBe(42);
    expect(run.updates['step-1']?.tokens).toBe(42);
  });
});
