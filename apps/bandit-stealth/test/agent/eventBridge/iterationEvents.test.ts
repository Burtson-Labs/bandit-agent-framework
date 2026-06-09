/**
 * Contract tests for the iteration-events family of the tool-use-loop bridge.
 *
 * Pins three behaviors the extraction is meant to preserve:
 *
 * (1) batch_serialized writes a structured trace entry AND pushes a
 *     user-visible status message including the toolCount. The status
 *     pull is the "iteration boundary flush" contract the upstream
 *     plan calls out — the user needs to see *why* a 10-tool batch is
 *     suddenly running serially.
 *
 * (2) thinking_off_recovery does the same: trace + status. Without the
 *     status push the user sees silence between reasoning-only stalls
 *     and the recovery attempt and assumes the turn failed.
 *
 * (3) The remaining six iteration events (prose_loop_nudge,
 *     fake_tool_result_detected, false_completion_nudge,
 *     code_fence_nudge, todo_churn_nudge, empty_retry, goal_anchor) are
 *     trace-only. No status push, no state mutation. A regression that
 *     adds a status push for any of these would spam the status line
 *     on every heuristic nudge — most fire 1-3 times per turn on
 *     well-behaved models and would drown the running-tool label.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TurnLogger } from '@burtson-labs/host-kit';
import { handleIterationEvent, type IterationEventDeps } from '../../../src/agent/eventBridge/iterationEvents';

function makeDeps(): IterationEventDeps & { _append: ReturnType<typeof vi.fn>; _setStatus: ReturnType<typeof vi.fn> } {
  const append = vi.fn(async () => undefined);
  const setStatusMessage = vi.fn();
  return {
    turnLog: { append, filePath: '/tmp/test.log', close: vi.fn(async () => undefined) } as unknown as TurnLogger,
    setStatusMessage,
    _append: append,
    _setStatus: setStatusMessage
  };
}

describe('handleIterationEvent', () => {
  it('batch_serialized writes a structured trace entry and surfaces the toolCount on the status line', async () => {
    const deps = makeDeps();
    await handleIterationEvent('tool_loop:batch_serialized', {
      iteration: 3,
      toolCount: 10,
      estimatedTokens: 12500,
      budgetTokens: 8000,
      threshold: 0.75,
      reason: 'output-budget'
    }, deps);

    expect(deps._append).toHaveBeenCalledWith({
      type: 'batch-serialized',
      iteration: 3,
      toolCount: 10,
      estimatedTokens: 12500,
      budgetTokens: 8000,
      threshold: 0.75,
      reason: 'output-budget'
    });
    expect(deps._setStatus).toHaveBeenCalledWith(
      "Serializing heavy tool batch (10 calls) for this model's output budget…"
    );
  });

  it('thinking_off_recovery surfaces a status message so the user sees recovery in progress', async () => {
    const deps = makeDeps();
    await handleIterationEvent('tool_loop:thinking_off_recovery', {
      iteration: 5,
      reason: 'reasoning-only stall'
    }, deps);

    expect(deps._append).toHaveBeenCalledWith({
      type: 'thinking-off-recovery',
      iteration: 5,
      reason: 'reasoning-only stall'
    });
    expect(deps._setStatus).toHaveBeenCalledWith('Reasoning-mode stalled — retrying without thinking…');
  });

  it('trace-only iteration events do NOT push status messages', async () => {
    const deps = makeDeps();

    await handleIterationEvent('tool_loop:prose_loop_nudge', { iteration: 1, reason: 'detected loop' }, deps);
    await handleIterationEvent('tool_loop:fake_tool_result_detected', { iteration: 1, preview: 'fake' }, deps);
    await handleIterationEvent('tool_loop:false_completion_nudge', { iteration: 2 }, deps);
    await handleIterationEvent('tool_loop:code_fence_nudge', { iteration: 2, fenceLines: 18 }, deps);
    await handleIterationEvent('tool_loop:todo_churn_nudge', { iteration: 3, consecutive: 4 }, deps);
    await handleIterationEvent('tool_loop:empty_retry', { iteration: 3, attempt: 1, reasoningOnly: true, narratedButNoAction: false }, deps);
    await handleIterationEvent('tool_loop:goal_anchor', { iteration: 4, goalPreview: 'fix the bug', refire: true, postAggressiveCompaction: false }, deps);

    expect(deps._append).toHaveBeenCalledTimes(7);
    expect(deps._setStatus).not.toHaveBeenCalled();
    // goal_anchor coerces refire/postAggressiveCompaction to boolean and
    // forwards goalPreview verbatim — pin that conversion so a regression
    // can't silently drop the goal text from the trace.
    expect(deps._append).toHaveBeenLastCalledWith({
      type: 'goal-anchor',
      iteration: 4,
      refire: true,
      postAggressiveCompaction: false,
      goalPreview: 'fix the bug'
    });
  });
});
