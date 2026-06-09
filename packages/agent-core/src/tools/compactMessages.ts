/**
 * Message-history compaction for the tool-use loop.
 *
 * Why this exists:
 *   The loop appends every tool result as a `user` message carrying
 *   the raw output (read_file content, search_code hits, command
 *   stdout). After ~6 iterations on a medium-sized codebase the
 *   cumulative tool output is ~12-18k tokens — enough to push past
 *   the Ollama num_ctx ceiling on small/medium models, which causes
 *   silent front-truncation of the system prompt (the exact failure
 *   mode that made `bandit-core:12b-it-qat` appear to "refuse" C#
 *   edits until num_ctx was properly configured).
 *
 * Strategy (deterministic, no extra LLM calls):
 *   1. Count tokens with a cheap char/4 heuristic.
 *   2. If the total fits a configurable budget, return as-is.
 *   3. Otherwise, walk the message list from oldest to newest and
 *      replace the *body* of earlier tool-result messages with a
 *      one-line placeholder ("[read_file api/foo.cs — 412 lines, see
 *      earlier]"). We always keep the system prompt, the initial user
 *      prompt, the last N tool results in full, and any assistant
 *      message that contains a tool call (the model needs to see its
 *      own prior reasoning).
 *
 * The compacted messages retain the same `role` / `content` shape so
 * the loop doesn't need to change — it just passes them through chat.
 */

import type { ToolLoopMessage } from './tool-types';

export interface CompactionOptions {
  /** Target token budget. Defaults to 12000 (safe for 16k num_ctx). */
  tokenBudget?: number;
  /** Always keep the last N tool-result messages in full. Default 2. */
  keepRecentToolResults?: number;
  /** Character-to-token ratio for heuristic counting. Default 4. */
  charsPerToken?: number;
}

export interface CompactionReport {
  compacted: ToolLoopMessage[];
  /** Pre-compaction estimated token count. */
  beforeTokens: number;
  /** Post-compaction estimated token count. */
  afterTokens: number;
  /** How many messages were collapsed to placeholders. */
  messagesCompacted: number;
}

const DEFAULT_BUDGET = 12000;
// Bumped 2 → 4 (2026-05-06): keepRecent = 2 over-collapsed traces where
// the most recent two tool results were tiny (e.g. `check_task` returns
// 78 chars each). Trace 23-34Z went 30k → 3.5k tokens at iter 7 because
// the last two surviving in-full results were small `check_task` polls,
// and every substantive read got replaced with a 1-line placeholder.
// 4 keeps enough recent reads in full to give the model real working
// material on the next iteration without ballooning back over budget.
const DEFAULT_KEEP_RECENT = 4;
const DEFAULT_CPT = 4;

const TOOL_RESULT_PREFIX = '<tool_result name="';

/** Heuristic token count — good enough for budget checks. */
function estimateTokens(content: string, cpt: number): number {
  return Math.ceil(content.length / cpt);
}

function isToolResultMessage(msg: ToolLoopMessage): boolean {
  return msg.role === 'user' && msg.content.startsWith(TOOL_RESULT_PREFIX);
}

/**
 * Extract the tool name + first interesting line from a tool_result
 * envelope so the placeholder carries enough signal for the model to
 * know what it already saw.
 */
function summarizeToolResult(content: string): string {
  const nameMatch = content.match(/<tool_result name="([^"]+)"/);
  const toolName = nameMatch?.[1] ?? 'tool';
  // First non-tag line of the body.
  const bodyStart = content.indexOf('>');
  const body = bodyStart >= 0 ? content.slice(bodyStart + 1) : content;
  const firstLine = body.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const shortFirst = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
  const lineCount = body.split('\n').filter((l) => l.length > 0).length;
  return `<tool_result name="${toolName}">[earlier run, ${lineCount} lines elided — summary: ${shortFirst}]</tool_result>`;
}

/**
 * Main entry point. Returns compacted messages plus a report of what
 * changed. Callers can log the report so agents/CLIs can surface
 * "compacted history — N msgs, saved X tokens" as a status line.
 */
export function compactToolMessages(
  messages: ToolLoopMessage[],
  options: CompactionOptions = {}
): CompactionReport {
  const budget = options.tokenBudget ?? DEFAULT_BUDGET;
  const keepRecent = options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT;
  const cpt = options.charsPerToken ?? DEFAULT_CPT;

  const beforeTokens = messages.reduce((acc, m) => acc + estimateTokens(m.content, cpt), 0);
  if (beforeTokens <= budget) {
    return {
      compacted: messages,
      beforeTokens,
      afterTokens: beforeTokens,
      messagesCompacted: 0
    };
  }

  // Index tool-result messages so we can decide which to summarize.
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isToolResultMessage(messages[i])) {toolResultIndices.push(i);}
  }

  // Greedy compaction (2026-05-06): summarize OLDEST tool results first
  // and stop the moment we drop under budget. Previously we summarized
  // every tool result except the last `keepRecent` in one pass —
  // regardless of whether fewer summarizations would already fit. The
  // self-eval trace went 30k → 3.5k tokens at iter 7 because of that,
  // even though dropping the single oldest huge read would have been
  // enough to clear budget. Greedy keeps as much real context in front
  // of the model as possible.
  //
  // Floor: never summarize the most recent `keepRecent` tool results
  // even if we're still over budget after exhausting the older ones —
  // those go to the message-drop branch below instead.
  const minKeepInFull = Math.min(toolResultIndices.length, keepRecent);
  const summarizableIndices = toolResultIndices.slice(0, toolResultIndices.length - minKeepInFull);
  const summarized = new Set<number>();
  let estimatedAfter = beforeTokens;
  for (const idx of summarizableIndices) {
    if (estimatedAfter <= budget) {break;}
    const original = messages[idx].content;
    const summary = summarizeToolResult(original);
    estimatedAfter -= estimateTokens(original, cpt);
    estimatedAfter += estimateTokens(summary, cpt);
    summarized.add(idx);
  }

  const out: ToolLoopMessage[] = [];
  let messagesCompacted = 0;
  for (let i = 0; i < messages.length; i++) {
    if (summarized.has(i)) {
      out.push({ role: messages[i].role, content: summarizeToolResult(messages[i].content) });
      messagesCompacted++;
    } else {
      out.push(messages[i]);
    }
  }

  let afterTokens = out.reduce((acc, m) => acc + estimateTokens(m.content, cpt), 0);

  // Still over budget after compacting tool results? Drop the oldest
  // non-system, non-first-user messages until we fit. This is the
  // "last resort" branch — well within budget in normal usage.
  if (afterTokens > budget) {
    const systemIndices = new Set<number>();
    const firstUserIndex = out.findIndex((m) => m.role === 'user');
    out.forEach((m, i) => {
      if (m.role === 'system') {systemIndices.add(i);}
    });
    // Walk forward from iteration after the first user, drop messages
    // until budget fits or we hit the last two (needed for model state).
    let i = firstUserIndex + 1;
    while (afterTokens > budget && i < out.length - 2) {
      if (systemIndices.has(i)) {
        i++;
        continue;
      }
      const droppedTokens = estimateTokens(out[i].content, cpt);
      out.splice(i, 1);
      afterTokens -= droppedTokens;
      messagesCompacted++;
      // Don't advance i — splice shifted subsequent messages left.
    }
  }

  return {
    compacted: out,
    beforeTokens,
    afterTokens,
    messagesCompacted
  };
}
