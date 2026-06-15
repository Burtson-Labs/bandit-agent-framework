/**
 * Output-budget-aware batch dispatch for ToolUseLoop.runWithMessages.
 *
 * Takes a normalized batch (already trimmed by maxParallelTools +
 * dedup'd by `normalizeToolCallBatch`) and runs it. Two execution
 * modes:
 *
 *   Parallel (default): `Promise.all(toolCalls.map(dispatchOne))`.
 *
 *   Serial: when the estimated combined output of the batch would
 *   exceed `outputBudgetTokens * outputBudgetRatio`, the batch runs
 *   one tool at a time. Each call short-circuits on `signal.aborted`.
 *
 * Why the serial mode exists: smaller models (4B–12B) generate
 * malformed JSON in the tail of a multi-file emission once their
 * effective output budget is exhausted. on a
 * React/TS build — even a strong model produced a malformed
 * `todo_write` after writing four files of ~7 KB each in one
 * assistant turn. Serialising lets the model react to each result
 * before committing further output, and gives the user one approval
 * at a time instead of a queued pile.
 *
 * Single-call batches skip the threshold check entirely — there's no
 * parallel/serial distinction with one call, and the gate's purpose
 * is preventing a *batch* from overrunning the assistant turn.
 *
 * Token estimate is intentionally coarse (heavy payload fields × ¼).
 * Reads and small calls never trip the gate; only writes/edits whose
 * `content`/`replace`/`find`/`text` fields dominate the output budget.
 * Accuracy isn't the goal — order-of-magnitude is enough to gate.
 */
import type { ParsedToolCall } from '../tool-use-parser';
import type { ToolDispatchResult } from './singleToolExecute';

export type BatchEmit = (type: string, payload?: unknown) => void;

export interface ExecuteParallelBatchArgs {
  toolCalls: ParsedToolCall[];
  dispatchOne: (tc: ParsedToolCall) => Promise<ToolDispatchResult>;
  outputBudgetTokens: number;
  outputBudgetRatio: number;
  emit: BatchEmit;
  iteration: number;
  signal?: AbortSignal;
}

/**
 * Coarse token estimate for a single tool call's contribution to the
 * assistant turn's output. Heavy fields (file content, edit
 * replacements, apply_edit find/replace blocks) dominate; everything
 * else is negligible. Uses chars/4 as a rough byte→token approximation
 * — fast and good enough to gate batches; we don't need accuracy, just
 * an order-of-magnitude check.
 */
export function estimateToolCallOutputTokens(tc: { name: string; params: Record<string, string> }): number {
  const params = tc.params ?? {};
  const heavy = [params.content, params.replace, params.find, params.text]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .reduce((sum, s) => sum + s.length, 0);
  return Math.ceil(heavy / 4);
}

export async function executeParallelBatch(args: ExecuteParallelBatchArgs): Promise<ToolDispatchResult[]> {
  const { toolCalls, dispatchOne, outputBudgetTokens, outputBudgetRatio, emit, iteration, signal } = args;

  // Output-budget gate. Only meaningful for multi-call batches —
  // single-call iterations never have a parallel/serial choice.
  let serializeBatch = false;
  if (Number.isFinite(outputBudgetTokens) && toolCalls.length > 1) {
    let estimatedBatchOutputTokens = 0;
    for (const tc of toolCalls) {
      estimatedBatchOutputTokens += estimateToolCallOutputTokens(tc);
    }
    const threshold = outputBudgetTokens * outputBudgetRatio;
    if (estimatedBatchOutputTokens > threshold) {
      serializeBatch = true;
      emit('tool_loop:batch_serialized', {
        iteration,
        toolCount: toolCalls.length,
        estimatedTokens: estimatedBatchOutputTokens,
        budgetTokens: outputBudgetTokens,
        threshold: Math.floor(threshold),
        reason: 'output-budget-exceeded'
      });
    }
  }

  if (serializeBatch) {
    const results: ToolDispatchResult[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) {break;}
      results.push(await dispatchOne(tc));
    }
    return results;
  }

  return Promise.all(toolCalls.map(dispatchOne));
}
