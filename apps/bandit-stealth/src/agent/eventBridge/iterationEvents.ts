import type { TurnLogger } from '@burtson-labs/host-kit';

/**
 * Deps for the iteration-events family. Every handler here is a trace-only
 * + occasional status-line push — none mutate TurnState, the assistant
 * entry, or any indicator. Keep this deps shape narrow so future
 * extractions can lift more event types over without widening the contract.
 */
export interface IterationEventDeps {
  turnLog: TurnLogger | null;
  setStatusMessage: (text: string) => void;
}

/**
 * Handles the iteration-events family of the tool-use loop's emit callback:
 * `tool_loop:batch_serialized`, `tool_loop:prose_loop_nudge`,
 * `tool_loop:fake_tool_result_detected`, `tool_loop:false_completion_nudge`,
 * `tool_loop:code_fence_nudge`, `tool_loop:todo_churn_nudge`,
 * `tool_loop:empty_retry`, `tool_loop:thinking_off_recovery`,
 * `tool_loop:goal_anchor`.
 *
 * Behavior preserved byte-for-byte from the inline switch the provider
 * used to host. These are all heuristic-trip signals from agent-core's
 * loop — the bridge records them to the per-turn trace and surfaces the
 * two that the user benefits from seeing (heavy batch serialized,
 * thinking-off recovery) via the status line.
 */
export function handleIterationEvent(type: string, payload: unknown, deps: IterationEventDeps): void {
  const { turnLog, setStatusMessage } = deps;

  if (type === 'tool_loop:batch_serialized') {
    const p = payload as { iteration?: number; toolCount?: number; estimatedTokens?: number; budgetTokens?: number; threshold?: number; reason?: string };
    void turnLog?.append({
      type: 'batch-serialized',
      iteration: p?.iteration,
      toolCount: p?.toolCount,
      estimatedTokens: p?.estimatedTokens,
      budgetTokens: p?.budgetTokens,
      threshold: p?.threshold,
      reason: p?.reason
    });
    setStatusMessage(`Serializing heavy tool batch (${p?.toolCount ?? '?'} calls) for this model's output budget…`);
    return;
  }

  if (type === 'tool_loop:prose_loop_nudge') {
    const p = payload as { iteration?: number; reason?: string };
    void turnLog?.append({ type: 'prose-loop-nudge', iteration: p?.iteration, reason: p?.reason });
    return;
  }

  if (type === 'tool_loop:fake_tool_result_detected') {
    const p = payload as { iteration?: number; preview?: string };
    void turnLog?.append({ type: 'fake-tool-result', iteration: p?.iteration, preview: p?.preview });
    return;
  }

  if (type === 'tool_loop:false_completion_nudge') {
    const p = payload as { iteration?: number };
    void turnLog?.append({ type: 'false-completion-nudge', iteration: p?.iteration });
    return;
  }

  if (type === 'tool_loop:code_fence_nudge') {
    const p = payload as { iteration?: number; fenceLines?: number };
    void turnLog?.append({ type: 'code-fence-nudge', iteration: p?.iteration, fenceLines: p?.fenceLines });
    return;
  }

  if (type === 'tool_loop:todo_churn_nudge') {
    const p = payload as { iteration?: number; consecutive?: number };
    void turnLog?.append({ type: 'todo-churn-nudge', iteration: p?.iteration, consecutive: p?.consecutive });
    return;
  }

  if (type === 'tool_loop:empty_retry') {
    const p = payload as { iteration?: number; attempt?: number; reasoningOnly?: boolean; narratedButNoAction?: boolean };
    void turnLog?.append({
      type: 'empty-retry',
      iteration: p?.iteration,
      attempt: p?.attempt,
      reasoningOnly: p?.reasoningOnly,
      narratedButNoAction: p?.narratedButNoAction
    });
    return;
  }

  if (type === 'tool_loop:thinking_off_recovery') {
    const p = payload as { iteration?: number; reason?: string };
    void turnLog?.append({ type: 'thinking-off-recovery', iteration: p?.iteration, reason: p?.reason });
    // Surface this to the user via the status line so they see
    // SOMETHING happening between the reasoning-only stalls and
    // the recovery attempt. Without it the user sees silence
    // and assumes the turn failed.
    setStatusMessage('Reasoning-mode stalled — retrying without thinking…');
    return;
  }

  if (type === 'tool_loop:prefill_recovery') {
    const p = payload as { iteration?: number; prefix?: string };
    void turnLog?.append({
      type: 'prefill-recovery',
      iteration: p?.iteration,
      prefix: p?.prefix
    });
    setStatusMessage('Prefilling tool envelope to break reasoning stall…');
    return;
  }

  if (type === 'tool_loop:goal_anchor') {
    const p = payload as { iteration?: number; goalPreview?: string; refire?: boolean; postAggressiveCompaction?: boolean };
    void turnLog?.append({
      type: 'goal-anchor',
      iteration: p?.iteration,
      refire: Boolean(p?.refire),
      postAggressiveCompaction: Boolean(p?.postAggressiveCompaction),
      goalPreview: p?.goalPreview
    });
    return;
  }
}
