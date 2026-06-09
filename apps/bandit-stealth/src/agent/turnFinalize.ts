/**
 * `turnFinalize` — the catch + finally + success-tail of
 * `performToolUseCompletion`. The three exported functions
 * (`finalizeTurnSuccess`, `finalizeTurnError`, `finalizeTurnAlways`)
 * map 1:1 to the try / catch / finally of the agent loop so the
 * provider's loop body becomes three thin calls instead of ~80 lines
 * of finalization tangled with the iteration logic.
 *
 * What each path owns:
 * - success: completion status message, the `notifyUser('complete')`
 *   toast, conversation persist, the fire-and-forget auto-speak hook
 * - error: stop indicators, strip a stranded-empty assistant entry,
 *   rate-limit branch (parses isRateLimit / window / resetsAt fields
 *   off the Error and surfaces a deep-link toast), friendly Ollama
 *   404 → "missing model — run ollama pull X" message, conversation
 *   persist
 * - always: cancel the active stream, drop busy state. Fires
 *   regardless of success / error so a stuck spinner can't outlive
 *   the turn.
 *
 * The friendly-message logic for Ollama 404 stays inline (not a
 * separate helper) — it's tied to the catch-block flow and tiny.
 */
import type * as vscode from 'vscode';
import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import type { ConversationEntry } from '../services/conversationTypes';
import type { ProviderContext } from '../provider/context';
import type { VoiceService } from '../provider/services/voiceService';
import { dedupeBanditReasoningFences, stripReasoningAlreadyInTranscript } from '../helpers/reasoningDedup';
import type { TurnState } from './turnState';

export interface TurnFinalizeBaseOptions {
  ctx: ProviderContext;
  configuration: vscode.WorkspaceConfiguration;
  userGoal: string;
  apiKey: string;
  providerKind: ProviderKind;
  assistantEntry: ConversationEntry;
  activeTurnStartedAt: number;
  /** Stop the streaming / tool-call-generation status markers. The
   *  loop builds these in its setup; the finalize path needs to clear
   *  them on every exit so a stranded "_⟳ pondering…_" line can't
   *  outlive an error toast. */
  disposeIndicators: () => void;
}

/**
 * Compose the final assistant entry content once the tool-use loop has
 * exited. Lives here (with the other finalize-* helpers) because it's
 * the conceptual prelude to `finalizeTurnSuccess` — every success path
 * runs this immediately before calling that.
 *
 * Three cases the body distinguishes:
 *
 *  1. **Tool-using turn (`hadToolActivity === true`).** The assistant
 *     entry already holds the accumulated activity transcript (skill
 *     markers, tool-execute lines, diff cards, Plan block). The model's
 *     final prose was emitted in the final iteration but was suppressed
 *     from streaming via `suppressStreamPreamble`. Append the deduped
 *     prose to the transcript so the user sees the conclusion under
 *     the work record. NEVER animate here — the animation loop reseeds
 *     content and any concurrent event (status tick, thinking marker)
 *     can race the reseed and visibly wipe diff cards.
 *
 *  2. **No tool activity, content non-empty.** Pure Q&A (e.g. "who are
 *     you?", `/help` explanations). Iteration 0's prose streamed in
 *     directly and is already the final response — appending it would
 *     duplicate the answer. Keep content as-is, just write back
 *     payload/timestamp for the syncState fanout.
 *
 *  3. **Empty content + final response to show.** Truly empty entry
 *     plus a `shouldAnimateFinalResponse` heuristic (no streamed chars
 *     and no tool calls on the final iteration) gates an animation
 *     pass for the pure-Q&A feel. The fallback path (no animation
 *     gate) drops the response in verbatim.
 *
 * Load-bearing details:
 *  - The TAIL_MARKERS_RE strip MUST run before the hadToolActivity
 *    branch picks an `activityTranscript`. Without it, a stranded
 *    "_⟳ scheming…_" marker lands above the real answer in the
 *    transcript.
 *  - `dedupeBanditReasoningFences` runs on both the raw
 *    `result.finalResponse` AND the marker-stripped transcript so the
 *    model's reasoning fences are normalized whether they came in via
 *    streaming or the final-iteration emit.
 *  - `stripReasoningAlreadyInTranscript` only applies in the
 *    hadToolActivity branch — pure Q&A turns don't have a transcript
 *    to dedupe against.
 *  - The "empty content → filter from conversation" line that used to
 *    follow this block in the provider was a no-op (the provider's
 *    `conversation` setter is a no-op since the ConversationService
 *    extraction). It's intentionally omitted from this helper.
 */
export async function composeFinalAssistantEntry(opts: {
  state: TurnState;
  assistantEntry: ConversationEntry;
  finalResponseRaw: string;
  iterations: number;
  animateAssistantResponse: (entry: ConversationEntry, text: string) => Promise<void>;
}): Promise<void> {
  const { state, assistantEntry, finalResponseRaw, iterations, animateAssistantResponse } = opts;

  const finalResponse = dedupeBanditReasoningFences(finalResponseRaw.trim());
  const finalIterationStreamedChars = state.streamedCharsByIteration.get(iterations) ?? 0;
  const shouldAnimateFinalResponse =
    finalResponse.length > 0
    && finalIterationStreamedChars === 0
    && !state.iterationsWithToolCalls.has(iterations);

  // Strip thinking / tool-call-gen markers left at the tail before
  // deciding how to finalize. They tick at turn-end time and would
  // otherwise land mid-transcript as "_⟳ scheming…_" stranded above
  // the real answer.
  const TAIL_MARKERS_RE = /(?:\n*`⟳\s+(?:[a-z]+…|generating tool call(?:[^`]*)|streaming response(?:[^`]*))`\s*)+$/;
  const activityTranscript = dedupeBanditReasoningFences(
    assistantEntry.content.replace(TAIL_MARKERS_RE, '').trimEnd()
  );
  const hadToolActivity = state.iterationsWithToolCalls.size > 0;

  if (hadToolActivity) {
    const visibleFinalResponse = stripReasoningAlreadyInTranscript(finalResponse, activityTranscript);
    assistantEntry.content = visibleFinalResponse
      ? `${activityTranscript}\n\n${visibleFinalResponse}`
      : activityTranscript;
    assistantEntry.payload = assistantEntry.content;
    assistantEntry.timestamp = Date.now();
  } else if (activityTranscript) {
    assistantEntry.content = activityTranscript;
    assistantEntry.payload = assistantEntry.content;
    assistantEntry.timestamp = Date.now();
  } else if (shouldAnimateFinalResponse) {
    await animateAssistantResponse(assistantEntry, finalResponse);
  } else {
    assistantEntry.content = finalResponse;
    assistantEntry.payload = assistantEntry.content;
    assistantEntry.timestamp = Date.now();
  }
}

export async function finalizeTurnSuccess(opts: TurnFinalizeBaseOptions & {
  iterations: number;
  voice: VoiceService;
}): Promise<void> {
  const { ctx, configuration, userGoal, apiKey, providerKind, assistantEntry, activeTurnStartedAt, iterations, voice } = opts;

  if (iterations > 0) {
    const plural = iterations !== 1 ? 's' : '';
    void ctx.setStatusMessage(`Completed with ${iterations} tool call${plural}.`);
  }
  ctx.notifyUser(
    'complete',
    'Bandit turn complete',
    userGoal.replace(/\s+/g, ' ').slice(0, 160),
    Date.now() - activeTurnStartedAt
  );

  await ctx.conversations.updateMessages(ctx.conversations.messages);
  await ctx.syncState();

  // Auto-speak hook. No-ops unless banditStealth.voice.autoSpeak is
  // on AND the TTS provider's API-key gate passes. Fires fire-and-
  // forget so the turn-completion path isn't blocked by TTS latency.
  if (assistantEntry.content) {
    void voice.maybeAutoSpeak(assistantEntry, configuration, apiKey, providerKind);
  }
}

export async function finalizeTurnError(opts: TurnFinalizeBaseOptions & {
  error: unknown;
  assistantAdded: boolean;
}): Promise<void> {
  const { ctx, configuration, userGoal: _userGoal, assistantEntry, activeTurnStartedAt, disposeIndicators, error, assistantAdded } = opts;
  void _userGoal;

  // Stop any live thinking markers first — otherwise the assistant
  // entry keeps a trailing "_⟳ pondering…_" or "_⟳ generating tool
  // call · 1.2kb_" line that was supposed to be cleared on success.
  // Without this the user sees the spinner verbs stranded in chat
  // even after the error toast fires (pburg-bowl report: Ollama 404
  // on missing coding-model → thinking verbs loop forever in the UI).
  disposeIndicators();

  if (assistantAdded && !assistantEntry.content.trim()) {
    // Pre-existing semantics: the `conversation` setter on the
    // provider is a no-op (messages live on ConversationService);
    // this line is preserved-as-no-op for behavioral fidelity until
    // a separate behavior-change commit can wire the strip through
    // updateMessages. See the pre-refactor BanditStealthViewProvider
    // catch block.
    const _filtered = ctx.conversations.messages.filter((e) => e.id !== assistantEntry.id);
    void _filtered;
  }

  const message = error instanceof Error ? error.message : 'Unknown issue.';
  const friendlyProvider = ctx.describeProvider(ctx.getProviderKind(configuration));

  // Rate-limit branch. The bandit provider attaches `isRateLimit`
  // and the parsed window/resetsAt fields on the Error when the
  // cloud gateway returns 429, so the UI can show a friendly
  // "come back in X" toast and deep-link to the Account & Usage
  // modal instead of the generic error pathway.
  const rateErr = error as { isRateLimit?: boolean; window?: string; resetsAtUnix?: number } | undefined;
  if (rateErr?.isRateLimit) {
    ctx.postMessage({
      type: 'rateLimited',
      window: rateErr.window ?? 'session',
      resetsAtUnix: rateErr.resetsAtUnix,
      message
    });
    ctx.notifyUser('error', 'Bandit cloud rate limit', message, Date.now() - activeTurnStartedAt);
    if (assistantAdded) {
      await ctx.conversations.updateMessages(ctx.conversations.messages);
      await ctx.syncState();
    }
    return;
  }

  // Surface Ollama-specific failures with actionable guidance so the
  // user doesn't have to decode "Ollama request failed: 404 …" —
  // the most common cause is a missing model name from an
  // explicit setting, not a network issue.
  let displayMessage = `${friendlyProvider} tool agent error: ${message}`;
  const lower = message.toLowerCase();
  if (lower.includes('ollama request failed: 404') || (lower.includes('model') && lower.includes('not found'))) {
    const match = message.match(/model[^"]*"([^"]+)"|model ['`]?([A-Za-z0-9:._-]+)['`]?/i);
    const modelName = match ? (match[1] ?? match[2] ?? 'your configured model') : 'your configured model';
    displayMessage = `Ollama doesn't have "${modelName}" installed. Run: ollama pull ${modelName} — or set banditStealth.ollamaAutoRouteModels to false so Ollama uses your ollamaModel directly.`;
  }
  ctx.postMessage({ type: 'error', message: displayMessage });
  ctx.notifyUser('error', 'Bandit turn failed', displayMessage, Date.now() - activeTurnStartedAt);
  if (assistantAdded) {
    await ctx.conversations.updateMessages(ctx.conversations.messages);
    await ctx.syncState();
  }
}

export async function finalizeTurnAlways(opts: {
  ctx: ProviderContext;
  cancelActiveStream: () => void;
}): Promise<void> {
  opts.cancelActiveStream();
  await opts.ctx.setBusy(false);
}
