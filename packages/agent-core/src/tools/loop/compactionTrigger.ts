/**
 * Per-iteration compaction trigger for ToolUseLoop.runWithMessages.
 *
 * Decides whether the running message log needs compaction this
 * iteration, runs `compactToolMessages` if so, mutates the messages
 * array in place, emits `tool_loop:compacted`, and signals whether
 * the compaction was *aggressive* (large enough drop to warrant a
 * goal-anchor re-injection on the same iteration).
 *
 * Aggressive thresholds (preserved from the in-class implementation):
 *
 *   dropRatio >= 0.25  OR  dropAbsolute >= 10,000 tokens
 *
 * Threshold history (kept for the why-trace):
 *   - 2026-05-06: original threshold was >50% drop or >20k absolute.
 *     Caught the 43k→4.5k case but missed lower-percentage drops.
 *   - 2026-05-07: lowered to >25% drop or >10k absolute after an
 *     81k→75k compaction (only 7% drop, 6k absolute) was followed by
 *     the model fabricating a fake user prompt out of comments it had
 *     read in `AgentRuntime.ts`. Below-threshold compactions weren't
 *     firing the re-anchor and the model drifted unchallenged.
 *
 * The in-place mutation matters — subsequent iterations need to see
 * the compacted history so earlier tool results don't grow back every
 * time the loop re-enters.
 */
import type { ToolLoopMessage } from '../tool-types';
import { compactToolMessages } from '../compactMessages';

export type CompactionEmit = (type: string, payload?: unknown) => void;

export interface ApplyCompactionArgs {
  /** Mutable message log — replaced in place when compaction fires. */
  messages: ToolLoopMessage[];
  /** Token budget for the chat messages. `undefined`/`<=0`/non-finite
   * disables compaction (returns aggressive=false without doing work). */
  tokenBudget: number | undefined;
  /** Event sink for `tool_loop:compacted`. */
  emit: CompactionEmit;
  /** Current iteration counter — propagated into the event payload. */
  iteration: number;
}

export interface ApplyCompactionResult {
  /** True when this iteration's compaction dropped >=25% of tokens OR
   * >=10,000 absolute tokens. The orchestrator uses this to override
   * the eligibility floor and refire gap on the goal-anchor injection. */
  aggressive: boolean;
}

export function applyCompactionIfNeeded(args: ApplyCompactionArgs): ApplyCompactionResult {
  const { messages, tokenBudget, emit, iteration } = args;

  if (tokenBudget === undefined || tokenBudget <= 0 || !Number.isFinite(tokenBudget)) {
    return { aggressive: false };
  }

  const report = compactToolMessages(messages, { tokenBudget });
  if (report.messagesCompacted === 0) {
    return { aggressive: false };
  }

  emit('tool_loop:compacted', {
    iteration,
    messagesCompacted: report.messagesCompacted,
    beforeTokens: report.beforeTokens,
    afterTokens: report.afterTokens
  });

  const dropRatio = report.beforeTokens > 0
    ? (report.beforeTokens - report.afterTokens) / report.beforeTokens
    : 0;
  const dropAbsolute = report.beforeTokens - report.afterTokens;
  const aggressive = dropRatio >= 0.25 || dropAbsolute >= 10_000;

  // Replace messages in place so subsequent iterations keep the
  // compacted history — if we didn't, earlier tool results would
  // grow back every time the loop re-entered.
  messages.length = 0;
  messages.push(...report.compacted);

  return { aggressive };
}
