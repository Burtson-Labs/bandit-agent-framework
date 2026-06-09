/**
 * Per-tool execution closure for ToolUseLoop.runWithMessages.
 *
 * The dispatcher takes one ParsedToolCall and runs it end-to-end:
 *
 *  - Build a coarse signature for the repeat-call breaker (the model's
 *    "I'll just retry the same broken write 4 times in a row" failure
 *    mode). The window is `repeatLimit` calls; once all entries are
 *    identical, the dispatcher short-circuits with a stop-this-now error
 *    instead of running the tool.
 *  - Look up the tool in the registry. Unknown tool → error result.
 *  - Run the host's `beforeToolExecute` gate. Blocked → error result.
 *  - Execute the tool. On success: bump the success-only edit counter
 *    via `onEditToolSucceeded()` for file-editing tools, and record the
 *    touched file (normalized to basename) in `filesReadThisTurn` /
 *    `filesWrittenThisTurn`. On exception: catch + emit `tool_error`.
 *  - Emit `tool_execute` before invocation and `tool_result` (with a
 *    redacted output snippet) after.
 *
 * The factory captures all the per-turn deps in a closure and returns
 * a single async function. Mutable turn-state — `recentCallKeys`,
 * `filesReadThisTurn`, `filesWrittenThisTurn` — is passed by reference
 * so the dispatcher mutates the same objects the orchestrator (and the
 * loop's detector pipeline) read.
 *
 * The success-only edit counter (`editToolsInvoked` in the orchestrator)
 * has multiple downstream readers (false-completion detector, wrap-up
 * template chooser), so it's routed through `onEditToolSucceeded` rather
 * than incremented directly here.
 */
import type { ParsedToolCall } from '../tool-use-parser';
import type { ToolExecutionContext, ToolResult } from '../tool-types';
import type { ToolRegistry } from '../tool-registry';
import { applySecretRedactionIfEnabled } from '../tool-use-parser';

export type DispatchEmit = (type: string, payload?: unknown) => void;
export type BeforeToolExecuteFn = (
  call: { name: string; params: Record<string, string> }
) => Promise<{ allow: boolean; reason?: string }> | { allow: boolean; reason?: string };

export interface ToolDispatchDeps {
  registry: ToolRegistry;
  ctx: ToolExecutionContext;
  beforeToolExecute: BeforeToolExecuteFn;
  emit: DispatchEmit;
  /** Mutable turn-state — rolling window of recent call signatures. */
  recentCallKeys: string[];
  /** Cap on the rolling window; identical keys filling it trip the breaker. */
  repeatLimit: number;
  /** Mutable set of basenames read this turn (used by false-completion detector). */
  filesReadThisTurn: Set<string>;
  /** Mutable set of basenames written this turn. */
  filesWrittenThisTurn: Set<string>;
  /** Predicate identifying file-editing tools (write/apply_edit/replace_range). */
  isFileEditTool: (name: string) => boolean;
  /** Called once per successful file-editing tool result. Hosts use this
   * to bump the `editToolsInvoked` counter that gates false-completion
   * nudges and wrap-up template selection. */
  onEditToolSucceeded: () => void;
}

export type ToolDispatchResult = { name: string; output: string; isError?: boolean };

export function createToolDispatcher(deps: ToolDispatchDeps): (tc: ParsedToolCall) => Promise<ToolDispatchResult> {
  const {
    registry,
    ctx,
    beforeToolExecute,
    emit,
    recentCallKeys,
    repeatLimit,
    filesReadThisTurn,
    filesWrittenThisTurn,
    isFileEditTool,
    onEditToolSucceeded
  } = deps;

  return async function dispatchOne(tc: ParsedToolCall): Promise<ToolDispatchResult> {
    // Build a coarse signature for repeat detection. For file-writing
    // tools (write_file, apply_edit, replace_range) we key on path + a short hash of
    // the find/replace/content so we catch "same edit retried with
    // same payload" (the original target — model corrupted a write
    // and is looping) WITHOUT flagging "8 different edits to the
    // same file" (legitimate batch refactor — // on S3Api with gpt-oss commenting all methods in one .cs file).
    // For other tools we fall back to a truncated JSON of the params
    // so unrelated calls don't collide.
    const pathish = tc.params.path ?? tc.params.file ?? tc.params.filepath;
    const isEditTool = tc.name === 'apply_edit' || tc.name === 'replace_range' || tc.name === 'write_file';
    let callKey: string;
    if (pathish && isEditTool) {
      // Cheap deterministic hash of the payload — enough to
      // distinguish 8 different edits to the same file. Not
      // crypto, just collision-resistant for a window of 3 calls.
      const payload = `${tc.params.find ?? ''}::${tc.params.replace ?? ''}::${tc.params.content ?? ''}::${tc.params.start_line ?? ''}::${tc.params.end_line ?? ''}`;
      let h = 0;
      for (let i = 0; i < payload.length; i++) {
        h = (h * 31 + payload.charCodeAt(i)) | 0;
      }
      callKey = `${tc.name}::${pathish}::${h.toString(36)}`;
    } else if (pathish) {
      callKey = `${tc.name}::${pathish}`;
    } else {
      callKey = `${tc.name}::${JSON.stringify(tc.params).slice(0, 160)}`;
    }
    recentCallKeys.push(callKey);
    if (recentCallKeys.length > repeatLimit) {recentCallKeys.shift();}
    if (
      recentCallKeys.length === repeatLimit &&
      recentCallKeys.every((k) => k === callKey)
    ) {
      emit('tool_loop:repeat_breaker', { name: tc.name, key: callKey });
      return {
        name: tc.name,
        output: `Loop detected: ${tc.name} has been invoked ${repeatLimit} times in a row against the same target (${pathish ?? 'identical params'}) without progress. This usually means the last write landed malformed — most often an unescaped \`"\` inside the JSON content string truncated the file. STOP retrying. Either (a) produce a final answer that explains the issue to the user, or (b) break the content into smaller edits. Do not call ${tc.name} with these params again.`,
        isError: true
      };
    }
    const tool = registry.get(tc.name);
    if (!tool) {
      emit('tool_loop:tool_not_found', { name: tc.name });
      return { name: tc.name, output: `Error: tool "${tc.name}" is not registered.`, isError: true };
    }
    // Also surface the RAW tool_call block (first 400 chars) so
    // observers can diagnose parser-edge cases. When a param
    // extraction goes wrong (unknown wrapper key, nested array,
    // etc.) the isError result is the symptom; the raw block is
    // the evidence. Without it, debugging an empty-params call
    // requires re-running with extra instrumentation.
    //
    // NOTE: the edit-tool counter is incremented inside the try
    // block below, AFTER the result returns and only when
    // `!result.isError`. Counting attempts (which an earlier
    // version did at this point) made the false-completion
    // detector blind to the worst variant of the hallucination:
    // model fires 8 apply_edits, every single one fails with
    // "find not found", model produces a confident "I have
    // fixed the bug" summary. The counter said 8, the detector
    // saw a non-zero count, the user read the lie. Observed
    // 2026-05-01 on the bandit website's plans.tsx grid bug.
    emit('tool_loop:tool_execute', {
      name: tc.name,
      params: tc.params,
      rawSnippet: tc.raw.slice(0, 400)
    });
    const gate = await beforeToolExecute({ name: tc.name, params: tc.params });
    if (!gate.allow) {
      const reason = gate.reason ?? 'blocked by pre-execute guard';
      emit('tool_loop:tool_blocked', { name: tc.name, reason });
      return { name: tc.name, output: `Blocked: ${reason}`, isError: true };
    }
    try {
      const result: ToolResult = await tool.execute(tc.params, ctx);
      // Only count edits that actually landed. A `find`-not-found
      // or schema-rejected edit returns isError:true and changed
      // nothing on disk; counting it would let the false-
      // completion detector wave through "I have fixed the bug"
      // claims that are false.
      const normalizeFilePath = (raw: unknown): string | null => {
        if (typeof raw !== 'string' || !raw) {return null;}
        // Use basename so `src/App.jsx` and `~/proj/src/App.jsx`
        // collide — the user's goal text typically uses the bare
        // filename so a basename comparison is the most forgiving
        // way to ask "did we touch the file the user named?".
        const parts = raw.split(/[/\\]/);
        return parts[parts.length - 1].toLowerCase();
      };
      if (isFileEditTool(tc.name) && !result.isError) {
        onEditToolSucceeded();
        const p = (tc.params as Record<string, unknown>)?.path;
        const norm = normalizeFilePath(p);
        if (norm) {filesWrittenThisTurn.add(norm);}
      }
      if (tc.name === 'read_file' && !result.isError) {
        const p = (tc.params as Record<string, unknown>)?.path;
        const norm = normalizeFilePath(p);
        if (norm) {filesReadThisTurn.add(norm);}
      }
      // Include a short output snippet in the event — critical for
      // downstream observers (eval runner, turn log) to know WHY
      // a tool errored rather than just THAT it did. Capped so long
      // successful results don't flood the event bus.
      //
      // outputSnippet is rendered to the host UI (tool
      // cards in the extension, dim recap in the CLI). Redact
      // before emitting so the user's terminal scrollback doesn't
      // capture raw secrets even when the model's context
      // already has the redacted version. The model-facing path
      // goes through buildToolResultsMessage → formatToolResult,
      // which already applies the same redactor at the parser
      // boundary, so both paths converge on the same masked text.
      emit('tool_loop:tool_result', {
        name: tc.name,
        isError: result.isError,
        outputLength: result.output.length,
        outputSnippet: applySecretRedactionIfEnabled(result.output.slice(0, 280))
      });
      return { name: tc.name, output: result.output, isError: result.isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit('tool_loop:tool_error', { name: tc.name, error: msg });
      return { name: tc.name, output: `Error executing tool "${tc.name}": ${msg}`, isError: true };
    }
  };
}
