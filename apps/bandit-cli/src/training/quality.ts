/**
 * Turn quality for training: what the agent actually did (edited? verified?), whether its
 * final reply handed work back to the user instead of doing it, and the minimum-quality
 * gate. Hand-back replies ("run this: kubectl …", "I don't have access to your cluster")
 * are exactly the behaviour the fine-tune must not learn, so they never become SFT targets;
 * they go to negatives.jsonl for future preference training instead.
 */
import * as crypto from 'crypto';
import type { CanonicalMessage, ExampleLabels, ExampleStatus } from './types';

export const EDIT_TOOLS = new Set(['apply_edit', 'write_file', 'replace_range', 'apply_patch']);
/** Tools that run commands on the user's machine. */
export const COMMAND_TOOLS = new Set(['run_command', 'watch_command', 'run_tests']);

const VERIFY_COMMAND_RE =
  /\b(?:test|tests|vitest|jest|pytest|mocha|tsc|typecheck|type-check|lint|eslint|ruff|mypy|build|compile|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|dotnet\s+(?:build|test)|mvn|gradle|make|helm\s+(?:lint|template)|kubectl\s+(?:apply\s+--dry-run|diff)|terraform\s+(?:validate|plan))\b/i;

export type HandBackReason = 'shell-block-without-command' | 'handback-phrase' | 'false-capability-claim';

const SHELL_FENCE_RE = /```(?:bash|sh|zsh|shell|console|powershell|pwsh|ps1|cmd|fish)\b[^\n]*\n[\s\S]*?```/i;
// An untagged fence whose first line is a command.
const BARE_COMMAND_FENCE_RE =
  /```[ \t]*\n\s*(?:\$\s+|sudo\s+|kubectl\s|gh\s|docker\s|curl\s|git\s|npm\s|pnpm\s|yarn\s|npx\s|helm\s|ssh\s|scp\s|brew\s|apt(?:-get)?\s|dig\s|az\s|aws\s|gcloud\s|terraform\s|make\s|cd\s|export\s|chmod\s|systemctl\s)/i;
const COMMAND_LINE_RE =
  /^\s*(?:\$\s+\S|(?:sudo\s+)?(?:kubectl|gh|docker|curl|helm|ssh|scp|dig|az|aws|gcloud|terraform|systemctl)\s+[a-z-]+)/im;
const HANDBACK_PHRASE_RE =
  /\b(?:run (?:this|these|the following)(?: commands?)?|you(?:'ll| will) need to (?:run|execute|paste|apply|copy)|(?:please |can you |could you )?paste (?:the|this|that|me|back)|(?:copy|paste) (?:and|&) (?:paste|run)|in your terminal,? run|run it (?:yourself|locally)|let me know (?:what|the) (?:it|output) (?:says|prints|returns))\b/i;
const FALSE_CAPABILITY_RE =
  /\b(?:i (?:genuinely )?(?:don't|do not|can't|cannot|can not) have (?:direct )?access|i (?:don't|do not) have (?:direct |shell |terminal )?access|i (?:can't|cannot|am unable to|'m unable to|am not able to|'m not able to) (?:access|reach|run|execute|connect to|log ?in to|see) (?:your|the) (?:cluster|machine|terminal|server|repo|repository|account|github|kubernetes|k8s|shell|environment|system)|no access to (?:your|the) (?:cluster|machine|terminal|server|shell|environment))/i;

/** The turn's own messages: everything after the last real user prompt of the example. */
export function lastTurn(messages: CanonicalMessage[]): CanonicalMessage[] {
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === 'user') {start = i;}
  });
  return messages.slice(start);
}

export function finalReply(turn: CanonicalMessage[]): string {
  const last = [...turn].reverse().find(m => m.role === 'assistant' && !m.tool_calls?.length);
  return last && last.role === 'assistant' ? last.content ?? '' : '';
}

function toolNames(turn: CanonicalMessage[]): string[] {
  return turn.flatMap(m => (m.role === 'assistant' && m.tool_calls ? m.tool_calls.map(c => c.function.name) : []));
}

/**
 * Did the final reply hand the work back? Only counts when the turn never ran a command
 * itself: a reply that shows the command it already ran (with its output) is a report, not
 * a hand-back.
 */
export function detectHandBack(turn: CanonicalMessage[]): HandBackReason | null {
  const reply = finalReply(turn);
  if (!reply) {return null;}
  const ranCommand = toolNames(turn).some(n => COMMAND_TOOLS.has(n));
  if (ranCommand) {return null;}
  if (FALSE_CAPABILITY_RE.test(reply)) {return 'false-capability-claim';}
  if (SHELL_FENCE_RE.test(reply) || BARE_COMMAND_FENCE_RE.test(reply) || COMMAND_LINE_RE.test(reply)) {return 'shell-block-without-command';}
  if (HANDBACK_PHRASE_RE.test(reply)) {return 'handback-phrase';}
  return null;
}

function commandOf(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    // run_command may carry the program and its arguments separately (cmd: "npm", args: "test").
    const head = String(parsed.command ?? parsed.cmd ?? parsed.script ?? '');
    const rest = Array.isArray(parsed.args) ? parsed.args.join(' ') : String(parsed.args ?? '');
    return rest ? `${head} ${rest}` : head;
  } catch {
    return args;
  }
}

/** edited: made a file edit; verified: ran a test/build/lint (or run_tests) after the first edit. */
export function editVerifyLabels(turn: CanonicalMessage[]): { edited: boolean; verified: boolean } {
  let edited = false;
  let verified = false;
  for (const m of turn) {
    if (m.role !== 'assistant' || !m.tool_calls) {continue;}
    for (const c of m.tool_calls) {
      const name = c.function.name;
      if (EDIT_TOOLS.has(name)) {edited = true;}
      else if (edited && (name === 'run_tests' || (COMMAND_TOOLS.has(name) && VERIFY_COMMAND_RE.test(commandOf(c.function.arguments))))) {verified = true;}
    }
  }
  return { edited, verified };
}

/** Relative training weight: completed + edited + verified trajectories count most. */
export function qualityWeight(status: ExampleStatus, labels: Pick<ExampleLabels, 'edited' | 'verified'>): number {
  const base = status === 'completed' ? 1 : status === 'unknown' ? 0.75 : 0.5;
  return Math.round((base + (labels.edited ? 0.5 : 0) + (labels.verified ? 0.5 : 0)) * 100) / 100;
}

export type MinQuality = 'none' | 'completed' | 'edited' | 'completed-or-unknown-with-tools';
export const MIN_QUALITY_VALUES: MinQuality[] = ['none', 'completed', 'edited', 'completed-or-unknown-with-tools'];

export function passesMinQuality(min: MinQuality, status: ExampleStatus, labels: ExampleLabels): boolean {
  switch (min) {
    case 'none':
      return true;
    case 'completed':
      return status === 'completed';
    case 'edited':
      return Boolean(labels.edited) && (status === 'completed' || status === 'unknown');
    case 'completed-or-unknown-with-tools':
    default:
      return status === 'completed' || (status === 'unknown' && labels.toolCalls > 0);
  }
}

/** Near-duplicate key: call ids, whitespace, case and digit runs don't make two windows different. */
export function normalizedHash(messages: CanonicalMessage[]): string {
  const norm = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const calls = m.role === 'assistant' && m.tool_calls ? m.tool_calls.map(c => `${c.function.name}(${c.function.arguments})`).join('|') : '';
      return `${m.role}:${m.content ?? ''}${calls}`;
    })
    .join('\n')
    .toLowerCase()
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}
