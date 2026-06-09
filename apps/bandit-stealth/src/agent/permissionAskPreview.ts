import * as path from 'path';

import {
  buildCompactDiffBlock,
  describeToolForPrompt,
  lineDiffCounts,
  readFileSafe
} from '../helpers/formatting';

/**
 * Data shaped for the permission card the user sees when `evaluatePermission`
 * returns `'ask'`. Pure derivation of the card content — no IO beyond
 * `readFileSafe` reads of the workspace, no state, no card lifecycle. The
 * `beforeToolExecute` caller passes the result through to
 * `PermissionGateService.request()`.
 */
export interface PermissionAskPreview {
  description: string;
  bodyPreview: string | undefined;
  warning: string | undefined;
  diffStats: { added: number; removed: number } | undefined;
  command: string | undefined;
  paramsPreview: string | undefined;
}

/**
 * Build the card preview for an `ask` decision. Tool-specific shaping:
 *
 *  - `write_file` / `replace_range`: compact diff of the current file vs the
 *    proposed content, plus an added/removed line count. For `write_file`
 *    on a non-existent path, an edit-vs-create warning when the user's
 *    prompt suggested editing (the pburg-bowl regression — model invented
 *    `src/scoring/scoring.ts` instead of reading the search result that
 *    pointed at `src/utils/scoring.ts`).
 *  - `replace_range` with an out-of-bounds range: a warning instead of a
 *    diff (the preview can't compute a valid before/after).
 *  - `run_command`: the full `cmd + args` string surfaces as `command` so
 *    the user can audit pipes / flags / trailing args, not just the first
 *    token.
 *  - Everything else: a `paramsPreview` of the param key=value pairs
 *    (sans `content` for diff-rendered tools, sans non-scalar values,
 *    individual values clipped to 240 chars).
 */
export function buildPermissionAskPreview(
  name: string,
  params: Record<string, string>,
  workspaceRoot: string,
  userGoal: string
): PermissionAskPreview {
  const description = describeToolForPrompt(name, params.path ?? params.pattern ?? params.cmd ?? params.url ?? params.query ?? '', params);

  let bodyPreview: string | undefined;
  let warning: string | undefined;
  let diffStats: { added: number; removed: number } | undefined;

  if (name === 'write_file' && params.path) {
    const absPath = path.isAbsolute(params.path) ? params.path : path.resolve(workspaceRoot, params.path);
    const before = readFileSafe(absPath);
    const after = params.content ?? '';
    const fileExists = before !== '';
    if (before !== after) {
      bodyPreview = buildCompactDiffBlock(before, after, 8);
      const lines = bodyPreview.split('\n');
      let added = 0;
      let removed = 0;
      for (const l of lines) {
        if (l.startsWith('+') && !l.startsWith('+++')) {added++;}
        else if (l.startsWith('-') && !l.startsWith('---')) {removed++;}
      }
      diffStats = { added, removed };
    }
    if (!fileExists) {
      const promptText = userGoal.toLowerCase();
      const editIntent = /\b(update|edit|modify|change|fix|refactor|rewrite|rename|replace)\b/.test(promptText);
      const createIntent = /\b(create|new|add|generate|scaffold|bootstrap)\b/.test(promptText);
      if (editIntent && !createIntent) {
        warning = `This would CREATE a new file at \`${params.path}\`. Your prompt suggested editing an existing file — if that wasn't your intent, click "Deny with notes…" and point the agent at the correct path (e.g. try search_code for the right location).`;
      }
    }
  } else if (name === 'replace_range' && params.path) {
    const absPath = path.isAbsolute(params.path) ? params.path : path.resolve(workspaceRoot, params.path);
    const before = readFileSafe(absPath);
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const lines = before.split(eol);
    const startLine = parseInt(params.start_line ?? '', 10);
    const endLine = params.end_line !== undefined && params.end_line !== ''
      ? parseInt(params.end_line, 10)
      : startLine;
    if (before && Number.isFinite(startLine) && Number.isFinite(endLine) && startLine >= 1 && endLine >= startLine - 1 && startLine <= lines.length + 1 && endLine <= lines.length) {
      const replacementLines = (params.content ?? '') === '' ? [] : (params.content ?? '').split(/\r?\n/);
      const after = [
        ...lines.slice(0, startLine - 1),
        ...replacementLines,
        ...lines.slice(Math.max(startLine - 1, endLine))
      ].join(eol);
      if (before !== after) {
        bodyPreview = buildCompactDiffBlock(before, after, 8);
        const { plus, minus } = lineDiffCounts(before, after);
        diffStats = { added: plus, removed: minus };
      }
    } else {
      warning = `Bandit is targeting ${params.path}:${params.start_line ?? '?'}-${params.end_line ?? params.start_line ?? '?'}. The preview could not compute the range; review the params before approving.`;
    }
  }

  let command: string | undefined;
  let paramsPreview: string | undefined;
  if (name === 'run_command') {
    const cmdStr = typeof params.cmd === 'string' ? params.cmd : '';
    const argStr = typeof params.args === 'string' ? params.args : '';
    command = [cmdStr, argStr].filter((s) => s && s.length > 0).join(' ').trim() || undefined;
  } else {
    const paramLines: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {continue;}
      if (k === 'content' && (name === 'write_file' || name === 'replace_range')) {continue;}
      const str = String(v);
      const clipped = str.length > 240 ? str.slice(0, 237) + '…' : str;
      paramLines.push(`${k}: ${clipped}`);
    }
    if (paramLines.length > 0) {paramsPreview = paramLines.join('\n');}
  }

  return { description, bodyPreview, warning, diffStats, command, paramsPreview };
}
