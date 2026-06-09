/**
 * Text-based tool use execution loop.
 *
 * Implements the observe → act → replan cycle for models that don't support
 * native function calling (gemma3, bandit-core, qwen2.5-coder, etc.).
 *
 * Flow:
 * 1. Build messages with tool definitions in system prompt
 * 2. Stream response from LLM, aggregate full text
 * 3. Parse <tool_call> blocks
 * 4. Execute tools via ToolExecutionContext
 * 5. Inject <tool_result> blocks as next user message
 * 6. Repeat from step 2 until no tool calls, or max iterations reached
 * 7. Return final model response (the one with no tool calls)
 *
 * For models WITH native tool calling (qwen2.5-coder:32b, llama3.1),
 * the host should use the Ollama `tools: [...]` field instead.
 */

import type { ToolExecutionContext, ChatFn, ToolLoopMessage } from './tool-types';
import type { ToolRegistry } from './tool-registry';
import { parseToolCalls, hasToolCalls, buildToolResultsMessage, looksLikeAttemptedToolCall, stripToolCallMarkup, hasFabricatedToolResult, applySecretRedactionIfEnabled } from './tool-use-parser';
import { normalizeToolCallBatch } from './loop/toolCallNormalize';
import { createToolDispatcher } from './loop/singleToolExecute';
import { resolveTurnGoal } from './loop/turnSetup';
import { streamAndAggregate } from './loop/llmStream';
import { applyCompactionIfNeeded } from './loop/compactionTrigger';
import { executeParallelBatch } from './loop/parallelExecute';
import { applyGoalAnchorIfNeeded } from './loop/goalAnchor';
import { tryAnnounceIntentNudge, tryAskUserNudge } from './loop/finalAnswerNudges';
import { detectFalseToolAbsence, buildToolAvailabilityNudge } from './toolAvailabilityDetector';

const FILE_EDIT_TOOL_NAMES = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch']);

function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOL_NAMES.has(name);
}

export interface ToolUseLoopOptions {
  /** Maximum number of tool call rounds before forcing a final answer. Default: 10. */
  maxIterations?: number;
  /**
   * When true, the loop passes the registry's tool schemas to `chat()`
   * via the native-tools channel and SKIPS injecting the XML-style tool
   * block into the system prompt. The caller is responsible for only
   * setting this when the target model advertises `supportsToolCalling`
   * (Qwen2.5-Coder, Llama 3.1+, Devstral, DeepSeek-Coder-V2+, etc.).
   * Saves ~1500-3000 tokens per turn — the schemas live in the model's
   * own chat template instead of the content payload.
   */
  nativeTools?: boolean;
  /**
   * When nativeTools is enabled, retryable upstream failures can be
   * degraded to Bandit's text-tool protocol for the current turn. This
   * is useful for open-model native parsers that occasionally 500 on an
   * incomplete tool envelope. Defaults to true.
   */
  nativeToolFailureFallback?: boolean;
  /** Called on each event for external observability (streaming UI updates, telemetry). */
  emitEvent?: (type: string, payload?: unknown) => void;
  /**
   * Called at the START of each iteration (before `tool_loop:llm_start`)
   * to fetch any messages the host wants injected into the conversation
   * before this iteration's LLM call. Returned messages are appended to
   * the running conversation in order.
   *
   * The motivating use case (v1.7.336+) is mid-turn delivery of completed
   * background subagent synopses: today the parent agent has to either
   * (a) poll `check_task` in a tight loop wasting iterations, or (b) wait
   * until the next user prompt for `drainBackgroundCompletions` to
   * inject the synopsis. With this hook, the host's backgroundStore
   * subscription pushes completed synopses into a queue, this callback
   * drains the queue per iteration, and the parent sees completions
   * AS THEY HAPPEN instead of after a multi-minute poll loop.
   *
   * Other valid uses: async-event interrupts (file watcher pushing a
   * "file changed" notice into a long-running review turn), external
   * signal injection (user types `/note <fact>` mid-turn — the note
   * lands here before the next iteration sees it), etc.
   *
   * Empty array or `undefined` return = nothing to inject this tick.
   * Cheap to call — runs once per iteration, no significant perf cost.
   */
  drainExternalMessages?: () => ToolLoopMessage[] | undefined;
  /**
   * Guard called immediately before a tool executes. Return `{ allow: false, reason }`
   * to abort the call — the model sees the reason as the tool result and can replan.
   * Used by hosts to enforce PreToolUse hooks / permission gates.
   */
  beforeToolExecute?: (call: { name: string; params: Record<string, string> }) =>
    | Promise<{ allow: boolean; reason?: string }>
    | { allow: boolean; reason?: string };
  /**
   * Token budget for the chat messages passed to the provider on each
   * iteration. When the accumulated tool-result history would exceed
   * this, older tool results get collapsed to one-line placeholders.
   * Defaults to ~75% of a 16k num_ctx (12000 tokens).
   *
   * Set higher on large models (e.g. 24000 for 32k num_ctx). Set to
   * Infinity to disable compaction.
   */
  messageTokenBudget?: number;
  /**
   * Cooperative cancellation. When the host aborts this signal the loop
   * stops streaming the current iteration, skips remaining iterations,
   * and returns whatever has been gathered so far with `cancelled: true`
   * on the result. The chat function should also honour the same signal
   * to abort the underlying provider request — without that, the model
   * keeps generating tokens server-side and the user pays for output
   * they've already dismissed. Without a signal, cancel is best-effort
   * (loop won't abort mid-stream).
   */
  signal?: AbortSignal;
  /**
   * Hard cap on tool calls executed in a single iteration. Models in a
   * panic state ( with gpt-oss:120b on H100 against
   * a real repo) emit 20+ tool calls in one parallel batch — most of
   * them duplicate searches with slightly different globs. Capping
   * forces the model to commit to its top N picks; the rest are
   * dropped and the model is told to narrow its query. Default 8.
   */
  maxParallelTools?: number;
  /**
   * Hard cap on total tool calls executed across the full turn.
   * Independent of `maxIterations` because a single iteration can fire
   * many calls in parallel. Hitting this terminates the loop with
   * `hitLimit: true`. Default 60.
   */
  maxTotalTools?: number;
  /**
   * Approximate per-turn output token budget for the model. When the
   * combined estimated output of write/edit calls in a single batch
   * exceeds `outputBudgetTokens * outputBudgetRatio`, the loop falls
   * back to serial execution for that batch — one call at a time, in
   * order — instead of `Promise.all`. Reads stay parallel because
   * their contribution to the assistant turn's output is negligible.
   *
   * Why: smaller models (4B–12B) generate malformed JSON in the tail
   * of a multi-file emission once their effective output budget is
   * exhausted. on a portfolio build — even a
   * strong model produced a malformed `todo_write` after writing four
   * files of ~7 KB each in one assistant turn. Serialising lets the
   * model react to each result before committing further output, and
   * gives the user one approval at a time instead of a queued pile.
   *
   * Leave undefined or set to `Infinity` for capable hosted models —
   * the gate won't trip and parallel writes go through unchanged.
   */
  outputBudgetTokens?: number;
  /**
   * Fraction of `outputBudgetTokens` the batch may occupy before
   * serialisation kicks in. Default 0.6 — leaves 40% headroom for the
   * surrounding reasoning/prose the model emits alongside the calls.
   */
  outputBudgetRatio?: number;
  /**
   * True when this loop instance is running a subagent (spawned via the
   * `task` tool), rather than the user-facing parent agent. Subagents
   * are spawned to GATHER information for a specific goal — they MUST
   * call tools to make progress; producing prose-only output on the
   * first iteration is always a stall, not a legitimate final answer.
   *
   * When set, an extra detector forces a tool call on iter 0: if the
   * model's first response has no tool calls AND no other detector
   * (announce-intent, narrate, etc.) caught the stall, push a corrective
   * user message demanding a tool call before treating the response as
   * final. bandit-logic emits reasoning + neutral
   * prose on iter 0 of subagent runs, the existing detectors don't fire
   * because the prose isn't forward-looking ("Let me X") and the verb
   * whitelist doesn't match, and the loop returns a 0-iteration result
   * that the parent can't use.
   */
  isSubagent?: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableLlmError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === 'USER_ABORT') {return false;}

  const message = getErrorMessage(error);
  if (/\b429\b|rate limit/i.test(message)) {return false;}

  return (
    code === 'WATCHDOG' ||
    /\b5\d\d\b/.test(message) ||
    /Upstream model request failed/i.test(message) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|terminated|UND_ERR/i.test(message)
  );
}

export function tagRetryableLlmError(error: unknown): void {
  if (error instanceof Error) {
    const tagged = error as Error & { code?: string };
    if (!tagged.code) {tagged.code = 'UPSTREAM_MODEL';}
  }
}

export function summarizeLlmError(error: unknown): string {
  const message = getErrorMessage(error).replace(/\s+/g, ' ').trim();
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}

/**
 * Detects "keep going" / "continue" / "yes" style prompts that
 * carry no real goal content. The goal-anchor block uses the most recent
 * user message as the recall text; when that text is "good lets keep
 * going" the anchor degenerates into "remind yourself to keep going",
 * which gives the model nothing to anchor on after 20 iterations of
 * drift. Real on a 60-iteration linter-fix
 * turn: every anchor injection cited "good lets keep going" as the
 * goal. Detector lets callers walk back to a prior substantive prompt
 * instead.
 *
 * Length cap (60 chars) + normalized-phrase match keeps false positives
 * down — a sentence like "keep going on the auth refactor for the
 * user-service" is longer than 60 chars and reads as a real goal, so it
 * stays a goal.
 */
const CONTINUATION_PROMPT_PHRASES = new Set([
  'continue', 'keep going', 'go on', 'proceed', 'next', 'more',
  'please continue', 'carry on', 'finish', 'finish it', 'finish up', 'wrap up', 'wrap it up',
  'good', 'great', 'nice', 'cool', 'sweet', 'perfect', 'ok', 'okay', 'k', 'yes', 'y', 'yep', 'yeah', 'ack', 'done',
  "let's continue", 'lets continue', "let's keep going", 'lets keep going',
  'good keep going', 'good lets keep going', "good let's keep going",
  'good continue', 'ok continue', 'okay continue'
]);

export function isContinuationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) {return false;}
  // Normalize: lowercase, drop non-word/space punctuation, collapse whitespace.
  const norm = trimmed
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (CONTINUATION_PROMPT_PHRASES.has(norm)) {return true;}
  // Permit "please <phrase>" and "<phrase> please" wrappings.
  for (const phrase of CONTINUATION_PROMPT_PHRASES) {
    if (norm === `please ${phrase}` || norm === `${phrase} please`) {return true;}
  }
  return false;
}

/**
 * "Noticing prompt" detector. Catches user messages that are asking
 * about state ("are we using these?", "did you update X?", "where's
 * the…?", "isn't Y supposed to be…?") rather than requesting new
 * work. These signal that the user spotted a gap in the prior turn
 * and wants the agent to address it — NOT continue the prior plan.
 *
 * Real failure mode captured 2026-05-25 on a Portfolio React refactor:
 * user asked "I dont think we actually are using these new files are
 * we?" after the agent wrote data files but never wired them into
 * App.jsx. Bandit read the question as a generic "keep going" prompt,
 * wrote 5 MORE new component files, still didn't touch App.jsx. The
 * pivot signal was right there in the prompt shape and got missed.
 *
 * The check is conservative: short prompts only, must START with a
 * recognizable question/concern stem (so "is X working?" matches but
 * "is this the right approach to X" does not), no length cap above
 * 220 chars since longer messages usually contain a real request
 * rather than a pure noticing question.
 */
export function isNoticingPrompt(text: string): boolean {
  const trimmed = (text || '').trim();
  if (trimmed.length === 0 || trimmed.length > 220) {return false;}
  const norm = trimmed.toLowerCase().replace(/[^\w\s'?-]/g, ' ').replace(/\s+/g, ' ').trim();
  // Stems that introduce a noticing/clarifying question. Anchored to
  // the start of the message so a paragraph mentioning "are we"
  // mid-text doesn't false-positive.
  const STEMS = [
    /^(?:i\s+)?(?:dont|don't|do\s+not)\s+(?:think|see)\s/,    // "I dont think…", "I don't see…"
    /^are\s+we\s/,                                              // "are we using…"
    /^did\s+(?:you|we)\s/,                                      // "did you remember to…"
    /^didn't\s+(?:you|we)\s/,                                   // "didn't you say…"
    /^did\s+(?:you|we)\s+(?:miss|forget|skip|overlook)\b/,
    /^isn'?t\s+(?:this|that|it|there)\s/,                       // "isn't this missing…"
    /^shouldn'?t\s+(?:this|that|it|there|we)\s/,                // "shouldn't we…"
    /^why\s+(?:didn'?t|isn'?t|aren'?t|doesn'?t|don'?t)\s/,      // "why isn't X happening"
    /^where(?:'s|\s+is|\s+are|\s+did)\s/,                       // "where is the import", "where's the …"
    /^what\s+(?:about|happened\s+to)\s/,                        // "what about App.jsx"
    /^(?:i\s+thought\s+)?you\s+(?:said|were|are)\s+(?:supposed|going|gonna)/,
    /^this\s+doesn'?t\s/,                                       // "this doesn't look right"
    /^that\s+doesn'?t\s/,
    /^hmm\b|^huh\b/,
    /^wait\b/,                                                  // "wait — what about Y?"
    /^(?:i'?m|am\s+i)\s+(?:missing|seeing|reading)\b/,
  ];
  if (!STEMS.some((re) => re.test(norm))) {return false;}
  // Has to contain a question mark OR a concern modal. Lots of false
  // matches without — e.g. "are we" mid-sentence in a feature request.
  const hasQuestion = trimmed.includes('?');
  const hasConcernModal = /\b(?:should|need\s+to|supposed\s+to|expected|missing|wrong|broken|stuck)\b/i.test(trimmed);
  return hasQuestion || hasConcernModal;
}

export interface ToolUseResult {
  /** The model's final response (after all tool calls are resolved). */
  finalResponse: string;
  /** Number of tool call rounds executed. */
  iterations: number;
  /** All messages in the conversation including tool results. */
  messages: ToolLoopMessage[];
  /** Whether the loop ended due to reaching maxIterations. */
  hitLimit: boolean;
  /** Whether the loop terminated because options.signal was aborted. */
  cancelled?: boolean;
}

export class ToolUseLoop {
  private readonly maxIterations: number;
  private readonly defaultOptions: ToolUseLoopOptions;
  private readonly defaultEmit: NonNullable<ToolUseLoopOptions['emitEvent']>;
  private readonly defaultBeforeToolExecute: NonNullable<ToolUseLoopOptions['beforeToolExecute']>;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly ctx: ToolExecutionContext,
    options: ToolUseLoopOptions = {}
  ) {
    this.defaultOptions = options;
    this.maxIterations = options.maxIterations ?? 10;
    this.defaultEmit = options.emitEvent ?? (() => undefined);
    this.defaultBeforeToolExecute = options.beforeToolExecute ?? (() => ({ allow: true }));
  }

  /**
   * Run the tool use loop.
   *
   * @param userGoal The original user request (becomes the first user message).
   * @param chat A streaming chat function — returns an async iterable of text chunks.
   * @param systemPrompt Optional base system prompt. Tool definitions are appended to it.
   * @param options Per-call options (emitEvent override, etc.)
   */
  async run(
    userGoal: string,
    chat: ChatFn,
    systemPrompt?: string,
    options?: ToolUseLoopOptions
  ): Promise<ToolUseResult> {
    return this.runWithMessages(
      [{ role: 'user', content: userGoal }],
      chat,
      systemPrompt,
      options
    );
  }

  /**
   * Run the tool use loop seeded with prior conversation messages.
   * Use this for REPL-style hosts that want to preserve multi-turn context;
   * the caller supplies the full user/assistant history (no system message —
   * the loop prepends its own system prompt with tool definitions).
   */
  async runWithMessages(
    seedMessages: ToolLoopMessage[],
    chat: ChatFn,
    systemPrompt?: string,
    options?: ToolUseLoopOptions
  ): Promise<ToolUseResult> {
    const effectiveOptions: ToolUseLoopOptions = { ...this.defaultOptions, ...options };
    const emit = effectiveOptions.emitEvent ?? this.defaultEmit;
    // soft/hard cap split. `max` is now mutable so the loop
    // can extend it when the model is making clear progress. The hard
    // ceiling is `2 * initialMax` (40 by default) — beyond that we
    // always wrap up regardless of how healthy the iteration looked.
    // a real turn was patching 17 implicit-any
    // errors one apply_edit per iteration, exhausted the 20-cap with
    // 5 errors outstanding even though every iteration was succeeding
    // and no loop-detection nudges had fired. Letting the model
    // continue when it's clearly making progress is the right move.
    let max = effectiveOptions.maxIterations ?? this.maxIterations;
    const initialMax = max;
    const hardCap = Math.max(initialMax * 2, initialMax + 20);
    const CAP_EXTENSION_SIZE = 10;
    const MAX_CAP_EXTENSIONS = 2;
    let iterationCapExtensions = 0;
    // Healthy-progress signal: track whether each of the last N iterations
    // produced any tool calls. Rolling window of 5. Empty iterations
    // (parse failures, prose-only responses) push `false`; productive
    // iterations push `true`. Extension only fires when all 5 are true.
    const recentIterationsHadTools: boolean[] = [];
    const RECENT_HEALTH_WINDOW = 5;
    const beforeToolExecute = effectiveOptions.beforeToolExecute ?? this.defaultBeforeToolExecute;
    const signal = effectiveOptions.signal;
    const maxParallelTools = Math.max(1, effectiveOptions.maxParallelTools ?? 8);
    const maxTotalTools = Math.max(1, effectiveOptions.maxTotalTools ?? 60);
    const outputBudgetTokens = effectiveOptions.outputBudgetTokens ?? Infinity;
    const outputBudgetRatio = effectiveOptions.outputBudgetRatio ?? 0.6;
    let totalToolsExecuted = 0;
    const buildCancelledResult = (msgs: ToolLoopMessage[], iter: number, finalText = ''): ToolUseResult => ({
      finalResponse: finalText || '[cancelled]',
      iterations: iter,
      messages: msgs,
      hitLimit: false,
      cancelled: true
    });

    let nativeTools = effectiveOptions.nativeTools ?? false;
    const nativeToolFailureFallback = effectiveOptions.nativeToolFailureFallback ?? true;
    let nativeFallbackUsed = false;
    // One-shot outer-layer retry on the text channel after the native
    // channel switched. The inner same-channel retry layer covers the
    // common transient blip case, but a sustained native failure forces
    // the channel switch; if the first text call ALSO hits a transient
    // blip (gateway flapping, ollama still recovering from load), the
    // previous code path threw `Upstream model request failed` straight
    // to the user with no recovery. This flag lets the outer catch
    // re-enter `streamAndAggregate` exactly once more on the text channel
    // before declaring the turn dead. Addresses the "double-failure path
    // is still terminal" gap.
    let textFallbackRetryUsed = false;
    // One-shot final attempt: after every prior retry slot is spent,
    // push a clean re-anchor message that re-states the original user
    // goal and retry once more. Sometimes a mid-stream replay can't
    // recover (the model is anchored on a half-emitted tool_call
    // payload or a partial reasoning block) but a fresh anchor with
    // explicit "this is a recovery attempt — answer the original goal"
    // framing succeeds. Last resort before terminal throw.
    let finalAnchorRetryUsed = false;
    const textToolBlock = this.registry.buildSystemPromptBlock();
    const buildFullSystemPrompt = (useNativeTools: boolean): string => {
      if (useNativeTools) {return systemPrompt ?? '';}
      return systemPrompt
        ? `${systemPrompt}\n\n${textToolBlock}`
        : textToolBlock;
    };
    let nativeSchemas = nativeTools ? this.registry.buildNativeToolsSchema() : undefined;

    const messages: ToolLoopMessage[] = [];
    const initialSystemPrompt = buildFullSystemPrompt(nativeTools);
    if (initialSystemPrompt) {
      messages.push({ role: 'system', content: initialSystemPrompt });
    }
    // Capture the most recent user message (the actual goal of THIS turn,
    // not earlier conversation turns). Used by the goal-anchor reminder
    // below when the model is about to generate its final answer — long
    // tool-result chains push the original question down the attention
    // window and the model can drift to a related-but-different topic.
    // Walks back through continuation tokens ("keep going", "yes") to
    // the most recent SUBSTANTIVE prompt. See loop/turnSetup.ts.
    const { originalGoal, priorUserPromptCount } = resolveTurnGoal({ seedMessages });
    // Track the iteration we last anchored on rather than a boolean
    // so we can re-fire when the model pivots AGAIN later in a long
    // turn. -1 means "never anchored." Re-fire is gated by the
    // GOAL_ANCHOR_REFIRE_GAP below to avoid hammering on a model
    // that's working steadily — only fires again when the loop has
    // continued without resolution for several more iterations.
    let lastGoalAnchorIteration = -1;
    for (const msg of seedMessages) {
      if (msg.role === 'system') {continue;}
      messages.push(msg);
    }

    // Noticing-prompt pivot hint. When the most-recent user message
    // looks like a noticing/clarifying question ("are we using these?",
    // "did you remember X?", "where's the…?"), inject a one-time
    // synthetic user-role hint instructing the model to address the
    // implicit gap BEFORE continuing any prior plan. Without this the
    // model often reads such prompts as generic "keep going" signals
    // and continues scaffolding work the user just paused them on.
    // One-shot per turn — only fires on this first pass.
    if (originalGoal && isNoticingPrompt(originalGoal)) {
      emit('tool_loop:noticing_prompt_hint', {
        promptPreview: originalGoal.slice(0, 200)
      });
      messages.push({
        role: 'user',
        content:
          '[Reading-comprehension note for the assistant: the user\'s last message above is a noticing / clarifying question — they spotted a possible gap from prior turns and are asking you to confirm or correct, NOT to continue any prior plan. Before you take any new action, identify what gap the question points at and address it directly. If the question is "are we using X?" the correct first move is to verify whether X is actually being used (read the consumer file, grep for the import, check the call site) and answer honestly — yes/no with evidence. Do NOT create more new artifacts unless the user explicitly says to.]'
      });
    }

    let iterations = 0;
    let hitLimit = false;
    let consecutiveEmptyRetries = 0;
    // Per-retry-path budgets. Keeping these separate from
    // consecutiveEmptyRetries (which resets on any non-empty response)
    // prevents an infinite retry when a model repeatedly emits the
    // SAME malformed tool_call — the S3Api pburg workspace (Apr 22)
    // ran 10+ iterations at iteration=2 because each 30s malformed
    // apply_edit response reset consecutiveEmptyRetries to 0 and the
    // parse-retry counter got to fire again. Caps are per-turn (not
    // per-iteration) so the model genuinely exhausts its attempts
    // before we give up.
    let parseRetries = 0;
    let fakeToolResultRetries = 0;
    let toolAbsenceCorrectionsFired = 0;
    let toolErrorRecoveryFired = 0;
    let lastIterationHadToolError = false;
    const PARSE_RETRY_CAP = 2;
    const FAKE_TOOL_RESULT_CAP = 2;
    const TOOL_ABSENCE_CORRECTION_CAP = 1;
    const TOOL_ERROR_RECOVERY_CAP = 1;
    // Hard turn-level cap on responses that produced no tool_call. The
    // individual detectors (empty_retry, narrate-no-action, tool_error
    // recovery, etc.) each have their own caps, but they can chain — a
    // model can spin through 6+ no-tool-call responses because
    // thinking-off recovery resets consecutiveEmptyRetries=0. Captured
    // 2026-05-26 in Mark's Portfolio session (turn-2026-05-26T02-30-37):
    // model emitted 6 sequential reasoning-only responses inside
    // iteration 4 before the loop finally terminated with a useless
    // final answer ("I need to stop wrapping tool calls in reasoning
    // blocks"). This counter doesn't reset on detector firings — when
    // it hits the cap, the loop terminates with a final answer that
    // names the stuck state so the user knows what to retry with.
    let noToolCallAttemptsThisTurn = 0;
    // 4 → 5 (Jun 2026): make room for prefill_recovery after the existing
    // empty_retry ×2 + thinking_off_recovery sequence. The new ordering is
    //   1. empty_retry (consec=1)
    //   2. empty_retry (consec=2)
    //   3. thinking_off_recovery (force think:false)
    //   4. prefill_recovery (push `<tool_call>{"name":"` as assistant prefill)
    //   5. hard cap → stuck answer
    // Prefill is qualitatively different from the prior steps — it forces
    // the model into an envelope-opened state so it can't terminate at the
    // reasoning fence — and is the highest-leverage recovery slot for the
    // qwen3.6 "stops after fence close" failure mode.
    const NO_TOOL_CALL_HARD_CAP = 5;
    // One-shot recovery: when consecutive reasoning-only retries exhaust
    // (the model is stuck thinking and never emits content or tool_calls),
    // make ONE final attempt with thinking forced OFF. Observed
    // 2026-04-26 with qwen3.6:27b on remote Ollama — thinking-on stalled
    // intermittently while bandit-logic on the home cluster (same model,
    // different serving stack) worked fine. Forcing thinking off
    // collapses the model into the regular content channel where its
    // tool-call sampling is far more deterministic.
    let thinkingOffRecoveryAttempted = false;
    let nextCallThinkOverride: boolean | undefined = undefined;
    // Final-shot prefill recovery for qwen3.6-style "closes the reasoning
    // fence and stops" stalls. Observed Jun 2026 on a long CSS-refactor
    // turn: the model emitted 4 reasoning-only responses in a row even
    // after the nudge + thinking-off recovery had fired. Reasoning content
    // said "I need to actually emit tool calls" but generation terminated
    // right after the fence close. Prefill removes the choice — we push an
    // assistant message containing `<tool_call>{"name":"` so the next
    // generation MUST continue from inside an envelope. The provider
    // returns only the new tokens, so `pendingPrefillPrefix` is prepended
    // to the response before parsing.
    let prefillRecoveryAttempted = false;
    let pendingPrefillPrefix: string | null = null;
    // Track the last N non-tool-calling assistant responses so we can
    // detect a "deliberation loop" — the model emits multiple iterations
    // of highly-similar prose ("Wait, I see X isn't listed. Let me check
    // X. Actually, I'll try to read X.") without ever calling a tool.
    // Observed Apr 2026 on pburg-bowl with bandit-core-1: the model
    // streamed 24k chars of self-contradicting prose in a SINGLE
    // response, and if the content had been split across iterations the
    // existing detectors (hitLimit, false-completion patterns) would
    // also have missed it because each individual response looked
    // plausible in isolation. The cross-iteration guard below kicks in
    // if we see K non-tool iterations whose normalized prose overlaps
    // heavily with the previous one.
    const recentNonToolResponses: string[] = [];
    const PROSE_LOOP_WINDOW = 2;  // look back this many iterations
    let proseLoopNudged = false;
    // Track recent tool calls to detect a stuck model. The classic failure:
    // the model writes a long JSON/TS file, its output gets truncated by an
    // unescaped quote in the content, the write "succeeds" but lands corrupt,
    // and the model immediately retries the same write hoping the problem
    // was transient. Without a circuit breaker it will loop until maxIterations.
    const recentCallKeys: string[] = [];
    const REPEAT_LIMIT = 3;

    // Track whether the model keeps emitting `todo_write` as its only tool
    // in consecutive iterations. The v1.5.40 "todo_store summary" nudge was
    // supposed to end this, but observed pburg-bowl traces (Apr 2026) show
    // the model still burns 3 iterations in a row revising its todo list
    // before doing any actual work. When N consecutive iterations fire
    // `todo_write` as the ONLY tool (no search/read/write alongside), we
    // inject a corrective nudge once.
    let consecutiveTodoOnlyIterations = 0;
    // 3 consecutive todo-only iterations before we intervene. Lower was
    // to block bandit-logic from ever ticking plan
    // items to "completed" — the model called todo_write twice to set up
    // the plan, churn nudge fired at iteration 1, and the "do NOT call
    // todo_write again this turn" message killed status updates for the
    // rest of the run. 3 gives the model one more iteration of grace.
    const TODO_ONLY_LIMIT = 3;
    let todoChurnNudged = false;

    // apply_edit-loop nudge. from a real
    // bandit-cli run that hit the 20-iteration cap while patching 17
    // implicit-any TypeScript errors one apply_edit at a time. Each
    // call landed (the work was real, unlike todo-churn), but the
    // sequential one-error-per-iteration cadence ate the whole budget.
    // When the model spends N consecutive iterations doing only
    // apply_edit (no read/run/search interleaved), we inject a one-shot
    // nudge pointing at apply_patch (multi-file, multi-hunk) or a
    // broader-context apply_edit that consolidates several adjacent
    // fixes — both expand throughput without changing the iteration
    // cap. Limit is 4 (one higher than todo-only): apply_edits are
    // real progress, so we tolerate one more before nudging.
    let consecutiveApplyEditOnlyIterations = 0;
    const APPLY_EDIT_ONLY_LIMIT = 4;
    let applyEditBatchNudged = false;

    // Companion to the churn breaker: detect when the model set up a plan
    // via `todo_write` early, then did multiple edit iterations WITHOUT
    // calling `todo_write` again. The Plan block in the UI stays frozen
    // on the original pending state — user watches the feed do real work
    // but sees nothing flip to ✓. on Gemma 4 12B:
    // iteration 1 set up 4-item plan, iterations 2-7 did reads + edits,
    // turn ended at iteration 8 with the Plan still all-pending. Nudge
    // fires at most once per turn, and ONLY on models without native
    // tool calling (capable models generally update plans unprompted).
    let lastTodoWriteIter = -1;
    let editsSinceLastTodo = 0;
    let todoProgressNudged = false;
    const TODO_PROGRESS_STALE_DELTA = 3;
    const TODO_PROGRESS_EDIT_THRESHOLD = 2;

    // Track file paths the user referenced in the prompt or any prior tool
    // call. If the model ends the turn with a large fenced code block and
    // has NOT emitted any file-edit tool call, AND one of these
    // referenced paths exists, we treat that as "code in markdown instead
    // of a tool call" and nudge. Populated from the user goal up-front;
    // the detector only fires when the signal is real.
    let promptImpliesFileEdit = false;
    // Companion to `promptImpliesFileEdit`: detect goals that ask for an
    // ANALYSIS — "evaluate", "review", "audit", "what is", "how does",
    // etc. Used by the limit-hit wrap-up logic to pick between the
    // edit-shaped Shipped/Partway/Blocked template and the analysis-shaped
    // Findings/Evidence/Gaps template. Without this, a "deep self
    // evaluation" turn that hit the 60-call cap got the edit template
    // and produced "Shipped: nothing" — useless framing for what was
    // actually asked. .
    let promptWantsAnalysis = false;
    {
      // Accept simple path tokens (contains `/` and a file extension) OR
      // the keywords "update", "edit", "change", "fix", "modify", "refactor",
      // "rewrite" — any of which imply the user expects a write. Heuristic,
      // not a parser. False positives here cost us one wasted nudge;
      // false negatives let code-fence hallucinations ship.
      const goalText = seedMessages
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n')
        .toLowerCase();
      promptImpliesFileEdit =
        /\b(update|edit|change|fix|modify|refactor|rewrite|replace|add)\b/.test(goalText) ||
        /[\w\-./]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|cs|swift|php|cpp|c|h|md|json|ya?ml|html|css)\b/.test(goalText);
      // Analysis verbs/phrasings. Includes both verb forms ("evaluate",
      // "review") and question forms ("what is", "how does", "why
      // does") so "evaluate this codebase" and "what's keeping this
      // agent from being better" both light up. Compatible with
      // `promptImpliesFileEdit` — a goal can match both ("look at
      // file.ts and tell me what you see"); the wrap-up picker
      // resolves precedence using `editToolsInvoked` as the tiebreaker.
      promptWantsAnalysis =
        /\b(evaluate|review|analy[sz]e|audit|inspect|investigate|explain|summari[sz]e|describe|tell\s+me|find\s+out|self[-\s]?eval(?:uat(?:e|ion))?)\b/i.test(goalText)
        || /\b(what(?:'s|\s+is|\s+are)|how\s+does|why\s+does|where\s+does)\b/i.test(goalText)
        || /\blook(?:ing)?\s+at\b/i.test(goalText);
    }

    // Track whether any file-producing tool call has actually been invoked
    // this turn. Used by the "false completion" detector below: if the model
    // emits a final response claiming it wrote code but never called
    // write_file / apply_edit / replace_range / apply_patch, we inject a corrective nudge and force one
    // more iteration so the model has a chance to actually do the work.
    let editToolsInvoked = 0;
    // Per-file tracking so the "subject not modified" detector (further
    // below) can catch the refactor failure mode where the model reads
    // a file for context, writes NEW files based on it, but never
    // updates the original. The set is normalized (lowercase, basename)
    // so different references to the same file collapse.
    const filesReadThisTurn = new Set<string>();
    const filesWrittenThisTurn = new Set<string>();
    let subjectNotModifiedNudged = false;
    // One-shot guard for the code-fence-as-final-answer detector (see below).
    let codeFenceHallucinationNudged = false;
    // One-shot guard for the JSON-todo auto-promotion detector (see
    // below). Small models (12B Gemma observed) sometimes paste their
    // todo list as a ```json code fence instead of calling todo_write,
    // which means the plan never advances and they re-iterate on the
    // same task. We detect the shape, synthesize a todo_write call,
    // execute it as if the model had emitted it, and continue. Capped
    // once per turn so a model that genuinely wants to show JSON data
    // isn't caught in a loop.
    let jsonTodoAutoPromoted = false;
    // One-shot guard so we don't infinite-loop a truly confused model.
    // The detector fires at most once per turn; if the model STILL claims
    // completion without writing after the nudge, we let the turn terminate
    // so the user can intervene.
    let falseCompletionNudged = false;
    // One-shot guard for the announce-then-stall detector. The model emits
    // a forward-looking commitment ("Let me dig deeper into X", "Next I'll
    // explore Y") with NO tool call, and the loop exits because no-tool =
    // final answer. with bandit-logic self-evaluating
    // this repo: 3 iterations of reads, then iteration 4 returned only
    // "Let me dig deeper into the core architecture..." and the runtime
    // exited with iterations:3, hitLimit:false. None of the existing
    // detectors caught it — no completion claim, no code fence, no prose-
    // loop similarity (first stall after real work).
    let announceIntentNudged = false;
    let askUserNudged = false;
    // One-shot guard for the fired-and-forgotten background-task detector.
    // The model spawns multiple `task(run_in_background="true")` calls in
    // one iteration and then either polls `check_task` immediately
    // (returns "still running" — wasted iteration) or, more often, does
    // the same exploration in parallel itself in the next iteration —
    // burning the parent's context budget on work the subagents will
    // report back. 6 backgrounded tasks spawned at
    // iter 4, polled at iter 5 (none ready), parent then duplicated all
    // their reads at iter 6. The nudge fires once per turn telling the
    // model to either work on something independent or terminate the
    // turn so the auto-inject can deliver synopses on the next turn.
    let firedAndForgottenNudged = false;
    // One-shot guard for the subagent-first-iteration-must-act detector.
    // Subagents (`options.isSubagent === true`) are spawned to gather
    // information for a specific goal; producing prose-only output on
    // iteration 0 is always a stall, never a legitimate final answer.
    // The existing announce-intent / narrate detectors miss when the
    // model emits neutral reasoning + non-forward-looking prose
    // ("This is a complex task...") that doesn't match their patterns.
    // bandit-logic stalled 5/6 subagents on a
    // self-eval turn with exactly that shape. Fires once per turn.
    let subagentFirstIterNudged = false;
    // Phrases a model uses when it thinks it has delivered code but hasn't
    // actually emitted a write/edit tool call. Based on observed failure
    // traces from bandit-core-1 and similar small models. Matched case-
    // insensitively; any match + no write tool this turn trips the nudge.
    const FALSE_COMPLETION_PATTERNS = [
      /in (?:my|a|the) previous response/i,
      /already provided (?:the|an?) (?:implementation|refactored|improved|updated)/i,
      /you can find (?:the |this )?(?:refactored|improved|updated) (?:code|implementation)/i,
      /here (?:is|'s) the (?:refactored|improved|updated|revised) (?:code|implementation|file)/i,
      /(?:i have|i've) (?:refactored|rewritten|updated|improved)/i,
      /(?:refactored|updated) (?:the )?(?:code|implementation) above/i,
      /i'll finalize the task here/i,
      /i've also marked (?:the tasks|these steps) as complet/i,
      // Deferral patterns: the model emitted a malformed tool call (usually
      // unescaped quotes/newlines in a large content payload), took the
      // parse-retry nudge as a cue to apologize, and asked the user which
      // task to resume instead of actually retrying. The user never sees
      // the change land on disk. Observed in pburg-bowl scoring rewrite
      // (Apr 2026): iteration 4 emitted write_file with unescaped content,
      // parse-retry nudge fired, model responded with apology + "let me
      // know which task I should resume" and termination.
      /i apologi[sz]e for the (?:malformed|invalid)/i,
      /(?:ensure|escape) (?:all )?(?:quotes|newlines|characters).*(?:properly )?escap/i,
      /in my next tool call/i,
      /let me know (?:which|what) (?:task|action) (?:i should |to )?resume/i,
      /please (?:let me know|tell me).*(?:specific action|which task|what.*like me to)/i,
      // Patterns surfaced 2026-04-23 on S3Api with bandit-logic (Qwen
      // 2.5 Coder 32B). Model never called apply_edit, then ended the
      // turn with "Based on the steps we've taken, here is the final
      // state of the files..." followed by a prose dump of the
      // "edited" files (which were never actually written to disk).
      // The prior patterns covered "here is the refactored code" but
      // not "here is the final state." Same failure mode, new words.
      /here (?:is|'s) the (?:final|resulting|updated|modified) (?:state|version|content|output) of/i,
      /(?:comments?|changes?|edits?|annotations?|updates?) (?:have )?been (?:added|made|applied|written|included)/i,
      /you can verify (?:these|the|your) (?:changes?|edits?|updates?)/i,
      /check(?:ing)? the files? (?:directly )?in your editor/i,
      /running (?:a )?build to (?:see|verify|check)/i,
      // Gemma 4 / bandit-core-1 escape patterns observed
      // 2026-05-12 turn 1bec. After the bandit-tl hallucination detector
      // blocked the fake-card shape, the model fell back to
      // pure-prose lying with phrases like:
      // "I have successfully eliminated all critical errors"
      // "I have successfully fixed/resolved/removed/cleaned up X"
      // "The project is now in a healthy state"
      // "Verified via [tool] — confirmed [N→0]"
      // "Removed forbidden require() calls: Converted them to ESM"
      // Existing patterns covered "refactored / rewritten / updated /
      // improved" but missed eliminated / resolved / cleaned / verified.
      // Each new pattern is anchored to a completion-claim verb so this
      // doesn't fire on legitimate "I will fix" intent phrases.
      /(?:i have|i've)\s+(?:successfully\s+)?(?:eliminated|resolved|removed|cleaned|cleared|deleted|wiped|converted|wrapped|implemented|completed|finished)/i,
      /(?:the project|the codebase|the file|the code) is now (?:in a (?:healthy|clean|working|fixed) state|fixed|complete|done|ready)/i,
      /(?:verified|confirmed) (?:via|with|by running)\s+(?:the\s+)?(?:linter|tests?|build|tsc|eslint)/i,
      /(?:critical errors?|lint(?:ing)? errors?|warnings?|issues?) (?:dropped|went|reduced) (?:from\s+)?\d+\+?\s*(?:to|→)\s*\d+/i,
      // "Successfully" + past-tense action is the most common new shape.
      /successfully\s+(?:fixed|resolved|removed|eliminated|cleaned|converted|implemented|verified|completed|applied|updated|patched)/i
    ];

    for (;;) {
      if (signal?.aborted) {
        emit('tool_loop:cancelled', { iteration: iterations, stage: 'pre_iteration' });
        return buildCancelledResult(messages, iterations);
      }
      // Both limit-hit messages now LEAD with the original user goal.
      // a self-evaluation turn hit the 60-tool cap,
      // got the wrap-up nudge, and the model wrote a wrap-up about a
      // wholly different project (Helm chart / Next.js) it had touched
      // in compacted-away context — explicitly admitting "Without
      // knowing the exact original prompt." After 60 calls + multiple
      // compactions, the model genuinely cannot recall what was asked
      // unless we put it back in front of them at wrap-up time. The
      // anchor IS in the conversation but it's deep history; the
      // wrap-up message is the LAST thing the model sees, so the goal
      // belongs here too.
      const goalRecallBlock = originalGoal
        ? `## ORIGINAL USER GOAL — answer THIS, not whatever feels salient in recent reads:\n\n  "${originalGoal.trim()}"\n\n`
        : '';
      // Template picker — analysis-shaped goals (evaluate, review,
      // explain, "what is X") get a Findings/Evidence/Gaps shape;
      // edit-shaped goals (or any turn where edits actually fired)
      // get the Shipped/Partway/Blocked shape. `editToolsInvoked > 0`
      // takes precedence: if real edits landed, the user needs that
      // accounting regardless of the prompt phrasing. Default for
      // ambiguous goals (no edit signal, no analysis verb) is the
      // edit shape — that's what was here before, kept as the
      // conservative fallback.
      const useAnalysisTemplate =
        editToolsInvoked === 0
        && (promptWantsAnalysis || !promptImpliesFileEdit);
      // Analysis-shaped wrap-up. Three sections that match what an
      // evaluator-style turn produces: a substantive synthesis, the
      // material that supports it, and an honest list of gaps. Without
      // this template, "Shipped: nothing landed" was the model's
      // mandatory opener for analysis turns — useless framing for the
      // self-evaluation request that surfaced this fix.
      const analysisWrapUp =
        '**Findings** — your conclusions, the actual analysis the user asked for. Be specific: name files, patterns, gaps you saw. This is the deliverable; do NOT bury it under "I read X then Y then Z" — synthesise.\n' +
        '\n' +
        '**Evidence** — what you actually read or ran that supports each finding. File paths + brief description ("`tool-use-loop.ts:540` — goal-anchor only fires every 4 iterations"). Without this the user can\'t verify your claims.\n' +
        '\n' +
        '**What you didn\'t get to** — parts of the question you couldn\'t answer with what you saw. Be honest about gaps; do NOT invent confident claims about code you didn\'t actually read.\n';
      const editWrapUp =
        '**Shipped** — concrete changes that ACTUALLY landed this turn. Only list edits where a write_file, apply_edit, replace_range, or apply_patch tool call returned successfully (no errors). Be specific about file + what changed.\n' +
        '\n' +
        '**Build state** — if you edited code this turn you MUST state the build state explicitly. Either (a) cite a verified-clean run from THIS turn — quote the command + "exit code 0" / "no errors" output, OR (b) say "I did not run the build / typecheck this turn — caller should verify". DO NOT claim items are Done if the build is failing; downgrade those items to Partway and name the remaining errors. Real on a linter-fix turn: model wrote "Shipped" with 7 bullets while `tsc --noEmit` still reported 5 errors it had run out of iterations to fix.\n' +
        '\n' +
        '**Partway** — investigation done but not yet committed (files read, searches run, plan formed). State what was learned and what the next step would be.\n' +
        '\n' +
        '**Blocked / not attempted** — anything in the user\'s request you did not get to, or attempted-but-failed (e.g. apply_edit returned find-not-found). Own the failure honestly — do NOT claim success on these. If a fix is one paragraph the user can apply manually, say so.\n';
      const wrapUpBody = useAnalysisTemplate ? analysisWrapUp : editWrapUp;
      if (iterations >= max) {
        // soft cap extension. Before forcing the wrap-up,
        // check whether the model is making clear progress. Extension
        // criteria: last RECENT_HEALTH_WINDOW iterations all produced
        // tool calls (not empty, not todo-only), no loop-detection
        // nudges have fired this turn, and we're under the hard
        // ceiling. When all true, raise `max` by CAP_EXTENSION_SIZE
        // and let the loop continue. Up to MAX_CAP_EXTENSIONS, then
        // the wrap-up always fires no matter how healthy things look.
        const fullWindow = recentIterationsHadTools.length === RECENT_HEALTH_WINDOW;
        const allHealthy = fullWindow && recentIterationsHadTools.every(Boolean);
        const noNudges = !todoChurnNudged && !applyEditBatchNudged && !proseLoopNudged
          && fakeToolResultRetries === 0 && parseRetries === 0;
        const underCeiling = max + CAP_EXTENSION_SIZE <= hardCap;
        const canExtend = allHealthy && noNudges && underCeiling
          && iterationCapExtensions < MAX_CAP_EXTENSIONS;
        if (canExtend) {
          const prevMax = max;
          max += CAP_EXTENSION_SIZE;
          iterationCapExtensions++;
          emit('tool_loop:iteration_cap_extended', {
            iteration: iterations,
            previousMax: prevMax,
            newMax: max,
            extension: iterationCapExtensions,
            hardCap
          });
          // Drop a single-sentence nudge so the model knows the budget
          // grew and tightens up. Without this it might keep its
          // current pace and burn the extension too.
          messages.push({
            role: 'user',
            content:
              `You've been making good progress and the iteration budget has been extended by ${CAP_EXTENSION_SIZE} (new limit: ${max}). Keep going, but tighten up: prefer batched edits over single-line ones, and start wrapping up when you have a complete answer rather than running to the new cap. This is the ${iterationCapExtensions === 1 ? 'first' : 'second'} of at most ${MAX_CAP_EXTENSIONS} extensions for this turn.`
          });
        } else {
          hitLimit = true;
          // Step-budget exhaustion prompt. Three-section structure forces
          // honest accounting; the goal recall block above stops models
          // from inventing what the goal was. Template choice (analysis
          // vs edit) reflects what the user actually asked for.
          messages.push({
            role: 'user',
            content:
              `${goalRecallBlock}` +
              `You have reached the tool-use iteration limit (${max}). Stop calling tools. Produce a final answer with three short sections, in this exact shape:\n` +
              '\n' +
              wrapUpBody +
              '\n' +
              'No tool calls. No "I will continue" promises. Close the turn.'
          });
        }
      }
      if (totalToolsExecuted >= maxTotalTools && !hitLimit) {
        hitLimit = true;
        emit('tool_loop:total_tool_cap', { iteration: iterations, totalToolsExecuted });
        messages.push({
          role: 'user',
          content:
            `${goalRecallBlock}` +
            `You have executed ${totalToolsExecuted} tool calls this turn — the per-turn cap (${maxTotalTools}) has been reached. Stop calling tools. Produce a final answer with three short sections:\n` +
            '\n' +
            wrapUpBody +
            '\n' +
            'No more tool calls. Close the turn.'
        });
      }

      // Compact accumulated tool-result history before sending to the
      // provider. On small/medium models this is what keeps long agent
      // turns (6+ iterations on a real codebase) from overflowing
      // num_ctx — when older tool results have grown past the budget
      // they get collapsed to one-line "[earlier run, N lines elided]"
      // placeholders. The model still sees enough to avoid re-reading
      // files it already read. Aggressive-threshold rationale + the
      // why-trace live in loop/compactionTrigger.ts.
      const { aggressive: aggressiveCompactionThisIteration } = applyCompactionIfNeeded({
        messages,
        tokenBudget: effectiveOptions.messageTokenBudget,
        emit,
        iteration: iterations
      });

      // Goal anchor — re-inject the original user goal when the loop is
      // at risk of drifting (recency bias on long tool-result chains;
      // multi-turn pivot after compaction). Eligibility, refire gap,
      // and the aggressive-compaction override are pinned in
      // loop/goalAnchor.ts.
      ({ lastGoalAnchorIteration } = applyGoalAnchorIfNeeded({
        originalGoal,
        priorUserPromptCount,
        hitLimit,
        iteration: iterations,
        lastGoalAnchorIteration,
        aggressiveCompactionThisIteration,
        messages,
        registry: this.registry,
        emit
      }));

      // Stream and aggregate the model response.
      // Telemetry: capture total prompt size sent to the
      // model. Subagent stalls were hard to diagnose because we
      // couldn't tell if the prompt was 5KB (normal) or 50KB+ (would
      // explain prompt-processing latency). Now both are visible.
      const callOptions = nextCallThinkOverride !== undefined ? { think: nextCallThinkOverride } : undefined;
      // Per-call think override is single-shot — clear immediately after
      // building the options bag so subsequent iterations revert to the
      // chat function's closure-captured default.
      nextCallThinkOverride = undefined;
      let llmStartedAt = Date.now();
      let response = '';
      // Drain externally-pushed messages BEFORE each LLM call. Host
      // subscribes its backgroundStore (or other async event source)
      // and pushes into a local queue; this callback returns the
      // pending entries which the loop appends to the conversation.
      // Net effect: parent loop sees subagent completions the moment
      // they arrive instead of poll-spinning on check_task. See the
      // ToolUseLoopOptions doc for the motivating use case.
      const externals = effectiveOptions.drainExternalMessages?.() ?? [];
      for (const ext of externals) {
        if (ext && typeof ext.content === 'string' && ext.content.length > 0) {
          messages.push(ext);
          emit('tool_loop:external_inject', {
            iteration: iterations,
            role: ext.role,
            chars: ext.content.length
          });
        }
      }
      while (true) {
        emit('tool_loop:llm_start', {
          iteration: iterations,
          messageCount: messages.length,
          promptCharsTotal: messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
          systemPromptChars: messages
            .filter((m) => m.role === 'system')
            .reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
          thinkOverride: callOptions?.think
        });
        llmStartedAt = Date.now();
        try {
          response = await streamAndAggregate({
            chat,
            messages,
            emit,
            iteration: iterations,
            tools: nativeSchemas,
            signal,
            callOptions
          });
          if (pendingPrefillPrefix) {
            // Ollama's chat API treats a trailing assistant message as a
            // prefill — the model continues from where its content ends.
            // The streamed response contains only the new tokens, so glue
            // the prefix back on so downstream parsing sees a complete
            // <tool_call> envelope.
            response = pendingPrefillPrefix + response;
            pendingPrefillPrefix = null;
          }
          break;
        } catch (error) {
          if (nativeTools && nativeToolFailureFallback && !nativeFallbackUsed && isRetryableLlmError(error) && !signal?.aborted) {
            nativeFallbackUsed = true;
            nativeTools = false;
            nativeSchemas = undefined;
            const fallbackPrompt = buildFullSystemPrompt(false);
            if (fallbackPrompt) {
              if (messages[0]?.role === 'system') {
                messages[0] = { role: 'system', content: fallbackPrompt };
              } else {
                messages.unshift({ role: 'system', content: fallbackPrompt });
              }
            }
            // v1.7.299 right-way fix: push a synthetic user message so
            // the NEXT LLM call sees explicit guidance that the tool
            // channel changed. The system-prompt swap alone is not
            // enough — long-context models often anchor on the latest
            // user turn for "what tool envelope should I use," and
            // without this signal they keep emitting the prior
            // native-tools shape into the void. Mark trace 2026-05-26:
            // after a bandit-cloud 500 triggered native→text fallback
            // mid-turn, the model continued emitting native-style
            // payloads for 3+ iterations before finally producing
            // visible markup.
            messages.push({
              role: 'user',
              content:
                `[Provider error mid-turn — tool channel switched.] The previous attempt failed with: ${summarizeLlmError(error)}. ` +
                `I retried with the text-based tool-call channel. ` +
                `Re-emit your pending action using the text envelope: ` +
                `<tool_call>{"name":"...","params":{...}}</tool_call> outside of any reasoning block. ` +
                `Native-function-call payloads from your previous attempt were discarded — they're not visible to me. ` +
                `If your last intended action is unclear, briefly state what you were trying to do and then emit the tool_call.`
            });
            emit('tool_loop:native_tool_fallback', {
              iteration: iterations,
              reason: summarizeLlmError(error)
            });
            continue;
          }
          // One-shot outer-layer retry on the text channel. Only fires
          // when the channel switch has already happened (we're on text
          // now) AND the failure is retryable AND we haven't already used
          // this slot this turn. Larger backoff than the inner layer
          // because by this point we've spent ~5-10s on the native
          // attempts; the server probably needs longer to recover. After
          // this attempt, any further failure on text is genuinely
          // terminal — the user has been waiting > 30 s and a clean
          // error is more helpful than another silent retry.
          if (nativeFallbackUsed && !textFallbackRetryUsed && isRetryableLlmError(error) && !signal?.aborted) {
            textFallbackRetryUsed = true;
            emit('tool_loop:text_fallback_retry', {
              iteration: iterations,
              reason: summarizeLlmError(error)
            });
            await sleep(2400);
            continue;
          }
          // Last-resort final-anchor retry. By this point we've spent
          // every same-channel and cross-channel retry slot, and the
          // conversation may contain partial tool_call deltas or
          // half-emitted reasoning blocks that the model keeps anchoring
          // on. Push a clean recovery message that restates the original
          // goal and gives the model an explicit fresh-start framing,
          // then retry once more. Only fires when an originalGoal is
          // present (no point re-anchoring an empty turn) and the user
          // hasn't aborted. After this attempt the failure is genuinely
          // terminal — we've tried 12+ chat invocations across two
          // channels with three distinct framings.
          if (
            !finalAnchorRetryUsed
            && textFallbackRetryUsed
            && originalGoal.trim().length > 0
            && isRetryableLlmError(error)
            && !signal?.aborted
          ) {
            finalAnchorRetryUsed = true;
            messages.push({
              role: 'user',
              content:
                `[Recovery attempt — previous channel attempts hit ${summarizeLlmError(error)}. ` +
                `Discarding any partial tool_call or reasoning state from those attempts. ` +
                `Original user goal restated as a fresh anchor:]\n\n${originalGoal.trim()}`
            });
            emit('tool_loop:final_anchor_retry', {
              iteration: iterations,
              reason: summarizeLlmError(error),
              goalPreview: originalGoal.slice(0, 120)
            });
            await sleep(3600);
            continue;
          }
          throw error;
        }
      }
      // Diagnostic preview: 2000 chars + flags so we can tell apart "model
      // emitted tool markup that the parser missed" from "model genuinely
      // never emitted markup." 200 chars was too short to see past a
      // typical reasoning fence (subagent traces 2026-05-08 captured only
      // the fence opener and we couldn't tell if a tool call followed).
      emit('tool_loop:llm_response', {
        iteration: iterations,
        response: response.slice(0, 2000),
        responseLength: response.length,
        hasToolCallMarkup: response.includes('<tool_call>') || /```\s*tool_call\b/.test(response),
        endsWithFenceClose: /```\s*$/.test(response.trimEnd()),
        llmDurationMs: Date.now() - llmStartedAt
      });

      if (signal?.aborted) {
        emit('tool_loop:cancelled', { iteration: iterations, stage: 'post_stream' });
        return buildCancelledResult(messages, iterations, response);
      }

      // Turn-level hard cap on no-tool-call responses. The individual
      // detectors below (fake-tool-result, false-tool-absence,
      // tool-error recovery, empty-retry, narrate-no-action,
      // thinking-off recovery, parse-retry, prose-loop, etc.) each
      // have their own caps, but they chain — thinking-off recovery
      // resets consecutiveEmptyRetries=0, parse-retry has its own
      // counter, and the model can move between failure modes faster
      // than any one detector can give up. Mark Portfolio session
      // 2026-05-26 turn-02-30-37: 6 sequential reasoning-only
      // responses inside one iteration before the loop terminated
      // silently. This counter increments on EVERY response without
      // a tool_call and never resets; once it crosses the cap we
      // force-terminate with a final answer that names the stuck
      // state instead of letting the model spin.
      //
      // Placed BEFORE the per-detector branches so the cap takes
      // precedence — detectors can still nudge once each below this
      // line, but once we've hit the cap they don't run.
      if (!hitLimit && !hasToolCalls(response)) {
        noToolCallAttemptsThisTurn++;
        if (noToolCallAttemptsThisTurn >= NO_TOOL_CALL_HARD_CAP) {
          emit('tool_loop:no_tool_call_hard_cap', {
            iteration: iterations,
            attempts: noToolCallAttemptsThisTurn,
            responsePreview: response.slice(0, 200)
          });
          const finalStripped = stripToolCallMarkup(response).trim();
          const goalHint = originalGoal
            ? `\n\nGoal you asked me to handle: "${originalGoal.trim().slice(0, 200)}"`
            : '';
          const stuckAnswer =
            `I got stuck — emitted ${noToolCallAttemptsThisTurn} responses in a row without successfully invoking a tool, ` +
            `so I'm stopping the turn before it wastes more time. ` +
            `Most recent reasoning was:\n\n${finalStripped.slice(0, 600) || '(empty)'}` +
            `${goalHint}\n\n` +
            `Suggested next steps:\n` +
            `  - Re-ask with a narrower scope (one file or one concrete change)\n` +
            `  - Try \`/new\` to start fresh if the context is muddled\n` +
            `  - If you saw a tool error earlier in this turn, paste it back and I'll pick a different tool`;
          return { messages, iterations, hitLimit, finalResponse: stuckAnswer };
        }
      } else if (hasToolCalls(response)) {
        // A real tool_call landed — reset the cap counter so a later
        // unrelated stall in the same turn gets its own full budget.
        noToolCallAttemptsThisTurn = 0;
        // Also reset the prefill-recovery one-shot. The recovery budget
        // is "per stretch of failures," not "once per turn" — without
        // this reset, a long refactor that recovers from one prefill
        // stall and then hits another (observed in a real run: 26
        // iterations, prefill burned at iter 25, iter 26 stalled again
        // with no recovery left) falls straight
        // through to the terminal "Bandit stalled" fallback even though
        // every other detector still has budget. The hard cap on
        // noToolCallAttemptsThisTurn (5) bounds the total stuck
        // responses per stretch, so this can't infinite-loop.
        prefillRecoveryAttempted = false;
      }

      // Protocol guard: Gemma-family models (all sizes, including
      // bandit-core-1 31B) sometimes helpfully "complete" the
      // tool-call / tool-result pattern by emitting a fake
      // `<tool_result>` envelope in their OWN response — template
      // completion from training rather than real tool invocation.
      // The downstream effect is the model reports "edits applied"
      // when nothing was actually written. Detect the fake envelope,
      // strip it, and re-inject a corrective user message so the
      // model retries with a proper `<tool_call>` or produces a
      // plain-prose final answer. One iteration budget — avoids loops
      // if the model ignores the correction.
      const FAKE_TOOL_RESULT_RE = /<tool_result\b[\s\S]*?<\/tool_result\s*>|<tool_result\b[^<]*$/i;
      if (!hitLimit && FAKE_TOOL_RESULT_RE.test(response) && fakeToolResultRetries < FAKE_TOOL_RESULT_CAP) {
        fakeToolResultRetries++;
        emit('tool_loop:fake_tool_result_detected', {
          iteration: iterations,
          preview: response.slice(0, 200)
        });
        const scrubbed = response.replace(/<tool_result\b[\s\S]*?<\/tool_result\s*>/gi, '').replace(/<tool_result\b[^<]*$/i, '').trim();
        // Replace the just-pushed assistant response with the scrubbed
        // version so the model doesn't see its own hallucination in
        // the next turn's context (which would reinforce the pattern).
        messages.push({ role: 'assistant', content: scrubbed });
        messages.push({
          role: 'user',
          content: 'You emitted a `<tool_result>` envelope in your response. Those envelopes are SYSTEM output — they appear BETWEEN your turns, never inside your own message. If you meant to invoke a tool, emit a single `<tool_call>{"name":"...","params":{...}}</tool_call>` and wait for the real result. If the task is complete, give a plain-prose final answer with no XML envelopes. Retry now.'
        });
        continue;
      }

      // Fake tool-log fence detector. Some small/mid models hallucinate
      // ```bandit-tl / bandit-run / bandit-subagent fenced JSON cards
      // in prose to PRETEND they ran tools — the host's real tool-log
      // shape they've seen in conversation history. We strip the fake
      // fences and nudge with a hard-line "no claims of completion
      // without a real tool_call" message. Detector fires only when
      // the response has NO real `<tool_call>` markup, so models
      // legitimately quoting a tool-log card in explanatory prose
      // don't false-positive.
      const FAKE_BANDIT_TL_RE = /```bandit-(?:tl|run|subagent)\b[\s\S]*?```/gi;
      const FAKE_BANDIT_TL_LOOSE_RE = /```bandit-(?:tl|run|subagent)\b[\s\S]*$/i;
      const hasFakeBanditCard = FAKE_BANDIT_TL_RE.test(response) || FAKE_BANDIT_TL_LOOSE_RE.test(response);
      const hasRealToolCall = /<tool_call\b/i.test(response);
      if (!hitLimit && hasFakeBanditCard && !hasRealToolCall && fakeToolResultRetries < FAKE_TOOL_RESULT_CAP) {
        fakeToolResultRetries++;
        emit('tool_loop:fake_tool_result_detected', {
          iteration: iterations,
          preview: response.slice(0, 200),
          shape: 'bandit-tl'
        });
        const scrubbed = response
          .replace(/```bandit-(?:tl|run|subagent)\b[\s\S]*?```/gi, '')
          .replace(/```bandit-(?:tl|run|subagent)\b[\s\S]*$/i, '')
          .trim();
        messages.push({ role: 'assistant', content: scrubbed });
        messages.push({
          role: 'user',
          content: 'You emitted ` ```bandit-tl` (or `bandit-run` / `bandit-subagent`) fenced JSON in your response. Those fences are emitted by the EXTENSION HOST to log real tool execution — you CANNOT produce them. They show up in your context because the host logged actual tool calls, not because you can fabricate them. To actually run a tool, emit `<tool_call>{"name":"...","params":{...}}</tool_call>` and wait for the real result. Your fake fences mean NO work has happened this turn. You have TWO options for your retry, and ONLY two: (a) Emit a real `<tool_call>{"name":"...","params":{...}}</tool_call>` envelope NOW to actually do the work, then wait for the real result. (b) Honestly state "I have not [action] yet" and STOP. Do NOT claim completion. You MUST NOT claim you have fixed / eliminated / resolved / removed / cleaned / verified anything. No "successfully [verb]" phrasing. No numbered lists of "Step 1: I did X" actions. No "the project is now in a healthy state." Until a real `<tool_call>` lands on disk and returns a real tool-result, nothing has changed. Lying about completion is the worst failure mode. Retry now.'
        });
        continue;
      }

      // False-tool-absence detector. Model sometimes claims a tool
      // "is not available" / "I don't have access to X" — even when the
      // tool IS in the registry and was sent in this very turn's
      // native-tools schema. Usually triggered by an earlier error
      // ("Expected object, received string", "tool 'X' not registered")
      // surviving into compacted history while the success path didn't,
      // or by raw hallucination on small/mid models. Reset is a
      // band-aid; correct the claim inline so the user can keep going.
      //
      // Detector fires only when (a) the response has no tool_call,
      // (b) the absence phrase appears, (c) the named tool IS registered.
      // The registry-membership check is what gates the nudge — without
      // it we'd false-positive on legitimate "I can't do that" responses
      // about capabilities the agent genuinely doesn't have.
      if (
        !hitLimit
        && !hasToolCalls(response)
        && toolAbsenceCorrectionsFired < TOOL_ABSENCE_CORRECTION_CAP
      ) {
        const registeredNames = this.registry.getAll().map((t) => t.name);
        const absence = detectFalseToolAbsence(response, registeredNames);
        if (absence.detected) {
          toolAbsenceCorrectionsFired++;
          emit('tool_loop:false_tool_absence', {
            iteration: iterations,
            matched: absence.matchedToolNames,
            suggested: absence.suggestedTools,
            responsePreview: response.slice(0, 200)
          });
          messages.push({ role: 'assistant', content: response });
          messages.push({ role: 'user', content: buildToolAvailabilityNudge(absence) });
          continue;
        }
      }

      // Tool-error recovery. When the previous iteration's tool call
      // returned isError:true and THIS iteration produced no tool_call,
      // the model is silently abandoning the request. Push a one-shot
      // nudge: retry with corrected params OR explicitly state which
      // precondition failed. Without this the agent drops the task and
      // the user has to manually say "continue."
      if (
        !hitLimit
        && !hasToolCalls(response)
        && lastIterationHadToolError
        && toolErrorRecoveryFired < TOOL_ERROR_RECOVERY_CAP
      ) {
        toolErrorRecoveryFired++;
        emit('tool_loop:tool_error_recovery', {
          iteration: iterations,
          responsePreview: response.slice(0, 200)
        });
        messages.push({ role: 'assistant', content: response });
        messages.push({
          role: 'user',
          content:
            'The previous tool call returned an error and you produced no follow-up tool_call. ' +
            'Do NOT silently abandon the request — the user expects you to either retry with corrected parameters OR state explicitly which precondition failed and why you cannot proceed. ' +
            'Choose one: (a) emit a corrected `<tool_call>{"name":"...","params":{...}}</tool_call>` now, fixing the param shape or value the error pointed at; ' +
            '(b) give a one-line final answer naming the exact precondition you lack (e.g. "I cannot trash message X because the message id is unknown — please provide it"). ' +
            'Do not pretend the error did not happen and do not continue with unrelated work.'
        });
        continue;
      }

      messages.push({ role: 'assistant', content: response });

      // Small models sometimes stall with an empty response after a tool
      // result. Give them one polite nudge before giving up — almost always
      // enough for gemma4:e4b / qwen 7B to produce a real answer.
      //
      // Reasoning-only responses count as empty here. bandit-logic / Qwen
      // 3.6 in thinking mode sometimes emits a full <think>…</think> or
      // ```bandit-reasoning``` block planning out the work and then stops
      // without emitting an actual tool_call. Visually the user sees a
      // wall of reasoning text and nothing happens. Strip the reasoning
      // fences before checking emptiness so the same nudge fires.
      const stripped = response
        .replace(/<think\b[\s\S]*?<\/think\s*>/gi, '')
        .replace(/<think\b[\s\S]*$/i, '')
        .replace(/```bandit-reasoning\b[\s\S]*?```/gi, '')
        .replace(/```bandit-reasoning\b[\s\S]*$/i, '')
        .trim();
      const reasoningOnly = !stripped && response.trim().length > 0;
      // "Narrated but didn't act" detector. Some models (notably ones
      // post-trained for a different tool-call envelope, e.g. OpenAI
      // harmony) emit reasoning + a prose intent ("I'll search for X.")
      // without emitting the actual tool_call envelope. We treat that
      // as a stall and nudge once per turn.
      //
      // Verbs are enumerated explicitly (inflections too) — stem-with-
      // suffix patterns over- or under-match on English irregulars
      // (doubled-letter "running", silent-e "using", false positives
      // on "useful"/"reader"). The check is anchored to the TAIL of
      // the stripped response (last sentence) so the verb has to be
      // in the model's final clause, not an earlier "I have already
      // searched the file" preamble before a real answer.
      //
      // Captured 2026-05-25 (Mark, Portfolio IDE session): model emitted
      // "I'll redesign the portfolio... Let me rewrite both files." with
      // NO tool_call and the turn closed as a final answer because
      // neither `redesign` nor `rewrite` was on the list. A long
      // session ended with zero work shipped. Missing a verb here =
      // silent stall = user has to re-prompt manually. Cheap to add.
      const NARRATE_VERB_RE = /\b(use|uses|used|using|call|calls|called|calling|invoke|invokes|invoked|invoking|execute|executes|executed|executing|run|runs|running|ran|search|searches|searched|searching|look|looks|looked|looking|read|reads|reading|check|checks|checked|checking|find|finds|finding|found|list|lists|listed|listing|fetch|fetches|fetched|fetching|grep|greps|grepped|grepping|explore|explores|explored|exploring|locate|locates|located|locating|plan|plans|planned|planning|start|starts|started|starting|begin|begins|began|beginning|create|creates|created|creating|write|writes|wrote|writing|rewrite|rewrites|rewrote|rewriting|rewritten|build|builds|built|building|rebuild|rebuilds|rebuilt|rebuilding|update|updates|updated|updating|implement|implements|implemented|implementing|refactor|refactors|refactored|refactoring|redesign|redesigns|redesigned|redesigning|design|designs|designed|designing|generate|generates|generated|generating|scaffold|scaffolds|scaffolded|scaffolding|set\s+up|setting\s+up|tackle|tackles|tackled|tackling|do|does|did|doing|make|makes|made|making|batch|batches|batched|batching|execute|prepare|prepares|prepared|preparing|draft|drafts|drafted|drafting|outline|outlines|outlined|outlining|organize|organizes|organized|organizing|structure|structures|structured|structuring|kick\s+off|kicking\s+off|fix|fixes|fixed|fixing|edit|edits|edited|editing|modify|modifies|modified|modifying|patch|patches|patched|patching|adjust|adjusts|adjusted|adjusting|replace|replaces|replaced|replacing|swap|swaps|swapped|swapping|polish|polishes|polished|polishing|clean\s+up|cleaning\s+up|tidy|tidies|tidied|tidying|finalize|finalizes|finalized|finalizing|finish|finishes|finished|finishing|complete|completes|completed|completing|wire|wires|wired|wiring|hook|hooks|hooked|hooking|render|renders|rendered|rendering|style|styles|styled|styling|theme|themes|themed|theming|redo|redoes|redid|redoing|port|ports|ported|porting|migrate|migrates|migrated|migrating|configure|configures|configured|configuring|install|installs|installed|installing|remove|removes|removed|removing|delete|deletes|deleted|deleting|rename|renames|renamed|renaming)\b/i;
      const NARRATE_INTENT_RE = /\b(we (?:will|need to|should)|we'?ll|we'?re going to|i'?ll|i will|let me|let'?s|going to|i'?m going to|i need to)\b/i;
      // Real code fences pass through; narrate only fires when the
      // model emitted no structured payload at all. Check the STRIPPED
      // response, not the raw one — `bandit-reasoning` fences are
      // reasoning, not structured output.
      const hasCodeFence = /```[a-zA-Z0-9_-]*\s*\n/.test(stripped);
      const tailMatch = stripped.match(/(?:[.!?]\s+)([^.!?]*)$/);
      const tail = (tailMatch ? tailMatch[1] : stripped).slice(-200);
      const narratedButNoAction =
        !hasToolCalls(response) &&
        !hasCodeFence &&
        stripped.length > 0 &&
        stripped.length < 240 &&
        NARRATE_INTENT_RE.test(tail) &&
        NARRATE_VERB_RE.test(tail);
      // Empty-response retry: was previously gated to `iterations > 0`
      // under the assumption "empty first response = provider outage."
      // That assumption was wrong — with bandit-logic
      // (cloud) on multi-message email-fetch turns: iteration 0 streams
      // completely empty (no reasoning text, no narrate prose, just zero
      // tokens), the loop falls straight through, and the user gets the
      // stall fallback instantly. Same model later in the same session
      // worked fine. Empty on iteration 0 is now allowed to nudge so
      // the model gets a second chance (and the thinking-off recovery
      // below can flip it to non-thinking mode if the second pass also
      // empties).
      const shouldNudge =
        (!response.trim() || reasoningOnly || narratedButNoAction) &&
        !hitLimit &&
        consecutiveEmptyRetries < 2 &&
        !thinkingOffRecoveryAttempted;
      if (shouldNudge) {
        consecutiveEmptyRetries++;
        emit('tool_loop:empty_retry', {
          iteration: iterations,
          attempt: consecutiveEmptyRetries,
          reasoningOnly,
          narratedButNoAction
        });
        const nudgeMessage = narratedButNoAction
          ? 'You announced your next step in prose ("we will search…" / "let me check…" / "use X to find Y") but did NOT emit a `<tool_call>` envelope. Announcing intent is not enough — you must actually invoke the tool. Emit the call now in this exact format, OUTSIDE of any reasoning block, with NO commentary and NO markdown fence:\n\n<tool_call>{"name":"<tool>","params":{"<key>":"<value>"}}</tool_call>\n\nReplace name/params with the right values for your task. Or, if the task is already answerable from what you know, give a final answer instead.'
          : reasoningOnly
            ? 'You completed reasoning but emitted no tool_call AND no final answer. The reasoning text alone does not run a tool — you must emit a `<tool_call>` envelope OUTSIDE the reasoning block. Format example (replace name/params for your task):\n\n<tool_call>{"name":"<tool>","params":{"<key>":"<value>"}}</tool_call>\n\nNo prose around it, no markdown fence, just the bare tag. If the task is answerable without a tool, write a complete final answer instead. Do not stop after only thinking.'
            : 'Your previous response was empty. Either emit a `<tool_call>{"name":"<tool>","params":{...}}</tool_call>` to invoke a tool, OR produce a complete final answer using what you have. Do not respond with an empty message.';
        messages.push({
          role: 'user',
          content: nudgeMessage
        });
        continue;
      }
      // Cap reached on a reasoning-only OR completely-empty stall: try
      // ONE more round with thinking forced off. This is the single-shot
      // "thinking-off recovery" — see comment on
      // `thinkingOffRecoveryAttempted` above. If the model produces a
      // tool_call this time, great. If it still stalls, we fall through
      // and the loop terminates normally with the final response shown
      // to the user.
      //
      // Threshold lowered from 2 to 1 AND extended to cover empty
      // responses (2026-05-03): bandit-logic via the cloud gateway
      // sometimes streams an entirely empty response on iteration 0
      // (not reasoning-only — zero tokens). Same prompt later in the
      // same session works fine. Force thinking-off after a single
      // empty/reasoning-only retry so the second attempt skips the
      // thinking channel entirely.
      const stallShape = reasoningOnly || !response.trim();
      if (
        !hitLimit
        && stallShape
        && consecutiveEmptyRetries >= 1
        && !thinkingOffRecoveryAttempted
      ) {
        thinkingOffRecoveryAttempted = true;
        consecutiveEmptyRetries = 0;
        nextCallThinkOverride = false;
        emit('tool_loop:thinking_off_recovery', {
          iteration: iterations,
          reason: 'reasoning_only_cap_exhausted'
        });
        messages.push({
          role: 'user',
          content: 'Switching to non-thinking mode for this attempt because reasoning-only retries exhausted. Emit either a tool_call or a complete final answer. No more reasoning preamble.'
        });
        continue;
      }
      // Final-shot prefill recovery for the qwen3.6 "closes reasoning fence
      // and stops" pattern. Reached when thinking-off recovery also
      // produced a reasoning-only / empty response. Push an assistant
      // message containing only the start of a tool_call envelope so
      // Ollama treats it as a prefill — the model has to continue from
      // inside the envelope, removing its option to end the response at
      // the reasoning fence close. The completion is glued back to the
      // prefix when streamAndAggregate returns (see the prepend above).
      if (
        !hitLimit
        && stallShape
        && thinkingOffRecoveryAttempted
        && !prefillRecoveryAttempted
      ) {
        prefillRecoveryAttempted = true;
        consecutiveEmptyRetries = 0;
        nextCallThinkOverride = false;
        pendingPrefillPrefix = '<tool_call>{"name":"';
        emit('tool_loop:prefill_recovery', {
          iteration: iterations,
          prefix: pendingPrefillPrefix
        });
        messages.push({
          role: 'assistant',
          content: pendingPrefillPrefix
        });
        continue;
      }
      consecutiveEmptyRetries = 0;

      // Model emitted tool_call markup but none parsed — almost always means
      // invalid JSON inside a content string (unescaped quotes is the classic
      // offender on writes of TS/JSON/HTML files). Give the model one more
      // shot with explicit guidance; otherwise treat the raw text as final.
      if (!hitLimit && looksLikeAttemptedToolCall(response) && !hasToolCalls(response) && parseRetries < PARSE_RETRY_CAP) {
        parseRetries++;
        emit('tool_loop:parse_retry', { iteration: iterations, attempt: parseRetries });
        // First retry: gentle guidance on escaping. Second retry: an
        // explicit escape-hatch — tell the model to write the file with
        // write_file (which takes a single `content` param and avoids
        // the find/replace escaping gauntlet) OR produce a prose-only
        // final answer. Without this the loop just terminates silently
        // and the user sees no actual edit.
        const firstRetry = parseRetries === 1;
        messages.push({
          role: 'user',
          content: firstRetry
            ? 'Your previous tool_call was not valid JSON — I could not parse it. Common cause: unescaped `"` characters inside a string value (for example `["", "", ""]` inside a `content` string). Retry the tool call with properly escaped JSON: every `"` inside a string value must be written as `\\"`, and every newline as `\\n`. If the content is very long, consider `replace_range` for a line-numbered block or breaking the change into smaller edits.'
            : 'Your tool_call still did not parse. Do NOT retry with the same shape or the same escaping failure. Switch tactics: (a) call `replace_range` for a large block whose line numbers you just read, (b) call `write_file` for a new file, or (c) split the change into multiple small `apply_edit` calls that each target just one method or block (e.g. 3-5 lines of `find`, 5-10 lines of `replace`) instead of rewriting the whole class. Pick the smallest scope that accomplishes the next step. If you cannot produce a valid tool call, respond with a plain-prose final answer acknowledging you could not complete the edit.'
        });
        continue;
      }

      // Prose-loop detector (cross-iteration). If the assistant has gone
      // N iterations in a row without emitting a tool call AND the
      // current response is substring-similar to the previous one, the
      // model is almost certainly stuck in a deliberation loop. Fire
      // one corrective nudge; if that doesn't break the pattern, let
      // the turn terminate on the next iteration so the user sees a
      // coherent final answer instead of a second wall of repetition.
      if (!hitLimit && !hasToolCalls(response)) {
        const normalized = response.toLowerCase().replace(/\s+/g, ' ').trim();
        const prior = recentNonToolResponses[recentNonToolResponses.length - 1];
        const looksLikeLoop = Boolean(prior) && (() => {
          // Cheap similarity: longest common prefix / max length. If two
          // consecutive no-tool responses share >60% of their text by
          // prefix the model is repeating itself. More sophisticated
          // diff would be overkill — the real failure mode is near-
          // identical responses, not subtle rephrasings.
          const short = prior.length < normalized.length ? prior : normalized;
          const long = prior.length < normalized.length ? normalized : prior;
          let matched = 0;
          while (matched < short.length && short[matched] === long[matched]) {matched++;}
          return matched / short.length > 0.6;
        })();
        // Also flag the self-contradiction signature from the real
        // trace: alternating "Wait, I see …" and "Actually, I'll try
        // …" phrases appearing multiple times inside ONE response.
        const waitCount = (normalized.match(/wait,? i see/g) ?? []).length;
        const actuallyCount = (normalized.match(/actually,? i'?ll/g) ?? []).length;
        const selfContradicting = waitCount >= 3 && actuallyCount >= 3;
        // Intra-response stream abort already tagged the text — also a
        // loop.
        const streamAborted = response.includes('[stream aborted: self-contradicting prose loop detected]');

        if (!proseLoopNudged && (looksLikeLoop || selfContradicting || streamAborted)) {
          proseLoopNudged = true;
          emit('tool_loop:prose_loop_nudge', {
            iteration: iterations,
            responsePreview: response.slice(0, 200),
            reason: streamAborted ? 'stream_abort' : selfContradicting ? 'self_contradict' : 'cross_iteration_similarity'
          });
          messages.push({
            role: 'user',
            content:
              'STOP deliberating. Your last response either repeated itself, contradicted itself (e.g. "Wait, I see X / Actually I\'ll try X"), or was aborted mid-stream as a loop. Do NOT continue speculating about what files might exist. Take exactly one of these actions now: (a) invoke a tool (`list_files`, `read_file`, `search_code`, etc.) to answer the question with real data, OR (b) give up and tell the user plainly that you could not complete the task and why. Do not write more than two sentences of prose before either calling a tool or terminating.'
          });
          recentNonToolResponses.length = 0;
          continue;
        }

        recentNonToolResponses.push(normalized);
        if (recentNonToolResponses.length > PROSE_LOOP_WINDOW) {
          recentNonToolResponses.shift();
        }
      } else {
        // Reset the window whenever a tool call fires — legitimate
        // progress breaks any suspected loop.
        recentNonToolResponses.length = 0;
      }

      // JSON-todo auto-promote: small models (observed on gemma3:12b-it-qat,
      // Apr 22 S3Api turn) often paste their todo list as a ```json fenced
      // code block instead of calling the todo_write tool. The plan never
      // advances and the model re-iterates on the same task because its
      // own view of "what's done" stays frozen. Detect the shape, execute
      // a synthesized todo_write call on the model's behalf, continue.
      if (!hitLimit && !hasToolCalls(response) && !jsonTodoAutoPromoted) {
        const JSON_TODO_FENCE_RE = /```json\s*\n([\s\S]*?)```/i;
        const match = response.match(JSON_TODO_FENCE_RE);
        if (match) {
          try {
            const parsed = JSON.parse(match[1].trim());
            // Must be a non-empty array where every item looks like a todo
            // ({content: string} at minimum). Tight check avoids false-
            // positives on generic data-shaped JSON the model might emit.
            if (
              Array.isArray(parsed) &&
              parsed.length > 0 &&
              parsed.every(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  typeof (item as { content?: unknown }).content === 'string'
              )
            ) {
              jsonTodoAutoPromoted = true;
              emit('tool_loop:json_todo_auto_promoted', {
                iteration: iterations,
                itemCount: parsed.length
              });
              const todoTool = this.registry.get('todo_write');
              if (todoTool) {
                const syntheticCall = {
                  name: 'todo_write',
                  params: { items: JSON.stringify(parsed) },
                  raw: `<tool_call>{"name":"todo_write","params":{"items":${JSON.stringify(JSON.stringify(parsed))}}}</tool_call>`
                };
                emit('tool_loop:tool_execute', {
                  name: 'todo_write',
                  params: syntheticCall.params,
                  rawSnippet: syntheticCall.raw.slice(0, 400)
                });
                try {
                  const result = await todoTool.execute(syntheticCall.params, this.ctx);
                  // redact outputSnippet and outputFull
                  // before emitting; the model-facing message below
                  // is also redacted via buildToolResultsMessage →
                  // formatToolResult. todo_write output rarely carries
                  // secrets but consistency matters here — tool cards
                  // in the extension UI will render outputFull and we
                  // don't want any path to leak.
                  emit('tool_loop:tool_result', {
                    name: 'todo_write',
                    isError: result.isError,
                    outputLength: result.output.length,
                    outputSnippet: applySecretRedactionIfEnabled(result.output.slice(0, 280)),
                    outputFull: applySecretRedactionIfEnabled(result.output.slice(0, 65_536))
                  });
                  messages.push({
                    role: 'user',
                    content: buildToolResultsMessage([
                      { name: 'todo_write', output: result.output, isError: result.isError }
                    ])
                  });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  emit('tool_loop:tool_error', { name: 'todo_write', error: msg });
                  messages.push({
                    role: 'user',
                    content: buildToolResultsMessage([
                      { name: 'todo_write', output: `Error: ${msg}`, isError: true }
                    ])
                  });
                }
                // Nudge the model to stop pasting JSON and use the tool
                // directly next time. Reinforces the system-prompt anchor
                // without being so loud that it derails prose responses.
                messages.push({
                  role: 'user',
                  content:
                    'Note: I detected a JSON todo list in your response and auto-promoted it to a todo_write call. Next time, emit `<tool_call>{"name":"todo_write","params":{"items":"..."}}</tool_call>` directly instead of pasting JSON as a code block — pasted JSON does not update your plan, only the tool call does.'
                });
                iterations++;
                continue;
              }
            }
          } catch {
            // Not valid JSON — fall through to normal handling.
          }
        }
      }

      // If no tool calls (or hit limit), return the final answer.
      // Strip any lingering tool_call markup so malformed blocks never
      // reach the user-visible output.
      if (hitLimit || !hasToolCalls(response)) {
        // Detect hallucinated `<tool_result>` envelopes BEFORE stripping
        // so we can emit a telemetry event. The strip is mandatory (the
        // user can't see fabricated tool output as if it were real); the
        // event lets us track frequency and confirm the cause is what we
        // think it is — typically aggressive compaction stripping the
        // model's memory and it falling back to imitating the format.
        if (hasFabricatedToolResult(response)) {
          emit('tool_loop:hallucinated_tool_result', {
            iteration: iterations,
            responsePreview: response.slice(0, 300)
          });
        }
        const finalResponse = stripToolCallMarkup(response).trim();

        // False-completion detector. Small models regularly end a turn
        // with "I refactored the file" / "here is the updated code" text
        // without ever emitting a file-edit tool call.
        // When that happens the user sees a confident final response
        // backed by zero actual change on disk. If we detect this
        // pattern AND haven't nudged yet AND no edit tool was called
        // this turn, push one corrective user message into the loop
        // and continue for one more iteration. The nudge is capped at
        // one per turn so a truly confused model can still terminate.
        if (!hitLimit && !falseCompletionNudged && editToolsInvoked === 0) {
          const claimsCompletion = FALSE_COMPLETION_PATTERNS.some(re => re.test(finalResponse));
          if (claimsCompletion) {
            falseCompletionNudged = true;
            emit('tool_loop:false_completion_nudge', { iteration: iterations, responsePreview: finalResponse.slice(0, 200) });
            messages.push({
              role: 'user',
              content:
                'Your response either claims work is done OR apologizes and asks what to do next — but I see NO successful `write_file`, `apply_edit`, `replace_range`, or `apply_patch` tool call in this turn, so nothing on disk has changed. ' +
                'Do NOT ask the user which task to resume, do NOT promise to escape JSON "in your next tool call", and do NOT defer. Either (a) emit a real edit tool call NOW with the actual change — use `replace_range` for a large block whose line numbers you just read, `apply_edit` for a small exact replacement, or `write_file` for a new file — or (b) respond honestly that you could not complete the task and briefly explain why. Retry the tool call yourself; the user cannot help you escape JSON.'
            });
            continue;
          }
        }

        // Partial-completion detector. The check above catches "claimed
        // work, did NOTHING." This catches "claimed work on N files, only
        // edited M of them." with gpt-oss:120b on
        // S3Api: 1 successful apply_edit on HealthController.cs, then
        // the final answer claimed edits to FileController.cs (class +
        // 3 methods) AND HealthController.cs (class + method). The user
        // saw a confident summary of 5 edits but only 1 landed on disk.
        // Heuristic: extract distinct file references (paths with
        // recognized source extensions or backticked file-like tokens)
        // from the response. If the count exceeds the actual successful
        // edit count, the model is overclaiming. One nudge per turn.
        if (!hitLimit && !falseCompletionNudged && editToolsInvoked > 0) {
          const filePathRe = /[`"']?([\w./\\-]+\.(?:cs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|cpp|cc|c|h|hpp|md|json|ya?ml|html|css|scss|sql|toml|sh|bash))[`"']?/gi;
          const fileSet = new Set<string>();
          let m: RegExpExecArray | null;
          while ((m = filePathRe.exec(finalResponse)) !== null) {
            // Normalize so `S3Api/Controllers/Foo.cs` and `Foo.cs` count
            // separately only when they really are different files. Last
            // segment is the cheapest disambiguator.
            const segments = m[1].split(/[/\\]/);
            const leaf = segments[segments.length - 1].toLowerCase();
            fileSet.add(leaf);
          }
          if (fileSet.size > editToolsInvoked) {
            falseCompletionNudged = true;
            emit('tool_loop:partial_completion_nudge', {
              iteration: iterations,
              editToolsInvoked,
              claimedFiles: fileSet.size,
              responsePreview: finalResponse.slice(0, 200)
            });
            messages.push({
              role: 'user',
              content:
                `Your response describes edits to ${fileSet.size} files (${[...fileSet].slice(0, 8).join(', ')}${fileSet.size > 8 ? ', …' : ''}), but only ${editToolsInvoked} successful edit${editToolsInvoked === 1 ? '' : 's'} actually fired this turn. ` +
                `The remaining ${fileSet.size - editToolsInvoked} file(s) were NOT modified — nothing landed on disk for them. ` +
                'Either (a) emit the missing `apply_edit` / `replace_range` / `write_file` tool calls now to actually do the work, OR (b) revise your response to honestly describe ONLY the edits that successfully applied. Do not summarize work that did not happen.'
            });
            continue;
          }
        }

        // Subject-not-modified detector. Refactor goals
        // ("break out", "split", "refactor", "extract", "move") imply
        // mutation of the SOURCE file the user wants restructured, not
        // just creation of new sibling files. Failure mode observed
        // 2026-05-25 on a Portfolio React refactor: model read App.jsx,
        // wrote 5 new component files, never touched App.jsx, declared
        // completion. User had to follow up "are we using these?" to
        // force the integration step — and even that follow-up turn
        // wrote MORE components without modifying App.jsx.
        //
        // Heuristic: original goal contains a refactor verb AND the
        // turn read files AND wrote DIFFERENT files. If none of the
        // read files were also written, the model produced consumers
        // but never updated the source. One-shot nudge.
        const REFACTOR_GOAL_RE = /\b(refactor|refactoring|break\s+(?:out|up|apart|into)|split\s+(?:out|up|into|apart)|extract|extracting|migrate|migrating|move\s+(?:out\s+of|from|into)|reorganize|reorganizing|restructure|restructuring|consolidate|consolidating)\b/i;
        if (
          !hitLimit &&
          !subjectNotModifiedNudged &&
          editToolsInvoked > 0 &&
          filesReadThisTurn.size > 0 &&
          originalGoal &&
          REFACTOR_GOAL_RE.test(originalGoal)
        ) {
          const readNotWritten = [...filesReadThisTurn].filter((p) => !filesWrittenThisTurn.has(p));
          // Fire only when the read-set is disjoint from the write-set.
          // If even ONE read file was written, the model is integrating;
          // we don't want to nag a partial-but-progressing refactor.
          if (readNotWritten.length === filesReadThisTurn.size) {
            subjectNotModifiedNudged = true;
            emit('tool_loop:subject_not_modified_nudge', {
              iteration: iterations,
              readNotWritten: readNotWritten.slice(0, 4),
              writtenCount: filesWrittenThisTurn.size
            });
            const readPreview = readNotWritten.slice(0, 3).join(', ');
            const writeCount = filesWrittenThisTurn.size;
            messages.push({
              role: 'user',
              content:
                `The user's goal contains a refactor verb (refactor/break out/split/extract/move) which implies the SOURCE file(s) should be modified, not just supplemented with new siblings. You read ${readPreview}${readNotWritten.length > 3 ? ' and others' : ''} for context, then wrote ${writeCount} NEW file(s), but you NEVER modified the file(s) you read. The refactor is incomplete: the source file still contains the old monolithic code. ` +
                `Emit the missing apply_edit/replace_range/write_file call on the source file now — it should import from the new files and drop the inlined code that's been extracted. If the refactor is genuinely a "scaffold only, leave source untouched" task, say so explicitly and explain why the source doesn't need to change.`
            });
            continue;
          }
        }

        // Code-fence-as-final-answer detector. pburg-bowl trace (Apr 21):
        // the model read ScoreBoard.tsx, then ended the turn with a ```
        // fenced helper function and "Replace your current total calculation
          // logic with this" — never calling a file-edit tool. The
        // existing FALSE_COMPLETION_PATTERNS don't catch this flavor because
        // the model doesn't SAY "I have refactored" — it just hands back
        // code. Heuristic: final response contains a fenced block with at
        // least ~8 lines of code, no edit tool was invoked this turn, and
        // the original prompt implied a file change. One-shot nudge.
        if (
          !hitLimit &&
          !codeFenceHallucinationNudged &&
          editToolsInvoked === 0 &&
          promptImpliesFileEdit
        ) {
          // Look for ```lang\n...\n``` blocks. We want *substantial* code,
          // not a one-liner — so require at least 8 non-empty lines inside
          // the fence. This avoids false positives on small snippets
          // (shell commands, regex, env values).
          const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
          const MIN_LINES = 8;
          let biggestFenceLines = 0;
          let match: RegExpExecArray | null;
          while ((match = fenceRe.exec(finalResponse)) !== null) {
            const nonEmpty = match[1].split('\n').filter(l => l.trim().length > 0).length;
            if (nonEmpty > biggestFenceLines) {biggestFenceLines = nonEmpty;}
          }
          if (biggestFenceLines >= MIN_LINES) {
            codeFenceHallucinationNudged = true;
            emit('tool_loop:code_fence_nudge', {
              iteration: iterations,
              fenceLines: biggestFenceLines,
              responsePreview: finalResponse.slice(0, 200)
            });
            messages.push({
              role: 'user',
              content:
                'You produced a substantial code block in your reply but never emitted a `write_file`, `apply_edit`, `replace_range`, or `apply_patch` tool call — so the change is NOT on disk. ' +
                'Do not ask the user to paste your code into a file themselves. Take exactly one of these actions now: (a) call `replace_range`, `apply_edit`, or `write_file` with the real change to the correct file, OR (b) say plainly that you could not locate the target file and explain what you searched for. Do not wrap up with another prose + code-fence response.'
            });
            continue;
          }
        }

        // Announce-then-stall detector. The model wraps an iteration with
        // a forward-looking commitment ("Let me dig deeper into X", "Next
        // I'll explore Y") but emits NO tool call, so the loop interprets
        // the prose as the final answer and exits. // with bandit-logic self-evaluating this repo. None of the
        // upstream detectors fire: no completion claim (false-completion
        // patterns miss), no code fence, no prose-loop similarity (it's
        // the first stall after real work), no parse retry (the prose
        // doesn't look like an attempted tool call). One nudge per turn;
        // if the model still won't act, we fall through to terminate so
        // the user can intervene.
        // Announce-then-stall + ask-user-in-prose detectors. The model
        // wrapped a turn with "Let me X" / "I'll Y" / "I'm porting Z"
        // (announce-intent) or with a prose decision question (ask-user)
        // while we could have rendered an interactive prompt. Either one
        // means the loop is about to exit on a non-final-answer shape.
        // Detector bodies + the regex why-traces live in
        // loop/finalAnswerNudges.ts. The orchestrator owns the
        // once-per-turn flags and the false-completion-nudge precedence.
        if (!hitLimit && !announceIntentNudged && !falseCompletionNudged) {
          const r = tryAnnounceIntentNudge({ finalResponse, iteration: iterations, emit });
          if (r.fired) {
            announceIntentNudged = true;
            messages.push(r.message!);
            continue;
          }
        }
        if (!hitLimit && !askUserNudged && !falseCompletionNudged) {
          const r = tryAskUserNudge({
            finalResponse,
            iteration: iterations,
            emit,
            askUserAvailable: this.registry.get('ask_user') !== undefined
          });
          if (r.fired) {
            askUserNudged = true;
            messages.push(r.message!);
            continue;
          }
        }

        // Subagent-first-iteration-must-act detector. Subagents are
        // spawned to gather information for a specific goal — producing
        // prose-only output on iter 0 is always a stall, not a real
        // final answer. The earlier announce-intent + narrate detectors
        // miss when bandit-logic emits neutral reasoning + non-forward-
        // looking prose ("This is a complex task...") that doesn't
        // match either's patterns. 5/6 subagents
        // on a self-eval turn died at 0 iterations with exactly that
        // shape. One nudge per turn; if the model still won't emit a
        // tool the loop exits and the parent gets the existing
        // "subagent stalled in reasoning" error.
        if (
          effectiveOptions.isSubagent
          && iterations === 0
          && !subagentFirstIterNudged
          && !announceIntentNudged
          && !falseCompletionNudged
          && !hitLimit
        ) {
          subagentFirstIterNudged = true;
          // DO NOT force think:false here. The earlier fix
          // hard-set nextCallThinkOverride = false on this
          // retry, which is correct for non-reasoning models but
          // catastrophic for bandit-logic (qwen3.6:27b): per the
          // model's training, the tool channel runs THROUGH the
          // reasoning channel — disabling thinking disables tool
          // calling entirely. Self-eval traces 2026-05-08 confirmed
          // 6+ consecutive retries with think:false producing only
          // reasoning prose, never a tool call. Now we keep the
          // model's natural think setting and only escalate the
          // prompt — give the model a concrete <tool_call> envelope
          // it can copy verbatim, with the most generic exploration
          // tool baked in. The thinking-off-recovery path at line 876
          // still fires earlier for genuinely empty/stuck responses;
          // we don't double-down here.
          emit('tool_loop:subagent_first_iter_no_tool_call', {
            iteration: iterations,
            responsePreview: finalResponse.slice(0, 240)
          });
          messages.push({
            role: 'user',
            content:
              'Your first response had reasoning but emitted NO tool call — that is a hard stall for a subagent (you exist to gather information; reasoning alone produces zero output). ' +
              'For your next response, emit a tool call. The minimum viable starting move for ANY exploration goal is:\n\n' +
              '<tool_call>{"name":"list_files","params":{"path":"."}}</tool_call>\n\n' +
              'Copy that exact envelope as the very first thing you emit (you may keep the reasoning block before it if your model needs to think first, but the tool_call envelope MUST appear in this turn). ' +
              'Substitute a different tool only if it\'s obviously better for the goal — `read_file` for "what does file X look like", `search_code` for "where is symbol Y", `run_command` for shell output. ' +
              'Do NOT respond with reasoning only again. The next message you send must contain a real <tool_call> envelope.'
          });
          continue;
        }

        // Reasoning-only terminal fallback. If we got here because the
        // empty-retry / thinking-off-recovery cap was reached and the
        // model still produced only reasoning + zero actionable output,
        // the user otherwise sees nothing — just a return to the prompt.
        // Surface a clear message that names what the model intended (so
        // the user can act on it themselves) instead of leaving them
        // staring at a blank reply. with bandit-logic
        // on the email-fetch task: model reasoned "I should use
        // run_command with osascript to fetch …" and emitted no tool
        // call — final response was empty after fence-strip and the
        // user saw nothing.
        //
        // The gate also covers the "regurgitated reasoning after
        // native→text channel fallback" case. Mark Portfolio
        // 2026-05-31T17-39-53 cleanup turn: native-tool path 500'd,
        // text-channel recovery prompted the model to re-emit its
        // pending action, but the model just echoed its prior
        // `bandit-reasoning` block — no tool_call, no prose, no
        // visible action for the user. The previous gate (`!finalResponse`,
        // where finalResponse = response stripped of tool_call markup
        // only) didn't trigger because the reasoning fence is not
        // tool_call markup. Widened below to also strip reasoning
        // before testing emptiness — if the response would render to
        // the user as nothing-actionable, the fallback fires and the
        // user sees what the model was thinking instead of silence.
        const reasoningStripped = response
          .replace(/<think\b[\s\S]*?<\/think\s*>/gi, '')
          .replace(/<think\b[\s\S]*$/i, '')
          .replace(/```bandit-reasoning\b[\s\S]*?```/gi, '')
          .replace(/```bandit-reasoning\b[\s\S]*$/i, '')
          .trim();
        const visibleAfterStrip = stripToolCallMarkup(reasoningStripped).trim();
        if (!visibleAfterStrip) {
          // Pull the last 1-2 sentences of reasoning so the user sees
          // what the model planned to do. Cap at 280 chars so the
          // fallback stays readable.
          const reasoningMatch =
            response.match(/<think\b[\s\S]*?<\/think\s*>/gi)?.pop() ??
            response.match(/```bandit-reasoning\b[\s\S]*?```/gi)?.pop() ??
            response;
          const reasoningText = reasoningMatch
            .replace(/<\/?think[^>]*>/gi, '')
            .replace(/```bandit-reasoning\s*\n?|```/g, '')
            .trim();
          const sentences = reasoningText.match(/[^.!?]+[.!?]/g) ?? [reasoningText];
          const tail = sentences.slice(-2).join(' ').trim().slice(-280);
          const fallback =
            `[Bandit stalled after reasoning without emitting a tool call — the model thought through the next step but never committed to an action. ` +
            `Last reasoning: "${tail}${tail.length === 280 ? '…' : ''}"\n\n` +
            `Try: re-prompt with the same request (often resolves on the next turn), or run the planned command yourself.]`;
          return { finalResponse: fallback, iterations, messages, hitLimit };
        }

        // Narrate-but-no-action terminal annotator. If the model ends a
        // turn with "Let me revert it:" — i.e. a forward-looking intent
        // verb followed by a DANGLING COLON and NO tool_call envelope —
        // and the inline empty-retry / narrate-no-action detector
        // already used its retry budget (consecutiveEmptyRetries >= 2)
        // so it couldn't nudge again, the user is left reading a
        // promise the model never kept. Mark Portfolio
        // 2026-05-31T17-39-53 cleanup turn: after a native→text channel
        // recovery, the model emitted "Let me revert it:" with a
        // dangling colon and no tool call; the user saw the prose end
        // and waited for an action that never came. Append a clear
        // suffix so the unfulfilled intent reads as a stall, not as
        // the assistant's last word.
        //
        // The trailing colon is the smoking gun — it's the
        // grammatical signal "what comes next is the thing I'm about
        // to do". Without it ("Done. Let me know if you'd like me to
        // push the changes.") the response is a normal final answer
        // that happens to contain narrate verbs, and the annotator
        // would be a false positive.
        // The trailing colon + intent phrase combination is the
        // smoking gun. We DON'T also require NARRATE_VERB_RE here:
        // the existing inline detector's verb list misses "revert"
        // (Portfolio 2026-05-31) and would miss any other one-off
        // action verb a model might use. The colon alone is rare
        // enough in a legit final answer that pairing it with
        // "let me" / "I'll" / "we'll" / etc. is specific enough.
        //
        // Period-terminated variant (added 2026-06-03 after a real
        // run): the model ended with "Let me fix
        // all three project cards at once." — full sentence, full
        // stop, no colon. Both prefill and thinking-off recovery
        // had been spent earlier in the turn so the user saw the
        // narrate prose as the final answer with no annotation that
        // it represented a stall. Periods are MUCH more common than
        // colons in legit answers ("Done.", "Let me know if you'd
        // like me to push the changes."), so the period path
        // requires the STRICTER pair: NARRATE_INTENT_RE AND
        // NARRATE_VERB_RE both matching the tail clause. "Let me
        // know if you'd like…" hits intent but no action verb;
        // "Let me fix the cards" hits both.
        const terminalStripped = reasoningStripped;
        const endsWithColon = terminalStripped.endsWith(':');
        const endsWithPeriod = /\.["']?$/.test(terminalStripped);
        if ((endsWithColon || endsWithPeriod) && terminalStripped.length < 600) {
          // Extract the LAST sentence (text after the final non-trailing
          // sentence terminator). For period-ending responses we must
          // isolate just the closing clause — testing the whole response
          // would leak action verbs from earlier "Done. I updated the
          // file." prose into the gate and trigger false positives on
          // legit sign-offs like "Let me know if you'd like X."
          const sentenceSplit = terminalStripped
            .split(/[.!?]+\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const terminalTail =
            (sentenceSplit[sentenceSplit.length - 1] ?? terminalStripped).slice(-200);
          const intentHit = NARRATE_INTENT_RE.test(terminalTail);
          // Period path needs both intent + action verb. Colon path keeps the
          // original looser gate (colon alone is rare enough).
          const verbGateMet = endsWithColon ? true : NARRATE_VERB_RE.test(terminalTail);
          if (intentHit && verbGateMet) {
            const annotated =
              `${finalResponse}\n\n` +
              `[Bandit announced this action but did not emit the tool call — the turn ended without the planned change. ` +
              `If this came after retries (look for "Upstream hiccup" or "Native tool call failed" status messages), the upstream model errored mid-turn and the recovery prompt didn't land the action. ` +
              `Re-prompt with the same request to retry, or perform the action yourself.]`;
            return { finalResponse: annotated, iterations, messages, hitLimit };
          }
        }

        return { finalResponse, iterations, messages, hitLimit };
      }

      // Parse and execute all tool calls in this response.
      let toolCalls = parseToolCalls(response);
      emit('tool_loop:tool_calls', { iteration: iterations, tools: toolCalls.map(t => t.name) });

      // Repeated-todo-write circuit breaker. pburg-bowl (Apr 21) burned 3
      // consecutive iterations on `todo_write` revisions before doing any
      // real work. If this iteration's tools are ONLY todo_write (or
      // todo_write + another todo_write) AND the previous N-1 iterations
      // were also todo-only, drop the redundant todo_write calls and
      // inject a nudge telling the model to execute. We keep non-todo
      // calls in the same iteration — the breaker only strips redundant
      // planning, never real work.
      const todoOnly = toolCalls.length > 0 && toolCalls.every(t => t.name === 'todo_write');
      // apply_edit-only iteration detector. Mirrors todoOnly
      // shape; tracks how many consecutive iterations spent every tool
      // slot on apply_edit (no read, search, run_command, etc.) so we
      // can nudge toward batching after the model burns through 4 in a
      // row. Doesn't fire on mixed iterations (a read + 2 apply_edits
      // is normal investigative work).
      const applyEditOnly = toolCalls.length > 0 && toolCalls.every(t => t.name === 'apply_edit');
      // feed the rolling health window so the iteration-cap
      // extension below knows whether the model is making clear
      // progress. We push true ONLY when this iteration produced
      // tool calls AND wasn't purely a planning churn (todo-only).
      // Empty iterations (parse failures, prose-only) push false.
      recentIterationsHadTools.push(toolCalls.length > 0 && !todoOnly);
      while (recentIterationsHadTools.length > RECENT_HEALTH_WINDOW) {
        recentIterationsHadTools.shift();
      }
      // Iterations that emitted NO tool calls (parse failure — model tried
      // to generate tool-call JSON that didn't round-trip) are neither
      // "todo-only" nor "real work." Don't let them reset the consecutive
      // counter — otherwise a Qwen turn like
      // iter 3: todo_write
      // iter 4: (empty — bad JSON)
      // iter 5: todo_write
      // iter 6: (empty — bad JSON)
      // iter 7: todo_write ...
      // never accumulates to the threshold and the churn nudge never
      // fires. on S3Api with bandit-logic
      // (Qwen 2.5 Coder 32B via native tool calling).
      const iterationHadRealWork = toolCalls.length > 0 && !todoOnly;
      if (todoOnly) {
        consecutiveTodoOnlyIterations++;
      } else if (iterationHadRealWork) {
        consecutiveTodoOnlyIterations = 0;
        // Re-arm the nudge once the model has executed real work. Without
        // this, a single churn early in the turn bans further todo_write
        // calls even when the model has legitimately finished a step and
        // wants to mark it completed — leaving the Plan stuck with every
        // item in the pending state ( on S3Api).
        todoChurnNudged = false;
      }
      // apply_edit-only streak tracking. Increments only when
      // the whole iteration was apply_edit; resets on any mixed iter
      // (read + edit, run + edit, etc.) since those are normal
      // investigative work, not a serial-error-fix loop.
      if (applyEditOnly) {
        consecutiveApplyEditOnlyIterations++;
      } else if (toolCalls.length > 0) {
        consecutiveApplyEditOnlyIterations = 0;
        applyEditBatchNudged = false;
      }
      // Else: empty toolCalls iteration — preserve counter state. The
      // parse-failure case is handled separately below (repeat-detector).
      if (todoOnly && consecutiveTodoOnlyIterations >= TODO_ONLY_LIMIT && !todoChurnNudged) {
        todoChurnNudged = true;
        emit('tool_loop:todo_churn_nudge', {
          iteration: iterations,
          consecutive: consecutiveTodoOnlyIterations
        });
        // Drop the redundant todo_write calls for this iteration so the
        // breaker doesn't just get absorbed into another no-op. The model
        // still "saw" its own todo_write in the assistant response, but
        // we skip execution and inject a nudge as the next user message.
        toolCalls = [];
        messages.push({
          role: 'user',
          content:
            `You have revised the plan in ${consecutiveTodoOnlyIterations + 1} consecutive iterations without executing any step. ` +
            'Execute the first pending task now using a concrete tool — `search_code`, `read_file`, `apply_edit`, `replace_range`, `write_file`, or `run_command`. ' +
            'Once a task is actually DONE (tool call succeeded), you may call `todo_write` again to mark it completed — but not to re-plan. ' +
            'If you cannot identify a next step, respond to the user with a short honest explanation and stop.'
        });
        iterations++;
        continue;
      }

      // apply_edit-batch nudge. Fires once per turn when the
      // model has spent APPLY_EDIT_ONLY_LIMIT (4) consecutive iterations
      // doing nothing but apply_edit calls. Unlike the todo-churn nudge
      // we DO NOT drop the current iteration's calls — those edits are
      // real work, just slow work. We only inject the nudge as an
      // additional user message so the NEXT iteration considers
      // batching. Real on a 17-error
      // linter-fix turn that hit the iteration cap with 5 errors still
      // outstanding.
      if (applyEditOnly && consecutiveApplyEditOnlyIterations >= APPLY_EDIT_ONLY_LIMIT && !applyEditBatchNudged) {
        applyEditBatchNudged = true;
        emit('tool_loop:apply_edit_batch_nudge', {
          iteration: iterations,
          consecutive: consecutiveApplyEditOnlyIterations
        });
        messages.push({
          role: 'user',
          content:
            `You have spent ${consecutiveApplyEditOnlyIterations} consecutive iterations on apply_edit alone. ` +
            'If these are mechanical fixes of the same shape (one type annotation, one rename, one import path, one missing semicolon per call), STOP doing them one at a time — you will exhaust the iteration budget before the file is clean.\n' +
            '\n' +
            'Better tactics, in order of preference:\n' +
            '1. **`apply_patch` with multiple hunks** — one tool call lands every fix at once. You\'ve already read the files; the find context is in your buffer.\n' +
            '2. **`replace_range` for one large same-file region** — use the line numbers from `read_file` and replace the whole method/component block at once.\n' +
            '3. **A single broader-context `apply_edit`** — pick a `find` string that spans several adjacent edits and supply the corrected block as `replace`. Three small fixes in the same 10-line region collapse to one call.\n' +
            '4. **For 5+ fixes in one file**: re-read the file once, then `write_file` the corrected version. Faster than incrementally patching.\n' +
            '\n' +
            'Pick a tactic and reach for it next iteration. Do not just emit another single-line apply_edit.'
        });
        iterations++;
        continue;
      }

      // Intra-iteration normalization: byte-identical dedup, foreground-
      // task fanout cap, per-iteration parallel cap, per-turn total cap.
      // Each step emits its own telemetry event so hosts can surface
      // drops in the UI. See loop/toolCallNormalize.ts.
      const normalized = normalizeToolCallBatch({
        toolCalls,
        iteration: iterations,
        maxParallelTools,
        maxTotalTools,
        totalToolsExecuted,
        emit
      });
      toolCalls = normalized.accepted;
      const droppedForegroundTaskCalls = normalized.droppedForegroundTaskCalls;
      const droppedToolCalls = normalized.droppedParallelCap;
      totalToolsExecuted += toolCalls.length;

      // Per-tool execution — repeat-breaker, registry lookup,
      // beforeToolExecute gate, run, file-tracking + edit counting,
      // event emission. See loop/singleToolExecute.ts.
      const dispatchOne = createToolDispatcher({
        registry: this.registry,
        ctx: this.ctx,
        beforeToolExecute,
        emit,
        recentCallKeys,
        repeatLimit: REPEAT_LIMIT,
        filesReadThisTurn,
        filesWrittenThisTurn,
        isFileEditTool,
        onEditToolSucceeded: () => { editToolsInvoked++; }
      });

      // Output-budget gate + parallel/serial dispatch. Strong models
      // pass `outputBudgetTokens: Infinity` and never serialise;
      // small/medium local models trip the gate exactly when their
      // assistant turn is at risk of tail malformation. See
      // loop/parallelExecute.ts.
      const toolResults = await executeParallelBatch({
        toolCalls,
        dispatchOne,
        outputBudgetTokens,
        outputBudgetRatio,
        emit,
        iteration: iterations,
        signal
      });

      // Track whether ANY tool errored this iteration so the next
      // iteration's no-tool-call branch can fire the recovery nudge if
      // the model abandons the request rather than retrying.
      lastIterationHadToolError = toolResults.some((r) => r.isError === true);

      // Inject tool results as the next user message.
      let resultsMessage = buildToolResultsMessage(toolResults);
      if (droppedToolCalls > 0) {
        // Synthetic system-style note appended to the tool-result payload.
        // Keeps the model from re-emitting the dropped calls verbatim on
        // the next iteration: it sees "X were dropped, narrow your query"
        // alongside the results from the kept calls.
        resultsMessage +=
          `\n\n[Note: you emitted ${droppedToolCalls + toolCalls.length} tool calls in one iteration; ` +
          `only the first ${toolCalls.length} were executed. Do not re-issue duplicates — ` +
          `instead, read the results above and pick a single most-promising next action.]`;
      }
      if (droppedForegroundTaskCalls > 0) {
        resultsMessage +=
          `\n\n[Note: you emitted ${droppedForegroundTaskCalls + 1} foreground task subagents in one iteration; ` +
          `only the first one was executed. Foreground subagents block the parent agent and make the UI look stuck. ` +
          `For repo overviews, synthesize from direct reads/searches first. For truly parallel audits, re-issue extra ` +
          `subagents with run_in_background="true" so the parent can keep responding.]`;
      }
      messages.push({ role: 'user', content: resultsMessage });

      // Fired-and-forgotten guard. The model just spawned ≥2 background
      // subagents in this iteration. Without a nudge, the next iteration
      // typically polls `check_task` on tasks that haven't started (a
      // wasted iteration) or replays the same exploration in parallel —
      // either way burning the parent's context budget on work the
      // subagents will report back via the auto-inject path. See the
      // `firedAndForgottenNudged` declaration for the trace this is
      // patterned on. One nudge per turn.
      if (!firedAndForgottenNudged) {
        const bgSpawns = toolCalls.filter(
          (tc, idx) =>
            tc.name === 'task' &&
            String(tc.params.run_in_background ?? '').toLowerCase() === 'true' &&
            // Only count successful spawns — a failed task tool result is
            // its own signal and the parent's already going to retry or
            // pivot.
            !toolResults[idx]?.isError
        );
        if (bgSpawns.length >= 2) {
          firedAndForgottenNudged = true;
          const goalLines = bgSpawns
            .map((tc) => {
              const g = typeof tc.params.goal === 'string' ? tc.params.goal : '';
              const trimmed = g.length > 90 ? g.slice(0, 90).trimEnd() + '…' : g;
              return trimmed ? `- ${trimmed}` : '';
            })
            .filter(Boolean)
            .join('\n');
          emit('tool_loop:fired_and_forgotten_nudge', {
            iteration: iterations,
            backgroundSpawns: bgSpawns.length
          });
          messages.push({
            role: 'user',
            content:
              `You just spawned ${bgSpawns.length} background subagents:\n${goalLines}\n\n` +
              'Do NOT do those same explorations yourself in the next iteration — the subagents will deliver their synopses via the auto-inject path on a later turn. ' +
              'Choose ONE of: ' +
              '(a) work on a different, independent piece of the task that those subagents are NOT covering, ' +
              '(b) terminate this turn now and wait for the synopses to land on the next turn — preferred when the user is waiting on a synthesis built from those subagent results, ' +
              '(c) call `check_task` once on a specific id only when its result is the literal next blocking input you need. ' +
              'Do not poll all tasks at once immediately after spawning — they have not started yet and the call returns "still running" for every one of them.'
          });
        }
      }

      // Todo-progress tracking for the stale-plan nudge. Reset the edit
      // counter on any todo_write call (model updated its plan); increment
      // on successful edit calls. Native-tools-capable models generally
      // maintain plans without prompting so we skip the tracking there.
      if (!nativeTools) {
        for (let t = 0; t < toolCalls.length; t++) {
          const tc = toolCalls[t];
          const res = toolResults[t];
          if (tc.name === 'todo_write') {
            lastTodoWriteIter = iterations;
            editsSinceLastTodo = 0;
          } else if (isFileEditTool(tc.name) && res && !res.isError) {
            editsSinceLastTodo++;
          }
        }
        // One-shot stale-plan nudge: the model set up a plan earlier but
        // has since completed multiple edits without updating it. Fires
        // at most once per turn — if the model ignores it, we don't hound.
        if (
          !todoProgressNudged
          && lastTodoWriteIter >= 0
          && iterations - lastTodoWriteIter >= TODO_PROGRESS_STALE_DELTA
          && editsSinceLastTodo >= TODO_PROGRESS_EDIT_THRESHOLD
        ) {
          todoProgressNudged = true;
          emit('tool_loop:todo_progress_nudge', {
            iteration: iterations,
            editsSinceLastTodo,
            iterationsSinceLastTodo: iterations - lastTodoWriteIter
          });
          messages.push({
            role: 'user',
            content:
              'You set up a plan with `todo_write` earlier but have since completed ' +
              `${editsSinceLastTodo} edit${editsSinceLastTodo === 1 ? '' : 's'} without updating it. ` +
              'Call `todo_write` now with the current status — mark finished items as `completed` and leave remaining items as `pending`. ' +
              "The Plan block in the user's UI mirrors your last `todo_write`, so skipping this leaves them looking at a stale checklist while real work has landed."
          });
        }
      }

      iterations++;
    }
  }
}

/**
 * Convenience factory. Creates a loop with the given registry and context.
 */
export function createToolUseLoop(
  registry: ToolRegistry,
  ctx: ToolExecutionContext,
  options?: ToolUseLoopOptions
): ToolUseLoop {
  return new ToolUseLoop(registry, ctx, options);
}
