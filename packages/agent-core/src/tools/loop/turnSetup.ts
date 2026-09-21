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
import { isContinuationPrompt } from './loopShared';

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
  } else if (originalGoal) {
    // A short reply to a question the assistant just asked ("its the rwt
    // proposal" after "which artifact?") is a CLARIFICATION of the previous
    // request, not a new goal. Anchoring on the four-word answer alone told
    // the model to "answer THIS, nothing else" — and it did, abandoning
    // the actual job (make the artifact look like the original).
    const clarified = clarifiedGoal(seedMessages);
    if (clarified) {originalGoal = clarified;}
  }
  return { originalGoal, priorUserPromptCount };
}

const MAX_CLARIFICATION_WORDS = 12;

/** True for a message that reads as an answer, not an instruction: short,
 *  and free of the verbs that open a request. */
export function isShortClarification(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 120) {return false;}
  if (t.split(/\s+/).length > MAX_CLARIFICATION_WORDS) {return false;}
  if (/^(please|can you|could you|make|update|fix|add|remove|change|write|create|build|run|show|find|check|look|help|refactor|delete|rename|move|explain|why|how|what|list|open|deploy|publish|test)\b/i.test(t)) {return false;}
  return true;
}

/** Did the assistant's last message end by asking the user something? */
function assistantAskedQuestion(content: string): boolean {
  const tail = content.trim().slice(-400);
  return tail.includes('?');
}

function clarifiedGoal(seedMessages: ReadonlyArray<ToolLoopMessage>): string | null {
  // Walk back: latest user (the short reply) → the assistant question
  // right before it → the substantive user request before that.
  let i = seedMessages.length - 1;
  while (i >= 0 && !(seedMessages[i].role === 'user' && typeof seedMessages[i].content === 'string' && seedMessages[i].content.trim())) {i--;}
  if (i < 0) {return null;}
  const reply = seedMessages[i].content;
  if (!isShortClarification(reply)) {return null;}
  let j = i - 1;
  while (j >= 0 && seedMessages[j].role !== 'assistant') {
    if (seedMessages[j].role === 'user') {return null;}
    j--;
  }
  if (j < 0 || !assistantAskedQuestion(seedMessages[j].content)) {return null;}
  for (let k = j - 1; k >= 0; k--) {
    const m = seedMessages[k];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() && !isContinuationPrompt(m.content)) {
      return `${m.content.trim()}\n\n(The user then clarified: "${reply.trim()}")`;
    }
  }
  return null;
}
