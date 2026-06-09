/**
 * Tool-detail markdown formatter extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The body of `handleOpenToolDetail` was
 * mostly string assembly — pure data → markdown — with only the
 * cache lookup and document-open at the boundaries. Pulling the
 * formatter out leaves the class method to do the orchestration
 * (cache miss notification + open virtual doc) and lets the markdown
 * shape be unit-tested without VS Code in the loop.
 */

/**
 * Snapshot of a single tool-call's full input/output, captured at
 * tool_result time. The chat card only carries a 280-char snippet —
 * the detail Map keeps up to 64 KB so the user can scroll a long
 * `dotnet build` or `grep` result inline by clicking the card.
 */
export interface ToolCallDetail {
  tool: string;
  params?: Record<string, unknown> | null;
  cmd?: string;
  output: string;
  outputLength: number;
  isError: boolean;
  durationMs: number;
  at: number;
}

/**
 * Format a tool-call detail snapshot as markdown for the virtual
 * editor tab the chat opens when the user clicks a bandit-run /
 * bandit-tl card. Output gets fenced as plain ``` so language-aware
 * highlighting doesn't mis-render long shell traces.
 */
export function formatToolDetailMarkdown(detail: ToolCallDetail): string {
  const when = new Date(detail.at).toLocaleString();
  const durLabel = detail.durationMs >= 1000
    ? `${(detail.durationMs / 1000).toFixed(2)}s`
    : `${detail.durationMs}ms`;
  const sizeLabel = detail.outputLength >= 1024
    ? `${(detail.outputLength / 1024).toFixed(1)} KB`
    : `${detail.outputLength} chars`;
  const statusLine = detail.isError ? '❌  failed' : '✓  ok';

  const lines: string[] = [];
  lines.push(`# ${detail.tool}`);
  lines.push('');
  lines.push(`_${statusLine} · ${durLabel} · ${sizeLabel} · ${when}_`);
  lines.push('');
  if (detail.cmd) {
    lines.push('## Command');
    lines.push('');
    lines.push('```bash');
    lines.push(detail.cmd);
    lines.push('```');
    lines.push('');
  } else if (detail.params && Object.keys(detail.params).length > 0) {
    lines.push('## Parameters');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(detail.params, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Output');
  lines.push('');
  lines.push('```');
  lines.push(detail.output || '(empty)');
  lines.push('```');
  if (detail.output.length < detail.outputLength) {
    lines.push('');
    lines.push(
      `_Output truncated at ${detail.output.length.toLocaleString()} chars — ${(detail.outputLength - detail.output.length).toLocaleString()} more chars were captured by the tool but exceeded the 64 KB detail-view cap._`
    );
  }

  return lines.join('\n');
}
