import type { TurnLogger } from '@burtson-labs/host-kit';
import { previewText } from '@burtson-labs/host-kit';
import type { StatusIndicatorController } from '../statusIndicators';
import type { TurnState } from '../turnState';

/**
 * Deps for the chat-events family of the tool-use-loop bridge. The
 * provider implements the callbacks so this module never reaches into
 * the provider class directly.
 */
export interface ChatEventDeps {
  state: TurnState;
  turnLog: TurnLogger | null;
  indicators: StatusIndicatorController;
  /**
   * Called at the start of a new iteration's first llm_chunk so any
   * pending edit-diff cards from the prior iteration drain to the
   * assistant entry before its content is mutated by the new stream.
   * Identity ordering matters — the prior iteration's tool_results
   * have all fired (emitEvent is awaited) and the disk state is
   * current, so this is the right place to render the cumulative diff.
   */
  flushPendingEditDiffs: () => void;
  /**
   * Resolve the loop's `iteration` field from the payload, falling back
   * to the supplied value when missing. The provider exposes the same
   * helper for the other event families so they all agree on iteration
   * indices.
   */
  getToolLoopIteration: (payload: unknown, fallback: number) => number;
  /**
   * Schedule a webview state push (`void this.syncState()` semantics).
   */
  syncState: () => void;
  /**
   * Update the busy/status line shown in the webview footer.
   */
  setStatusMessage: (text: string) => void;
  /**
   * Fire-and-forget toast on first llm_response when the Ollama provider
   * loaded the model with a smaller context_length than Bandit requested.
   * The provider implements the once-per-session gate via its private
   * `ollamaContextWarned` flag; this dep is invoked unconditionally and
   * the provider decides whether to show.
   */
  maybeShowOllamaContextWarning: () => void;
}

/**
 * Handles the chat-events family for the tool-use loop's emit callback:
 * `tool_loop:llm_start`, `tool_loop:llm_chunk`, `tool_loop:llm_response`,
 * `tool_loop:parse_retry`, `tool_loop:llm_retry`,
 * `tool_loop:native_tool_fallback`, `tool_loop:stream_abort`.
 *
 * Behavior preserved byte-for-byte from the inline switch the provider
 * used to host. The function is a no-op for unrecognized event types so
 * the caller can chain it alongside the other family handlers without
 * branching on family up front.
 */
export function handleChatEvent(type: string, payload: unknown, deps: ChatEventDeps): void {
  const {
    state,
    turnLog,
    indicators,
    flushPendingEditDiffs,
    getToolLoopIteration,
    syncState,
    setStatusMessage,
    maybeShowOllamaContextWarning
  } = deps;
  const assistantEntry = state.assistantEntry;

  if (type === 'tool_loop:llm_start') {
    // Drain pending edit-diff cards at the iteration boundary BEFORE
    // updating currentIteration. The llm_chunk handler also has a
    // boundary-flush, but because llm_start always lands first it
    // updates currentIteration so llm_chunk's `iteration !== currentIteration`
    // check is always false. Flushing here is what makes the diff
    // cards render inline with the iteration that produced them
    // (previously they bunched up at turn-end via the final flush in
    // performToolUseCompletion's success path).
    const nextIteration = getToolLoopIteration(payload, state.currentIteration);
    if (nextIteration !== state.currentIteration) {
      flushPendingEditDiffs();
    }
    state.currentIteration = nextIteration;
    state.currentIterationStartLength = assistantEntry.content.length;
    state.ignoreIterationChunks = false;
    state.streamedCharsByIteration.set(state.currentIteration, 0);
    // capture prompt size at the start of every LLM
    // call so we can correlate huge prompts with watchdog/stall
    // failures in the trace.
    const sp = payload as {
      iteration?: number;
      messageCount?: number;
      promptCharsTotal?: number;
      systemPromptChars?: number;
      thinkOverride?: boolean;
    };
    void turnLog?.append({
      type: 'llm-start',
      iteration: sp?.iteration,
      messageCount: sp?.messageCount,
      promptCharsTotal: sp?.promptCharsTotal,
      systemPromptChars: sp?.systemPromptChars,
      thinkOverride: sp?.thinkOverride
    });
    indicators.startThinking();
    return;
  }

  if (type === 'tool_loop:llm_chunk') {
    const iteration = getToolLoopIteration(payload, state.currentIteration);
    if (iteration !== state.currentIteration) {
      // New iteration begins — flush any pending diff cards from
      // the iteration that just completed. This is the right
      // time because all tool_results from the prior iteration
      // have already fired (events are sequential, emitEvent
      // is awaited), and the disk state reflects every edit.
      flushPendingEditDiffs();
      state.currentIteration = iteration;
      state.currentIterationStartLength = assistantEntry.content.length;
      state.ignoreIterationChunks = false;
      state.streamedCharsByIteration.set(state.currentIteration, 0);
    }
    if (state.ignoreIterationChunks) {
      // Still consuming tool_call chunks silently. Bump the
      // bytes counter so the generating-tool-call indicator
      // reflects progress on its next tick.
      const chunkLen = typeof (payload as { chunk?: unknown } | undefined)?.chunk === 'string'
        ? (payload as { chunk: string }).chunk.length
        : 0;
      indicators.addToolCallBytes(chunkLen);
      return;
    }

    const chunkText = typeof (payload as { chunk?: unknown } | undefined)?.chunk === 'string'
      ? (payload as { chunk: string }).chunk
      : '';
    if (!chunkText) {
      return;
    }

    // Real tokens are arriving — the thinking verb marker must go
    // before we append, otherwise "_⟳ pondering…_" ends up mid-text.
    indicators.stopThinking();

    // Track whether this chunk is inside a `bandit-reasoning`
    // fence. The chat wrapper opens the fence on the first
    // thinking token and closes it the moment real content
    // arrives. Update fence state BEFORE the suppression check
    // so reasoning chunks always render inline with the
    // iteration that produced them — otherwise they bypass
    // streaming and only surface via finalResponse at turn-end,
    // which is why users saw "reasoning" cards appear AFTER
    // the work it described had finished.
    const openMarkerIdx = chunkText.indexOf('```bandit-reasoning');
    const closeMarkerRe = /^\s*```\s*(?:\n|$)/m;
    if (openMarkerIdx >= 0) {
      state.inReasoningFence = true;
    }
    // The reasoning fence closes when a bare ``` line appears
    // after the open marker. The wrap generator emits a
    // standalone `\n```\n` closer — match conservatively so we
    // don't false-close on triple-backticks inside the reasoning
    // body (unlikely but possible if a model quotes code in its
    // chain-of-thought).
    const wasInFence = state.inReasoningFence;
    if (state.inReasoningFence && openMarkerIdx === -1 && closeMarkerRe.test(chunkText)) {
      state.inReasoningFence = false;
    }
    const isReasoningChunk = wasInFence || openMarkerIdx >= 0;

    // On a non-initial iteration (model has already called at
    // least one tool), suppress LLM prose by default. Small
    // local models (gemma3:12b, bandit-core:12b) stream
    // "Okay, I've read the file. Now I'll..." preambles + ```json
    // plan scratchpads between tool calls — all of which leaks
    // into the chat history when the native tool-call path is
    // used (no `<tool_call>` envelope in the stream to trigger
    // the legacy truncator). We kick into tool-call-gen mode
    // immediately and let `tool_loop:tool_calls` clear the
    // accumulated noise. Iteration 0 is left unmuted so a pure
    // Q&A turn (no tools) still streams visibly.
    //
    // Reasoning fences are an EXPLICIT exception — they're the
    // model's chain-of-thought rendered as a collapsible
    // disclosure block, not prose preamble. Users explicitly
    // want to see reasoning stream alongside tool work; routing
    // it through suppression made it appear after the work
    // finished.
    const suppressStreamPreamble =
      !isReasoningChunk
      && (state.currentIteration > 0 || state.iterationsWithToolCalls.size > 0);
    if (suppressStreamPreamble) {
      state.ignoreIterationChunks = true;
      if (indicators.addToolCallBytes(chunkText.length) > 0) {
        indicators.startToolCallGen();
      }
      return;
    }

    // Visible content is about to stream (reasoning fence or iter-0
    // prose). Stop the tool-call-gen ticker if a prior suppressed
    // chunk in this iteration started it. STATUS_MARKER_RE only
    // strips the `⟳ generating tool call · …` pill when it's
    // followed by `\n` or end-of-content; appending a chunk
    // directly after the marker leaves it stranded mid-text and
    // the next ticker tick appends ANOTHER pill rather than
    // replacing the stale one. End result before this fix:
    // every reasoning token rendered with a leading `⟳ generating
    // tool call · 68s` pill — the reasoning fence content turned
    // into one ticker-per-word soup.
    indicators.stopToolCallGen();

    assistantEntry.content += chunkText;
    assistantEntry.payload = assistantEntry.content;
    assistantEntry.timestamp = Date.now();

    const iterationSegment = assistantEntry.content.slice(state.currentIterationStartLength);
    const lowerSegment = iterationSegment.toLowerCase();
    // Detect BOTH tool-call shapes: the XML envelope and the fenced
    // form. The fenced form previously leaked straight through (only
    // '<tool_call' was checked), so raw ```tool_call JSON stayed
    // visible and — worse — any unclosed reasoning fence stayed open,
    // making the next host bandit-tl append parse as the reasoning
    // CLOSER and render its JSON as a raw code block (real CLI run,
    // 2026-06-12: raw bandit-tl rows after a dangling
    // "```bandit-reasoning" stub).
    const xmlIdx = lowerSegment.indexOf('<tool_call');
    const fenceIdx = lowerSegment.indexOf('```tool_call');
    const markerIdx = xmlIdx === -1 ? fenceIdx : fenceIdx === -1 ? xmlIdx : Math.min(xmlIdx, fenceIdx);
    if (markerIdx !== -1) {
      // Keep the reasoning streamed BEFORE the tool-call markup —
      // wiping the whole iteration segment was the "reasoning streams
      // then vanishes on every tool call" flicker. Close the fence
      // when the model never did, so the kept text renders as a
      // finished card.
      let kept = iterationSegment.slice(0, markerIdx);
      const lastOpen = kept.lastIndexOf('```bandit-reasoning');
      if (lastOpen !== -1 && !/\n\s*```/.test(kept.slice(lastOpen + '```bandit-reasoning'.length))) {
        kept = kept.replace(/\s*$/, '') + '\n```\n';
      }
      state.inReasoningFence = false;
      assistantEntry.content = assistantEntry.content.slice(0, state.currentIterationStartLength) + kept;
      assistantEntry.payload = assistantEntry.content;
      assistantEntry.timestamp = Date.now();
      state.ignoreIterationChunks = true;
      state.iterationsWithToolCalls.add(state.currentIteration);
      state.streamedCharsByIteration.set(state.currentIteration, kept.length);
      // Start the "generating tool call" indicator so the user
      // sees progress while the tool_call JSON payload streams
      // in invisibly. On big write_file calls this period can be
      // 30-60 seconds; before this the webview went silent.
      indicators.startToolCallGen();
      syncState();
      return;
    }

    const streamedChars = state.streamedCharsByIteration.get(state.currentIteration) ?? 0;
    state.streamedCharsByIteration.set(state.currentIteration, streamedChars + chunkText.length);
    syncState();
    return;
  }

  if (type === 'tool_loop:llm_response') {
    const p = payload as {
      iteration?: number;
      response?: string;
      responseLength?: number;
      hasToolCallMarkup?: boolean;
      endsWithFenceClose?: boolean;
      llmDurationMs?: number;
    };
    void turnLog?.append({
      type: 'llm-response',
      iteration: p?.iteration,
      responseLength: p?.responseLength,
      hasToolCallMarkup: p?.hasToolCallMarkup,
      endsWithFenceClose: p?.endsWithFenceClose,
      llmDurationMs: p?.llmDurationMs,
      responsePreview: previewText(p?.response ?? '')
    });
    // First-response Ollama context check. Once per session,
    // when provider is ollama: query /api/ps for the loaded
    // context_length and surface a one-time toast if it's too
    // small (canonical first-install gotcha — Ollama defaults
    // to 4K when OLLAMA_CONTEXT_LENGTH is unset, prompts overflow,
    // user thinks the agent is broken / slow / dumb). Best-effort,
    // never blocks the turn.
    maybeShowOllamaContextWarning();
    return;
  }

  if (type === 'tool_loop:parse_retry') {
    const p = payload as { iteration?: number; attempt?: number };
    void turnLog?.append({ type: 'parse-retry', iteration: p?.iteration, attempt: p?.attempt });
    return;
  }

  if (type === 'tool_loop:llm_retry') {
    const p = payload as { iteration?: number; attempt?: number; maxAttempts?: number; delayMs?: number; reason?: string };
    void turnLog?.append({
      type: 'llm-retry',
      iteration: p?.iteration,
      attempt: p?.attempt,
      maxAttempts: p?.maxAttempts,
      delayMs: p?.delayMs,
      reason: p?.reason
    });
    const waitSec = Math.round((p?.delayMs ?? 0) / 1000);
    setStatusMessage(`Upstream hiccup — retrying ${p?.attempt ?? '?'} of ${p?.maxAttempts ?? '?'} in ${waitSec}s…`);
    return;
  }

  if (type === 'tool_loop:native_tool_fallback') {
    const p = payload as { iteration?: number; reason?: string };
    void turnLog?.append({
      type: 'native-tool-fallback',
      iteration: p?.iteration,
      reason: p?.reason
    });
    setStatusMessage('Native tool call failed upstream — retrying with text tools…');
    return;
  }

  if (type === 'tool_loop:stream_abort') {
    const p = payload as { iteration?: number; reason?: string; length?: number; fingerprintPreview?: string };
    void turnLog?.append({ type: 'stream-abort', iteration: p?.iteration, reason: p?.reason, length: p?.length, fingerprintPreview: p?.fingerprintPreview });
    return;
  }
}
