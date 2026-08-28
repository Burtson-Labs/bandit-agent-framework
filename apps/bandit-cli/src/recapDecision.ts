/**
 * When to show the `✻ recap:` line.
 *
 * The recap exists to remind the user what a turn did AFTER a long answer has
 * scrolled off. But it echoes the first sentence of the response, which is
 * pure redundancy when the answer is short, or self-documenting (a table), or
 * still fully on screen — the exact cases in the "printed twice / hard to
 * follow" report. This narrows it to its real use: long prose answers that
 * genuinely scrolled.
 *
 * Pure and terminal-agnostic (rows injected) so it's unit-testable.
 */

export interface RecapDecisionInput {
  /** The user's prompt for the turn. */
  userPrompt: string;
  /** The raw assistant response (markdown), used to detect tables and length. */
  rawResponse: string;
  /** The response with reasoning/markup/table syntax stripped — what the recap
   *  would actually quote. Length gates the "too short to bother" case. */
  cleanedResponse: string;
  /** Terminal height, so "did it scroll?" is answered against the real screen. */
  terminalRows: number;
}

/** A response line that is part of a markdown table (row or separator). */
function hasTable(text: string): boolean {
  return text.split('\n').some(
    (line) => /^\s*\|.*\|\s*$/.test(line) || /^\s*\|?\s*[:\-]+\s*\|/.test(line),
  );
}

/**
 * Decide whether the recap earns its line for this turn.
 *
 * Suppressed when:
 *  - both prompt and answer are tiny (chit-chat — the old rule),
 *  - the answer contains a table or code block (it documents itself), or
 *  - the whole answer comfortably fits on screen (nothing scrolled, so a
 *    one-line "what happened" adds nothing the user can't already see).
 *
 * Shown only for long, prose-heavy answers where a reminder is actually useful.
 */
export function shouldShowRecap(input: RecapDecisionInput): boolean {
  const { userPrompt, rawResponse, cleanedResponse, terminalRows } = input;
  if (!userPrompt.trim() || !cleanedResponse.trim()) {return false;}

  // Chit-chat — nothing worth recapping.
  if (cleanedResponse.length < 40 && userPrompt.trim().length < 30) {return false;}

  // Self-documenting: a table or a fenced code block speaks for itself, and the
  // recap's first-sentence echo ("Here are the messages I found:") is noise
  // right beneath it.
  if (hasTable(rawResponse) || /```/.test(rawResponse)) {return false;}

  // Fits on screen → the user can still see the whole answer, so a summary of
  // it is redundant. Leave headroom for the prompt frame + status + recap.
  const answerRows = rawResponse.split('\n').length;
  const visibleBudget = Math.max(8, (terminalRows || 24) - 8);
  if (answerRows <= visibleBudget && rawResponse.length < 900) {return false;}

  return true;
}
