/**
 * Tool-call batch normalization for ToolUseLoop.runWithMessages.
 *
 * After parseToolCalls returns the raw list of `<tool_call>` blocks the
 * model emitted in one iteration, the loop has to:
 *
 *   1. Drop byte-identical duplicate calls (panic-fanout mode emits the
 *      same search multiple times — observed 2026-04-26 with gpt-oss:120b
 *      on H100 fanning out 25 calls in one iteration, four of them
 *      identical `search_code writeInsightsReport`s).
 *   2. Keep at most ONE foreground (synchronous) `task` call per
 *      iteration — the model can't make progress on three subagents
 *      simultaneously and the wait time stacks.
 *   3. Slice the batch to `maxParallelTools` so a 25-call fanout
 *      doesn't drown the next iteration's tool-result payload.
 *   4. Slice further to fit the remaining per-turn budget
 *      (`maxTotalTools - totalToolsExecuted`).
 *
 * Each step emits a telemetry event on the loop's `emit` sink so hosts
 * can surface "we dropped N duplicates" / "we capped at N parallel" in
 * the UI. The caller updates `totalToolsExecuted` from the returned
 * `accepted` count.
 *
 * Pure with respect to the loop's mutable state: input is a `ToolCall[]`,
 * output is a new `ToolCall[]` plus drop counts plus the events emitted
 * via the supplied callback. The original input list is not mutated.
 */
import type { ParsedToolCall } from '../tool-use-parser';

export type ToolCallNormalizeEmit = (type: string, payload?: unknown) => void;

export interface NormalizeToolCallBatchArgs {
  /** The raw parsed list straight off this iteration's chat response. */
  toolCalls: ReadonlyArray<ParsedToolCall>;
  /** Iteration index — used as the event `iteration` field. */
  iteration: number;
  /** Max calls executed in parallel within a single iteration. */
  maxParallelTools: number;
  /** Hard cap on tool calls across the full turn. */
  maxTotalTools: number;
  /** Running total of tools executed prior to this iteration. */
  totalToolsExecuted: number;
  /** Event sink (typically the loop's `emit`). */
  emit: ToolCallNormalizeEmit;
}

export interface NormalizeToolCallBatchResult {
  /** The final list of calls to execute this iteration. */
  accepted: ParsedToolCall[];
  /** Byte-identical duplicates removed. */
  dedupedCount: number;
  /** Excess foreground `task` calls dropped (kept at most one). */
  droppedForegroundTaskCalls: number;
  /** Calls dropped because the batch exceeded `maxParallelTools`. */
  droppedParallelCap: number;
  /** Calls dropped because the batch would exceed the per-turn cap. */
  droppedTotalCap: number;
}

export function normalizeToolCallBatch(args: NormalizeToolCallBatchArgs): NormalizeToolCallBatchResult {
  const { iteration, maxParallelTools, maxTotalTools, totalToolsExecuted, emit } = args;
  let accepted: ParsedToolCall[] = [...args.toolCalls];

  // 1. Byte-identical dedup. `${name}::${JSON.stringify(params)}` is the
  // signature. Only runs when there are 2+ calls — single-call iterations
  // can't contain a duplicate of themselves.
  let dedupedCount = 0;
  if (accepted.length > 1) {
    const seen = new Set<string>();
    const deduped: ParsedToolCall[] = [];
    for (const tc of accepted) {
      const sig = `${tc.name}::${JSON.stringify(tc.params)}`;
      if (seen.has(sig)) {
        dedupedCount++;
        continue;
      }
      seen.add(sig);
      deduped.push(tc);
    }
    if (dedupedCount > 0) {
      emit('tool_loop:tool_call_deduped', {
        iteration,
        removed: dedupedCount,
        kept: deduped.length
      });
    }
    accepted = deduped;
  }

  // 2. Foreground-task fanout cap. A `task` call with
  // run_in_background != 'true' blocks the parent iteration on the
  // subagent's completion; running multiple in one iteration stacks
  // serially. Keep the first foreground task, drop the rest. Background
  // tasks are unaffected — they're fire-and-forget.
  let droppedForegroundTaskCalls = 0;
  if (accepted.length > 1) {
    let keptForegroundTask = false;
    const scoped: ParsedToolCall[] = [];
    for (const tc of accepted) {
      const isForegroundTask =
        tc.name === 'task' &&
        String(tc.params.run_in_background ?? '').toLowerCase() !== 'true';
      if (!isForegroundTask) {
        scoped.push(tc);
        continue;
      }
      if (!keptForegroundTask) {
        scoped.push(tc);
        keptForegroundTask = true;
        continue;
      }
      droppedForegroundTaskCalls++;
    }
    if (droppedForegroundTaskCalls > 0) {
      emit('tool_loop:foreground_task_fanout_capped', {
        iteration,
        kept: 1,
        dropped: droppedForegroundTaskCalls
      });
      accepted = scoped;
    }
  }

  // 3. Per-iteration parallel cap.
  let droppedParallelCap = 0;
  if (accepted.length > maxParallelTools) {
    droppedParallelCap = accepted.length - maxParallelTools;
    emit('tool_loop:tool_call_capped', {
      iteration,
      requested: accepted.length + 0,
      kept: maxParallelTools,
      dropped: droppedParallelCap
    });
    accepted = accepted.slice(0, maxParallelTools);
  }

  // 4. Per-turn total cap. Slice to fit remaining budget; the next
  // iteration short-circuits on the count check.
  let droppedTotalCap = 0;
  const remainingBudget = Math.max(0, maxTotalTools - totalToolsExecuted);
  if (accepted.length > remainingBudget) {
    droppedTotalCap = accepted.length - remainingBudget;
    emit('tool_loop:tool_call_total_capped', {
      iteration,
      requested: accepted.length,
      kept: remainingBudget,
      totalSoFar: totalToolsExecuted,
      maxTotalTools
    });
    accepted = accepted.slice(0, remainingBudget);
  }

  return {
    accepted,
    dedupedCount,
    droppedForegroundTaskCalls,
    droppedParallelCap,
    droppedTotalCap
  };
}
