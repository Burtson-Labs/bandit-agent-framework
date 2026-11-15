/**
 * Give-up recovery for change requests.
 *
 * The loop ends a turn the moment the model answers without a tool call.
 * For a question that is right. For a change request it is how a model
 * gives up: on 2026-11-15 a cloud turn asked to "add a comment in the file
 * where the apple oauth and other provider logic is ... make a pull
 * request" ran `search_code apple` (24 matching lines, the right files
 * among them), then `ls .`, then answered in prose — 7 seconds, no edit,
 * and the turn failed with NO_CHANGES_FOR_MUTATION. The honesty rule was
 * right to fail it; the runner was wrong to accept the stop after two
 * exploratory calls.
 *
 * Nobody is at the keyboard to type "go on, make the edit", so the runner
 * does it: a specific prompt that restates what was asked, lists what the
 * model has already found, and requires either the change or a stated
 * blocker. Bounded (`AGENT_RUNNER_MAX_NUDGES`, default 2); when the budget
 * is spent the turn fails honestly, exactly as before, now with the
 * model's own last words attached.
 *
 * Pure so the rules are testable without a model; turn.ts applies them.
 */

export const DEFAULT_MAX_NUDGES = 2;
export const MAX_NUDGES_ENV = 'AGENT_RUNNER_MAX_NUDGES';

/** Nudges a change request may receive. `0` disables them. A malformed
 *  value falls back to the default rather than to "never nudge" — losing
 *  the nudge silently would look like the original bug. */
export function maxNudgesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_NUDGES_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_NUDGES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 5) : DEFAULT_MAX_NUDGES;
}

/**
 * Whether the model's answer names something that genuinely prevents the
 * change. A question back to the user is NOT a blocker — nobody is there
 * to answer it, and the system prompt already says to pick the obvious
 * option. Neither is "I couldn't find it" after a search or two: that is
 * the give-up this module exists for, and the nudge carries the matches.
 */
export function statesBlocker(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (/^\s*(?:\*\*)?blocked(?:\*\*)?\s*:/im.test(t)) return true;
  return [
    /\b(?:was|were|is|got)\s+(?:blocked|refused|denied)\b/i,
    /\bblocked by (?:the )?(?:policy|permission|gate)/i,
    /\bpermission denied\b/i,
    /\bnot permitted\b/i,
    /\bread-only (?:mode|workspace|file ?system)\b/i,
    /\b(?:repository|repo|workspace) (?:is )?empty\b/i,
    /\b(?:instructions|request|requirements) (?:are |is )?contradict/i,
  ].some((re) => re.test(t));
}

export interface NudgeInput {
  /** The request needs a file to change (requiresWorkspaceMutation). */
  mutation: boolean;
  /** Files changed so far this turn. */
  artifacts: number;
  /** The permission gate refused an edit this turn. That IS the blocker;
   *  another reminder would only collide with the gate again. */
  editBlocked?: boolean;
  /** The loop stopped at its budget — the gateway's segment continuation
   *  handles that, not this. */
  hitLimit: boolean;
  cancelled: boolean;
  finalResponse: string;
  nudgesUsed: number;
  maxNudges: number;
}

export type NudgeVerdict =
  | { nudge: true }
  | {
      nudge: false;
      reason: 'not-mutation' | 'changed' | 'edit-blocked' | 'hit-limit' | 'cancelled' | 'blocker' | 'budget';
    };

export function decideNudge(input: NudgeInput): NudgeVerdict {
  if (input.cancelled) return { nudge: false, reason: 'cancelled' };
  if (!input.mutation) return { nudge: false, reason: 'not-mutation' };
  if (input.artifacts > 0) return { nudge: false, reason: 'changed' };
  if (input.editBlocked) return { nudge: false, reason: 'edit-blocked' };
  if (input.hitLimit) return { nudge: false, reason: 'hit-limit' };
  if (statesBlocker(input.finalResponse)) return { nudge: false, reason: 'blocker' };
  if (input.nudgesUsed >= input.maxNudges) return { nudge: false, reason: 'budget' };
  return { nudge: true };
}

/** One executed tool call, as the turn saw it. */
export interface Finding {
  tool: string;
  params: Record<string, string>;
  ok: boolean;
  summary: string;
}

const MAX_FINDINGS = 8;
const MAX_FILES = 8;

/** Workspace-relative paths named at the start of grep-style result lines
 *  (`path/to/File.cs:12:...`). Order of first appearance. */
export function pathsFromSearchOutput(output: string): string[] {
  const seen: string[] = [];
  for (const line of (output ?? '').split('\n')) {
    const m = /^(?:\.\/)?([^\s:][^:\n]*?\.[A-Za-z0-9]+):\d+[:-]/.exec(line.trim());
    if (m && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function describeCall(f: Finding): string {
  const primary =
    f.params.pattern ?? f.params.path ?? f.params.query ?? f.params.cmd ?? f.params.command ?? f.params.cwd ?? '';
  const args = f.params.args ? ` ${f.params.args}` : '';
  const head = `${f.tool}${primary ? ` "${primary}${args}"` : args}`;
  if (!f.ok) return `${head} — failed: ${oneLine(f.summary, 120)}`;
  if (f.tool === 'search_code') {
    if (/^No matches found/i.test(f.summary.trim())) return `${head} — no matches`;
    const files = pathsFromSearchOutput(f.summary);
    return files.length
      ? `${head} — matches in ${files.slice(0, MAX_FILES).join(', ')}${files.length > MAX_FILES ? ', …' : ''}`
      : `${head} — ${oneLine(f.summary, 120)}`;
  }
  if (f.tool === 'read_file') return `${head} — read`;
  return `${head} — ${oneLine(f.summary, 120)}`;
}

function oneLine(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Files the model has seen named in search results but not yet opened —
 *  the most likely edit targets, best first. */
export function candidateFiles(findings: Finding[]): string[] {
  const read = new Set(
    findings.filter((f) => f.tool === 'read_file' && f.ok).map((f) => (f.params.path ?? '').replace(/^\.\//, '')),
  );
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.tool !== 'search_code' || !f.ok) continue;
    for (const p of pathsFromSearchOutput(f.summary)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
    .filter((p) => !read.has(p))
    .slice(0, 5);
}

export function buildNudgePrompt(args: {
  goal: string;
  findings: Finding[];
  finalResponse: string;
  nudge: number;
  maxNudges: number;
}): string {
  const { goal, findings, finalResponse, nudge, maxNudges } = args;
  const lines: string[] = [];
  lines.push(
    `You ended your turn without changing any file, but this is a change request and nothing has been edited yet (reminder ${nudge} of ${maxNudges}).`,
  );
  lines.push('', 'What was asked:', goal.trim().slice(0, 1500));
  lines.push('', 'What you have done so far:');
  if (findings.length === 0) {
    lines.push('- Nothing yet: no tool has run.');
  } else {
    for (const f of findings.slice(-MAX_FINDINGS)) lines.push(`- ${describeCall(f)}`);
  }
  const last = oneLine(finalResponse, 400);
  if (last) lines.push('', `Your last reply: "${last}"`);
  const candidates = candidateFiles(findings);
  lines.push('');
  if (candidates.length) {
    lines.push(`Most likely files to change: ${candidates.join(', ')}. Read the best match with read_file, then make the edit.`);
  } else {
    lines.push(
      'Find the target with search_code (it is case-insensitive for lowercase patterns; try the class, type or config name, and alternation such as "apple|google|oauth"), read it with read_file, then make the edit.',
    );
  }
  lines.push(
    'Make the change now with apply_edit or write_file. Do not ask which file or which option — nobody is at the keyboard. Pick the best match, make the edit, and say which file you chose and why.',
    'If something genuinely prevents the change (the file does not exist, the edit is refused, the request contradicts itself), reply with "BLOCKED:" followed by the exact reason instead.',
  );
  return lines.join('\n');
}
