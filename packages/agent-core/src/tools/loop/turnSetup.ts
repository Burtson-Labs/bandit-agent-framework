/**
 * One-shot setup helpers for ToolUseLoop.runWithMessages — work that
 * runs once per turn BEFORE the iteration loop.
 *
 * Current contents: `resolveTurnGoal`. Future Session 1/2/3 extractions
 * (system-prompt assembly, native-tools schema build, counter init)
 * will land here too. Kept under `loop/` so the orchestrator imports
 * stay grouped with the other Arc 3 modules.
 */
import type { ToolLoopMessage } from '../tool-types';
import { isContinuationPrompt } from '../tool-use-loop';

export interface ResolveTurnGoalArgs {
  seedMessages: ReadonlyArray<ToolLoopMessage>;
}

export interface ResolvedTurnGoal {
  /** The user message that anchors THIS turn — what the model is being
   * asked to do right now. Used by the goal-anchor reminder injected
   * before final-answer iterations to defeat recency bias from long
   * tool-result chains. Empty string when the seed has no user message. */
  originalGoal: string;
  /** Count of earlier user prompts in the seed history (everything
   * before the most-recent substantive one). Used by the goal-anchor
   * injection to add an "ignore prior prompts" note when there are
   * earlier conversation turns the model might confuse for the goal. */
  priorUserPromptCount: number;
}

/**
 * Resolve the per-turn goal anchor from the seed message history.
 *
 * Walks the seed messages forward to find the most-recent user prompt.
 * If that prompt is a bare continuation token ("keep going", "yes",
 * "good lets keep going" — see CONTINUATION_PROMPT_PHRASES in
 * tool-use-loop.ts), walks BACKWARD through history for the most
 * recent SUBSTANTIVE prompt and anchors on that instead.
 *
 * Why the walkback: the original bug was a 60-iteration linter-fix
 * turn that anchored every iteration on "good lets keep going"
 * because that was the literal last user message. The recall block
 * became "remind yourself to keep going" and gave the model zero
 * useful steering. Walking back finds the real goal ("fix the
 * remaining TS errors") and uses THAT as the anchor.
 */
export function resolveTurnGoal(args: ResolveTurnGoalArgs): ResolvedTurnGoal {
  const { seedMessages } = args;
  let originalGoal = '';
  let priorUserPromptCount = 0;
  for (const msg of seedMessages) {
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
      if (originalGoal) {priorUserPromptCount++;}
      originalGoal = msg.content;
    }
  }
  if (originalGoal && isContinuationPrompt(originalGoal)) {
    for (let i = seedMessages.length - 1; i >= 0; i--) {
      const m = seedMessages[i];
      if (m.role !== 'user' || typeof m.content !== 'string') {continue;}
      const c = m.content.trim();
      if (!c) {continue;}
      if (!isContinuationPrompt(c)) {
        originalGoal = m.content;
        break;
      }
    }
  }
  return { originalGoal, priorUserPromptCount };
}
