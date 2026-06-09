/**
 * Per-iteration goal-anchor injector for ToolUseLoop.runWithMessages.
 *
 * Re-injects the original user goal into the conversation when the
 * loop is at risk of drifting. Two observed drift modes the anchor
 * defends against:
 *
 *   1. Recency bias — long tool-result chains push the goal down the
 *      attention window; model answers about whatever was salient in
 *      the most recent tool reads.
 *   2. Multi-turn pivot — after a stretch of failed tool calls,
 *      compaction cleans them up and the model re-answers an EARLIER
 *      user prompt that's cleaner to address.
 *
 * Eligibility: `iterations >= 2 AND messageTokens > 4000`. Re-fire
 * allowed after `GOAL_ANCHOR_REFIRE_GAP` (4) iterations on sticky turns.
 *
 * Aggressive compaction this iteration overrides BOTH the refire-gap
 * AND the eligibility floor — it's the highest-risk drift trigger we
 * have. Compaction stripped most of the file content the model was
 * reasoning over; without an immediate re-anchor the model falls back
 * to imitating tool-result formats from training (the 2026-05-06
 * fabricated `read_file` envelope) or pivoting to a tangent that
 * sounded plausible from the surviving tool names.
 *
 * Post-aggressive-compaction anchors also include:
 * - a "context just compacted" preamble explaining what the
 *   `[earlier run, N lines elided]` markers actually mean
 * - the live tool list (MCP-namespaced first, capped at 40) so a
 *   surviving "tool not registered" error doesn't convince the model
 *   that real tools are unavailable
 *
 * The whole module returns the new `lastGoalAnchorIteration` so the
 * orchestrator can update its mutable counter; no other state escapes.
 */
import type { ToolLoopMessage } from '../tool-types';
import type { ToolRegistry } from '../tool-registry';

export type AnchorEmit = (type: string, payload?: unknown) => void;

export const GOAL_ANCHOR_REFIRE_GAP = 4;

export interface ApplyGoalAnchorArgs {
  /** The user's goal for THIS turn (the most-recent substantive prompt). */
  originalGoal: string;
  /** Number of earlier user prompts in the seed — used by the
   * "ignore prior prompts" suffix that defends against the multi-turn
   * pivot failure mode. */
  priorUserPromptCount: number;
  /** When true, no anchor injection (the loop is wrapping up). */
  hitLimit: boolean;
  /** Current iteration counter. */
  iteration: number;
  /** Iteration at which the anchor last fired (-1 if never). */
  lastGoalAnchorIteration: number;
  /** When true, compaction this iteration dropped >=25% of tokens OR
   * >=10k absolute. Overrides eligibility floor and refire gap. */
  aggressiveCompactionThisIteration: boolean;
  /** Mutable message log — anchor is pushed in place when fired. */
  messages: ToolLoopMessage[];
  /** Tool registry — read for the tool-list block when compaction is
   * aggressive. */
  registry: ToolRegistry;
  /** Event sink for `tool_loop:goal_anchor`. */
  emit: AnchorEmit;
}

export interface ApplyGoalAnchorResult {
  /** New value for `lastGoalAnchorIteration` (caller assigns it back).
   * Unchanged when the anchor did not fire. */
  lastGoalAnchorIteration: number;
  /** True when the anchor message was appended. */
  anchored: boolean;
}

export function applyGoalAnchorIfNeeded(args: ApplyGoalAnchorArgs): ApplyGoalAnchorResult {
  const {
    originalGoal,
    priorUserPromptCount,
    hitLimit,
    iteration,
    lastGoalAnchorIteration,
    aggressiveCompactionThisIteration,
    messages,
    registry,
    emit
  } = args;

  if (!originalGoal || hitLimit) {
    return { lastGoalAnchorIteration, anchored: false };
  }

  const messageTokens = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  const eligible = iteration >= 2 && messageTokens > 4000;
  const canRefire = lastGoalAnchorIteration >= 0
    && (iteration - lastGoalAnchorIteration) >= GOAL_ANCHOR_REFIRE_GAP;
  const shouldAnchor = aggressiveCompactionThisIteration
    || (eligible && (lastGoalAnchorIteration < 0 || canRefire));

  if (!shouldAnchor) {
    return { lastGoalAnchorIteration, anchored: false };
  }

  emit('tool_loop:goal_anchor', {
    iteration,
    goalPreview: originalGoal.slice(0, 120),
    priorUserPromptCount,
    refire: canRefire,
    postAggressiveCompaction: aggressiveCompactionThisIteration
  });

  // Multi-turn-aware anchor. When prior user prompts exist in history,
  // explicitly tell the model to ignore them — that's the failure mode
  // boolean recency-bias guards don't catch. Structured header +
  // bullet so even small models can lock onto the format.
  const ignoreEarlier = priorUserPromptCount > 0
    ? `\n  - There ${priorUserPromptCount === 1 ? 'is 1 earlier user prompt' : `are ${priorUserPromptCount} earlier user prompts`} in this conversation. Do NOT answer ${priorUserPromptCount === 1 ? 'it' : 'them'}. They were settled in prior turns.`
    : '';

  // Re-inject the current tool list whenever compaction has been
  // aggressive — defends against the failure mode where an earlier
  // error message ("tool not registered" or "expected object received
  // string") survives compaction while the success path doesn't, and
  // the model concludes the tool doesn't exist. The model would
  // normally see the tools in the native-tools schema sent on every
  // call, but small/mid models trust prose history over schema, so we
  // make the availability claim textual and authoritative.
  let toolListBlock = '';
  if (aggressiveCompactionThisIteration) {
    const allNames = registry.getAll().map((t) => t.name);
    if (allNames.length > 0) {
      // Cap to keep the prompt budget bounded — surface MCP-namespaced
      // tools (the ones most likely to be hallucinated as absent)
      // first, then any remaining names, then truncate.
      const mcpNames = allNames.filter((n) => n.includes('.') || n.startsWith('mcp__'));
      const otherNames = allNames.filter((n) => !mcpNames.includes(n));
      const ordered = [...mcpNames, ...otherNames];
      const TOOL_LIST_CAP = 40;
      const shown = ordered.slice(0, TOOL_LIST_CAP);
      const more = ordered.length > TOOL_LIST_CAP ? ` (+${ordered.length - TOOL_LIST_CAP} more)` : '';
      toolListBlock =
        `## TOOLS CURRENTLY AVAILABLE THIS TURN${more}\n\n` +
        shown.map((n) => `  - ${n}`).join('\n') +
        '\n\nIf you think a tool is missing, re-check this list before saying so. ' +
        'The names above were sent to you in the native-tools schema on THIS call.\n\n';
    }
  }

  const compactionPreamble = aggressiveCompactionThisIteration
    ? '## CONTEXT JUST COMPACTED — read this first.\n\n' +
      'Most of the tool-result content from this turn was just collapsed to one-line placeholders to fit the context window. ' +
      'Those `[earlier run, N lines elided]` markers represent real reads whose content is no longer in front of you. ' +
      'Do NOT fabricate `<tool_result>` blocks pretending to read files; do NOT pivot to a topic that looks salient based on which tool names survived in the placeholders. ' +
      'Answer from what you ALREADY learned in this turn, owning honestly anything you cannot recall in detail.\n\n' +
      toolListBlock
    : '';

  messages.push({
    role: 'user',
    content:
      `${compactionPreamble}## CURRENT GOAL — answer THIS, nothing else:\n\n  "${originalGoal.trim()}"\n\nRules:\n  - Use what you have gathered to answer the goal above.\n  - Do not pivot to a related topic that happens to be salient in recent tool results.${ignoreEarlier}\n  - If the available tools cannot finish the goal, own that honestly in your final answer — do NOT redirect to an easier question.`
  });

  return { lastGoalAnchorIteration: iteration, anchored: true };
}
