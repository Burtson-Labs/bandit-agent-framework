/**
 * Shared, dependency-free primitives used by the tool-use loop and its
 * sub-steps (llmStream, turnSetup, …).
 *
 * These live in a leaf module on purpose. They used to sit in tool-use-loop.ts,
 * but the sub-steps import them while tool-use-loop.ts imports the sub-steps —
 * that back-edge formed an import cycle. esbuild resolves a cycle by wrapping
 * the module in a lazy initializer and exposing its exports through a namespace
 * object, and `bun build --compile` (notably when cross-compiling) could then
 * tree-shake the lazily-initialized `createToolUseLoop` body away, leaving a
 * dangling `(0, ns.createToolUseLoop)` reference that crashed at runtime.
 * Keeping these helpers in a leaf module breaks the cycle. See the regression
 * test in loopShared.test.ts.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableLlmError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === 'USER_ABORT') {return false;}

  const message = getErrorMessage(error);
  if (/\b429\b|rate limit/i.test(message)) {return false;}

  return (
    code === 'WATCHDOG' ||
    /\b5\d\d\b/.test(message) ||
    /Upstream model request failed/i.test(message) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|terminated|UND_ERR/i.test(message)
  );
}

export function tagRetryableLlmError(error: unknown): void {
  if (error instanceof Error) {
    const tagged = error as Error & { code?: string };
    if (!tagged.code) {tagged.code = 'UPSTREAM_MODEL';}
  }
}

export function summarizeLlmError(error: unknown): string {
  const message = getErrorMessage(error).replace(/\s+/g, ' ').trim();
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}

/**
 * Detects "keep going" / "continue" / "yes" style prompts that
 * carry no real goal content. The goal-anchor block uses the most recent
 * user message as the recall text; when that text is "good lets keep
 * going" the anchor degenerates into "remind yourself to keep going",
 * which gives the model nothing to anchor on after 20 iterations of
 * drift. Real on a 60-iteration linter-fix
 * turn: every anchor injection cited "good lets keep going" as the
 * goal. Detector lets callers walk back to a prior substantive prompt
 * instead.
 *
 * Length cap (60 chars) + normalized-phrase match keeps false positives
 * down — a sentence like "keep going on the auth refactor for the
 * user-service" is longer than 60 chars and reads as a real goal, so it
 * stays a goal.
 */
const CONTINUATION_PROMPT_PHRASES = new Set([
  'continue', 'keep going', 'go on', 'proceed', 'next', 'more',
  'please continue', 'carry on', 'finish', 'finish it', 'finish up', 'wrap up', 'wrap it up',
  'good', 'great', 'nice', 'cool', 'sweet', 'perfect', 'ok', 'okay', 'k', 'yes', 'y', 'yep', 'yeah', 'ack', 'done',
  "let's continue", 'lets continue', "let's keep going", 'lets keep going',
  'good keep going', 'good lets keep going', "good let's keep going",
  'good continue', 'ok continue', 'okay continue'
]);

export function isContinuationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) {return false;}
  // Normalize: lowercase, drop non-word/space punctuation, collapse whitespace.
  const norm = trimmed
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (CONTINUATION_PROMPT_PHRASES.has(norm)) {return true;}
  // Permit "please <phrase>" and "<phrase> please" wrappings.
  for (const phrase of CONTINUATION_PROMPT_PHRASES) {
    if (norm === `please ${phrase}` || norm === `${phrase} please`) {return true;}
  }
  return false;
}
