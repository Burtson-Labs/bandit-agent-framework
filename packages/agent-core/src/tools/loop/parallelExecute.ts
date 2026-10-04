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
 * Same-file writes never race. In parallel mode, mutating file tools
 * (write_file, apply_edit, replace_range, apply_patch, delete_file) are
 * chained per resolved path, in call order: two apply_edit calls on one
 * file used to run concurrently, both read the original, both reported
 * "File saved", and only the last write survived (a lost update the model
 * then reported as success). Calls on different files, and every read-only
 * call, still run concurrently. An apply_patch locks every path it names;
 * a mutating call whose paths can't be determined waits for, and blocks,
 * every other mutating call in the batch.
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
  /**
   * Workspace root used to resolve relative tool paths into one lock key
   * per file (so `src/a.ts` and `<root>/src/a.ts` serialize together).
   */
  workspaceRoot?: string;
}

/** Tools that write files; same-file calls among these are serialized. */
export const MUTATING_FILE_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'apply_edit', 'replace_range', 'apply_patch', 'delete_file'
]);

/** Wildcard key: a mutating call whose target paths are unknown. */
const ANY_PATH = '*';

function normalizeKey(raw: string, workspaceRoot?: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('a/') || p.startsWith('b/')) {p = p.slice(2);} // unified-diff prefixes
  const isAbs = p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:\//.test(p);
  if (!isAbs && workspaceRoot) {p = `${workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`;}
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') {continue;}
    if (seg === '..') {out.pop(); continue;}
    out.push(seg);
  }
  const lead = p.startsWith('/') ? '/' : '';
  // Lower-cased: on case-insensitive filesystems two spellings are one file;
  // on case-sensitive ones this only ever serializes a little more.
  return (lead + out.join('/')).toLowerCase();
}

/** Paths an apply_patch touches: envelope headers, then unified-diff headers. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const env = /^\*\*\* (?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
    if (env) {paths.add(env[1]); continue;}
    const uni = /^(?:\+\+\+|---) (.+?)(?:\t.*)?\s*$/.exec(line);
    if (uni && uni[1] !== '/dev/null') {paths.add(uni[1]);}
  }
  return [...paths];
}

/**
 * Lock keys for one call: [] for calls that never write files, the resolved
 * target path(s) for file writers, or the wildcard when a writer's target
 * can't be determined.
 */
export function mutationKeys(tc: { name: string; params: Record<string, string> }, workspaceRoot?: string): string[] {
  if (!MUTATING_FILE_TOOLS.has(tc.name)) {return [];}
  const params = tc.params ?? {};
  const raw: string[] = [];
  const explicit = params.path ?? params.file ?? params.filepath ?? params.file_path;
  if (typeof explicit === 'string' && explicit.trim()) {raw.push(explicit);}
  if (tc.name === 'apply_patch') {
    const body = params.patch ?? params.input ?? '';
    if (typeof body === 'string') {raw.push(...patchPaths(body));}
  }
  if (raw.length === 0) {return [ANY_PATH];}
  return [...new Set(raw.map((r) => normalizeKey(r, workspaceRoot)))].sort();
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

  // Parallel, except same-file writes chain in call order. Each mutating call
  // waits for the previous call on every key it holds (a wildcard waits for
  // every earlier writer, and every later writer waits for it). Dependencies
  // only ever point at earlier calls, so the chains can't deadlock.
  const tails = new Map<string, Promise<unknown>>();
  let wildcardTail: Promise<unknown> | undefined;
  const settle = (p: Promise<unknown>): Promise<void> => p.then(() => undefined, () => undefined);
  const runs = toolCalls.map((tc) => {
    const keys = mutationKeys(tc, args.workspaceRoot);
    if (keys.length === 0) {return dispatchOne(tc);}
    const deps: Promise<unknown>[] = [];
    if (wildcardTail) {deps.push(wildcardTail);}
    if (keys.includes(ANY_PATH)) {
      deps.push(...tails.values());
    } else {
      for (const k of keys) {
        const prev = tails.get(k);
        if (prev) {deps.push(prev);}
      }
    }
    const run = deps.length === 0
      ? dispatchOne(tc)
      : Promise.all(deps.map(settle)).then(() => dispatchOne(tc));
    if (keys.includes(ANY_PATH)) {
      wildcardTail = run;
    } else {
      for (const k of keys) {tails.set(k, run);}
    }
    return run;
  });
  return Promise.all(runs);
}
