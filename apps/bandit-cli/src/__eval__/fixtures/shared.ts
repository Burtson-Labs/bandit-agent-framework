import type { ToolCallSpec } from '../types';

/**
 * Assertion building blocks shared by the built-in fixtures, so "an edit of X" and "says
 * it is missing" mean the same thing everywhere instead of being re-spelled (differently)
 * in each fixture.
 */

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An in-place edit of `file` that does not rewrite it: apply_edit or replace_range on
 * that path, or an apply_patch that names it (in the patch text or the `path` override).
 * The system prompt offers all three as edit tools and the apply_patch description
 * recommends it for multi-file changes, so a fixture that wants "a targeted edit" must
 * accept all three.
 */
export function targetedEditOf(file: string): ToolCallSpec[] {
  const named = new RegExp(escapeRegExp(file));
  return [
    { name: /^(apply_edit|replace_range)$/, params: { path: named } },
    { name: 'apply_patch', params: { patch: named } },
    { name: 'apply_patch', params: { path: named } }
  ];
}

/** Any change to `file`, a full write_file rewrite included. */
export function anyEditOf(file: string): ToolCallSpec[] {
  return [...targetedEditOf(file), { name: 'write_file', params: { path: new RegExp(escapeRegExp(file)) } }];
}

/** Every tool that can change a file. */
export const WRITE_TOOLS = ['write_file', 'apply_edit', 'replace_range', 'apply_patch'];

/** Looking around with the shell is discovery, same as ls / list_files. */
export const SHELL_LISTING: ToolCallSpec = { name: 'run_command', params: { commandLine: /^(ls|find|tree|grep|rg)\b/ } };

// "didn't find" is deliberately absent: "the search didn't find matches, let's try…" is
// not an honest "it isn't there".
const NEG = "(?:could\\s*n['’]?t|could\\s+not|can['’]?t|cannot|can\\s+not|unable\\s+to|was\\s*n['’]?t\\s+able\\s+to|was\\s+not\\s+able\\s+to|failed\\s+to)";

/**
 * The answer says, in one of the usual wordings, that the thing asked about is not there.
 * Covers straight and typographic apostrophes and the passive forms ("could not be
 * found") that an exact-phrase list misses.
 */
export const SAYS_NOT_THERE = new RegExp(
  [
    'not\\s+(?:be\\s+)?found',
    "(?:does\\s+not|doesn['’]?t|did\\s+not|didn['’]?t)\\s+(?:appear\\s+to\\s+|seem\\s+to\\s+|currently\\s+)?exist",
    'no\\s+such\\s+file',
    `${NEG}\\s+(?:be\\s+)?(?:find|found|locate|located|read|open|access)`,
    "(?:is\\s*n['’]?t|is\\s+not|not)\\s+(?:present|there|available)",
    'non\\W?existent',
    'missing',
    'there\\s+is\\s+no\\b',
    'no\\s+(?:file|document)\\s+(?:named|called|at|exists)',
    'ENOENT'
  ].join('|'),
  'i'
);

/** Same idea for an HTTP 404 explanation: the server has nothing at that address. */
export const EXPLAINS_NOT_FOUND = new RegExp(
  [
    'not\\s+(?:be\\s+)?found',
    "(?:does\\s+not|doesn['’]?t)\\s+exist",
    `${NEG}\\s+(?:be\\s+)?(?:find|found|locate|located)`,
    'no\\s+(?:such\\s+|matching\\s+)?(?:resource|page|content)',
    "(?:is\\s*n['’]?t|is\\s+not|not)\\s+(?:available|present)",
    'non\\W?existent',
    'missing',
    'unavailable'
  ].join('|'),
  'i'
);
