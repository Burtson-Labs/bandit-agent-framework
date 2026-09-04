/**
 * Learning memory — the distiller half.
 *
 * After a turn, the host may make ONE cheap model call asking: did anything
 * DURABLE and REPO-GENERAL happen here worth remembering for future tasks?
 * ("this project uses pnpm, not npm"; "tests for src/api live in test/api";
 * "the build fails unless you run codegen first"). Most turns yield nothing —
 * the point is to accrue a SMALL set of high-signal, reusable facts about a
 * specific repo, not a diary. Those facts are stored (see host-kit's lesson
 * store) and injected on future turns so the agent gets better at THIS repo
 * over time.
 *
 * This module is the shared, host-agnostic core: build the (small) prompt,
 * parse the reply into a lesson or nothing. Pure + fully unit-testable, same
 * split as the planner and next-prompt suggestions. The host owns the model
 * call, the persistence, and the opt-in gate (off by default — it's an extra
 * call per turn, and a store the model writes to deserves a deliberate opt-in).
 */

export interface LessonTurn {
  /** The user's prompt for the turn. */
  prompt: string;
  /** The assistant's final response. */
  assistantResponse: string;
  /** Tool names used this turn, in order (optional but sharpens distillation). */
  toolsUsed?: string[];
  /** Whether the turn succeeded, if the host knows (a failure often teaches
   *  the most durable lesson — "X doesn't work here, do Y"). */
  outcome?: 'ok' | 'error';
}

/** The sentinel a well-behaved model returns when nothing is worth storing. */
export const NO_LESSON = 'NONE';

export function buildLessonPrompt(turn: LessonTurn): string {
  const tools = turn.toolsUsed?.length ? `\nTools used: ${turn.toolsUsed.join(', ')}` : '';
  const outcome = turn.outcome ? `\nOutcome: ${turn.outcome}` : '';
  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
  return [
    'You maintain a small memory of DURABLE facts about THIS specific repository, to help future coding tasks.',
    'Look at the turn below and decide: did it reveal a fact that is (a) specific to this repo, (b) still true next week, and (c) genuinely useful for a future task?',
    '',
    'Good lessons (store these):',
    '- "This project uses pnpm; npm install breaks the workspace."',
    '- "Tests for src/api/* live in test/api/* and must be updated alongside."',
    '- "The build needs `pnpm codegen` run before `pnpm build`."',
    '',
    'NOT lessons (never store these):',
    '- Anything about this ONE task ("added a clamp function") — that\'s history, not a durable fact.',
    '- Generic programming advice true of any repo.',
    '- Anything you are not confident is actually true of this repo.',
    '',
    `Reply with ONE short sentence (the lesson, max ~140 chars) OR exactly "${NO_LESSON}" if nothing durable was learned. Most turns are "${NO_LESSON}". No preamble, no quotes, no markdown.`,
    '',
    '--- turn ---',
    `User: ${clip(turn.prompt, 500)}`,
    `Assistant: ${clip(turn.assistantResponse, 800)}${tools}${outcome}`,
  ].join('\n');
}

/**
 * Parse the distiller reply into a lesson, or null when nothing was learned.
 * Never throws. Filters NONE, empties, over-long/paragraph replies, and the
 * "here's a lesson:" preamble the model sometimes adds.
 */
export function parseLesson(text: string): string | null {
  let s = (text ?? '').trim();
  if (!s) return null;
  // Strip a leading "lesson:" / "fact:" label if present.
  s = s.replace(/^\s*(lesson|fact|answer)\s*:\s*/i, '').trim();
  // Strip surrounding quotes/backticks/markdown bullet.
  s = s.replace(/^[-*]\s+/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s) return null;
  // Explicit "nothing to learn" in any casing/punctuation.
  if (/^none[.!]?$/i.test(s)) return null;
  // A model that ignored instructions and wrote a paragraph isn't a lesson.
  if (s.length > 200) return null;
  // Refuse suspiciously generic non-facts.
  if (/^(no|n\/a|nothing|not applicable|no lesson)\b/i.test(s)) return null;
  return s;
}

/** Normalize a lesson for dedup comparison (lowercase, collapse whitespace,
 *  drop trailing punctuation). Two lessons that normalize equal are dupes. */
export function normalizeLesson(lesson: string): string {
  return lesson.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/g, '').trim();
}
