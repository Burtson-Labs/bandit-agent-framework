/**
 * Does a final answer already explain the tool error it follows?
 *
 * The tool-error recovery nudge exists for one failure: a tool call
 * errors, and the model's next reply quietly drops the task without a
 * retry or an explanation. It must NOT fire when the reply already says
 * why the task cannot go on. Observed live (CLI 1.7.515, 2026-11-13):
 * web_fetch on burtson.ai returned "Blocked: burtson.ai resolves to the
 * private ... address 192.168.1.44. Set BANDIT_ALLOW_PRIVATE_WEB_FETCH=1
 * ...", the model answered with exactly that explanation plus what it
 * knew, the nudge fired anyway, and the model restated the same answer,
 * so the terminal showed it twice under a wall of "automated harness
 * check" reasoning.
 *
 * An answer counts as acknowledging the error when it has real prose and
 * EITHER repeats a distinctive token from the error output (a hostname,
 * an address, an env var, a path) OR plainly says the step failed.
 */

const FAILURE_LANGUAGE = /\b(?:cannot|can't|can not|couldn't|could not|unable|not able|blocked|failed|fails|denied|refused|not allowed|not permitted|doesn't exist|does not exist|not found|no such|error)\b/i;

/** Tokens that identify THIS error rather than errors in general. */
function distinctiveTokens(errorOutput: string): string[] {
  const tokens = errorOutput.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{4,}[A-Za-z0-9]/g) ?? [];
  const common = /^(?:error|failed|blocked|address|private|loopback|local|allow|fetch|fetches|against|internal|networks|resolves|because|returned|request|unknown|invalid|missing|parameter|please)$/i;
  return [...new Set(tokens.filter((t) => !common.test(t) && (/[._:/-]/.test(t) || /\d/.test(t) || /[A-Z]{3,}/.test(t))))];
}

export function answerAcknowledgesToolError(answer: string, errorOutputs: readonly string[]): boolean {
  const prose = answer.trim();
  if (prose.length < 40) return false;
  if (FAILURE_LANGUAGE.test(prose)) return true;
  const lower = prose.toLowerCase();
  return errorOutputs.some((out) => distinctiveTokens(out).some((t) => lower.includes(t.toLowerCase())));
}
