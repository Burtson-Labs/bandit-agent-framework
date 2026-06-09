/**
 * Arc W3-S3.1 — contract tests for usePlanStateSync.
 *
 * Pins the load-bearing pieces the plan called out as "the trickiest
 * existing surface — bug-prone in the source today" §W3:
 * - the ref-shadow invariant (planRef.current and activePlanRunIdRef
 *   .current stay in sync with state AFTER each setter call, so
 *   consumers reading from refs in non-deps-tracked listeners get
 *   current values)
 * - applyStateSnapshot replaces all plan state from a boot message
 * - handleAgentPlan emits plan:start + plan:complete events on a new plan
 * - handleAgentPlanUpdate emits step:start / step:complete events
 *   driven by the projected step status (in_progress / completed /
 *   failed) and preserves prior planUpdates fields
 * - handleAgentPlanHistory respects an explicit activeRunId override
 * - selectedStepId auto-clears when plan goes null (avoids dangling
 *   selection after a plan ends)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AgentEvent } from '@burtson-labs/agent-core';
import { usePlanStateSync } from '../../src/hooks/usePlanStateSync';
import type { WebviewState } from '../../src/types/webview';

let appended: AgentEvent[];

beforeEach(() => {
  appended = [];
});

afterEach(() => {
  cleanup();
});

const mkOpts = () => ({
  appendEvents: (e: AgentEvent | AgentEvent[]) => {
    if (Array.isArray(e)) {
      appended.push(...e);
    } else {
      appended.push(e);
    }
  }
});

const planWithSteps = (ids: string[]) => ({
  goal: 'Test goal',
  steps: ids.map((id, i) => ({ id, title: `Step ${i + 1}`, details: '' }))
});

describe('usePlanStateSync', () => {
  it('initial state: all slots null/empty + refs in sync', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    expect(result.current.plan).toBeNull();
    expect(result.current.rawPlan).toBeNull();
    expect(result.current.planUpdates).toEqual({});
    expect(result.current.planHistory).toEqual([]);
    expect(result.current.activePlanRunId).toBeNull();
    expect(result.current.selectedStepId).toBeUndefined();
    expect(result.current.planRef.current).toBeNull();
    expect(result.current.activePlanRunIdRef.current).toBeNull();
  });

  it('handleAgentPlan sets plan + rawPlan + history + runId and emits plan:start + plan:complete', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => {
      result.current.handleAgentPlan({
        plan: planWithSteps(['s1', 's2']),
        activeRunId: 'run-1',
        history: [{ id: 'run-1', createdAt: 1 } as never]
      });
    });
    expect(result.current.plan?.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.current.rawPlan).toEqual(planWithSteps(['s1', 's2']));
    expect(result.current.activePlanRunId).toBe('run-1');
    expect(result.current.planHistory).toHaveLength(1);
    expect(appended).toHaveLength(2);
    expect(appended[0].type).toBe('plan:start');
    expect(appended[1].type).toBe('plan:complete');
  });

  it('handleAgentPlan keeps refs in sync with state for stale-closure-safe reads', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => {
      result.current.handleAgentPlan({
        plan: planWithSteps(['only']),
        activeRunId: 'run-9'
      });
    });
    // Refs MUST mirror state — consumer listeners that read .current
    // outside of effect deps depend on this invariant.
    expect(result.current.planRef.current?.steps.map((s) => s.id)).toEqual(['only']);
    expect(result.current.activePlanRunIdRef.current).toBe('run-9');
  });

  it('a null plan from handleAgentPlan emits NO events (no plan:start/complete to surface)', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => result.current.handleAgentPlan({ plan: null, activeRunId: null }));
    expect(result.current.plan).toBeNull();
    expect(appended).toEqual([]);
  });

  it('handleAgentPlanUpdate sets step status (in_progress → step:start)', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => {
      result.current.handleAgentPlan({
        plan: planWithSteps(['s1', 's2']),
        activeRunId: 'run-1'
      });
    });
    appended.length = 0; // ignore the plan-emitted ones
    act(() =>
      result.current.handleAgentPlanUpdate({
        stepId: 's1',
        status: 'start',
        meta: { summary: 'kicking off' }
      })
    );
    expect(result.current.plan?.steps.find((s) => s.id === 's1')?.status).toBe('in_progress');
    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe('step:start');
  });

  it('handleAgentPlanUpdate (completed) emits step:complete with logs from meta.summary', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => {
      result.current.handleAgentPlan({
        plan: planWithSteps(['s1']),
        activeRunId: 'run-1'
      });
    });
    appended.length = 0;
    act(() =>
      result.current.handleAgentPlanUpdate({
        stepId: 's1',
        status: 'complete',
        meta: { summary: 'all done' }
      })
    );
    expect(result.current.plan?.steps[0].status).toBe('completed');
    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe('step:complete');
    expect(
      (appended[0].payload as { result?: { logs?: string[] } })?.result?.logs
    ).toEqual(['all done']);
  });

  it('handleAgentPlanUpdate preserves prior planUpdates fields when omitted', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => {
      result.current.handleAgentPlan({
        plan: planWithSteps(['s1']),
        activeRunId: 'run-1'
      });
    });
    act(() =>
      result.current.handleAgentPlanUpdate({
        stepId: 's1',
        status: 'start',
        meta: { durationMs: 100, tokens: 42 }
      })
    );
    // Second update omits durationMs + tokens — those should survive.
    act(() =>
      result.current.handleAgentPlanUpdate({
        stepId: 's1',
        status: 'complete',
        meta: { summary: 'finished' }
      })
    );
    expect(result.current.planUpdates['s1']).toMatchObject({
      state: 'complete',
      durationMs: 100,
      tokens: 42
    });
  });

  it('handleAgentPlanHistory respects an explicit activeRunId override', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() =>
      result.current.handleAgentPlanHistory({
        history: [{ id: 'run-A', createdAt: 1 } as never, { id: 'run-B', createdAt: 2 } as never],
        activeRunId: 'run-A'
      })
    );
    expect(result.current.activePlanRunId).toBe('run-A');
    expect(result.current.activePlanRunIdRef.current).toBe('run-A');
  });

  it('handleAgentPlanHistory without an activeRunId field preserves the current active run', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    // Seed an active run.
    act(() =>
      result.current.handleAgentPlanHistory({
        history: [{ id: 'run-A', createdAt: 1 } as never],
        activeRunId: 'run-A'
      })
    );
    // Now a history-only update arrives (extension didn't include
    // activeRunId — common when a NEW history entry lands but the
    // active run hasn't changed).
    act(() =>
      result.current.handleAgentPlanHistory({
        history: [
          { id: 'run-A', createdAt: 1 } as never,
          { id: 'run-B', createdAt: 2 } as never
        ]
      } as never)
    );
    expect(result.current.activePlanRunId).toBe('run-A');
  });

  it('applyStateSnapshot replaces ALL plan slots from a state message and seeds selectedStepId from the first step', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    const state = {
      plan: planWithSteps(['x', 'y']),
      planUpdates: { x: { state: 'complete' } },
      planHistory: [{ id: 'run-z' } as never],
      activePlanRunId: 'run-z'
    } as unknown as WebviewState;
    act(() => result.current.applyStateSnapshot(state));
    expect(result.current.plan?.steps.map((s) => s.id)).toEqual(['x', 'y']);
    expect(result.current.activePlanRunId).toBe('run-z');
    expect(result.current.planHistory).toHaveLength(1);
    expect(result.current.selectedStepId).toBe('x'); // seeded from first step
  });

  it('selectedStepId auto-clears when plan transitions to null (no dangling selection)', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() => {
      result.current.handleAgentPlan({
        plan: planWithSteps(['s1']),
        activeRunId: 'run-1'
      });
    });
    act(() => result.current.setSelectedStepId('s1'));
    expect(result.current.selectedStepId).toBe('s1');
    act(() => result.current.handleAgentPlan({ plan: null, activeRunId: null }));
    // Once React flushes the auto-clear effect, selectedStepId is gone.
    expect(result.current.plan).toBeNull();
    expect(result.current.selectedStepId).toBeUndefined();
  });

  it('handleAgentPlanUpdate with an unknown stepId emits NO event but still updates planUpdates', () => {
    const { result } = renderHook(() => usePlanStateSync(mkOpts()));
    act(() =>
      result.current.handleAgentPlan({
        plan: planWithSteps(['s1']),
        activeRunId: 'run-1'
      })
    );
    appended.length = 0;
    act(() =>
      result.current.handleAgentPlanUpdate({
        stepId: 'ghost',
        status: 'start',
        meta: {}
      })
    );
    expect(appended).toEqual([]);
    expect(result.current.planUpdates['ghost']).toEqual(
      expect.objectContaining({ state: 'start' })
    );
  });
});
