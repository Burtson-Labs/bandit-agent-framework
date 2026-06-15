/**
 * Contract tests for the chat-events family of the tool-use-loop bridge.
 *
 * Pins five behaviors the extraction is meant to preserve byte-for-byte:
 *
 * (1) llm_start resets iteration bookkeeping (currentIteration,
 *     currentIterationStartLength snapshot, ignoreIterationChunks
 *     cleared, streamedChars zeroed) and kicks off the thinking
 *     indicator. A regression here would make every iteration's
 *     suppression gate inherit the prior iteration's state.
 *
 * (2) llm_chunk on an iteration boundary calls flushPendingEditDiffs
 *     BEFORE updating state. The ordering is load-bearing — the prior
 *     iteration's tool_results have all fired and disk reflects every
 *     edit; flushing later would lose the cumulative diff card.
 *
 * (3) llm_chunk routes reasoning-fence chunks past suppressStreamPreamble
 *     so chain-of-thought streams inline with the iteration that emitted
 *     it. Pre-2026-04 regression: reasoning landed via finalResponse
 *     at turn-end, AFTER the tool activity it described.
 *
 * (4) llm_retry preserves the attempt counter in both the turn-log
 *     entry and the user-visible status message. The retry ladder
 *     itself lives in agent-core; this bridge just translates the
 *     event to the trace + the status bar.
 *
 * (5) llm_response invokes maybeShowOllamaContextWarning unconditionally.
 *     The gate (`if (!this.ollamaContextWarned)`) lives in the provider's
 *     closure — this contract proves the bridge calls the dep every time
 *     and the dep decides whether to fire.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TurnLogger } from '@burtson-labs/host-kit';
import { TurnState } from '../../../src/agent/turnState';
import { handleChatEvent, type ChatEventDeps } from '../../../src/agent/eventBridge/chatEvents';
import type { StatusIndicatorController } from '../../../src/agent/statusIndicators';
import type { ConversationEntry } from '../../../src/services/conversationTypes';

function makeEntry(content = ''): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0, payload: content };
}

function makeIndicators(): StatusIndicatorController & { _calls: string[] } {
  const calls: string[] = [];
  return {
    _calls: calls,
    startThinking: vi.fn(() => calls.push('startThinking')),
    stopThinking: vi.fn(() => calls.push('stopThinking')),
    startToolCallGen: vi.fn(() => calls.push('startToolCallGen')),
    stopToolCallGen: vi.fn(() => calls.push('stopToolCallGen')),
    addToolCallBytes: vi.fn((n: number) => { calls.push(`addToolCallBytes:${n}`); return n; }),
    buildStatusText: vi.fn(() => ''),
    dispose: vi.fn()
  };
}

function makeTurnLog(): { append: ReturnType<typeof vi.fn>; logger: TurnLogger } {
  const append = vi.fn(async () => undefined);
  return {
    append,
    logger: { append, filePath: '/tmp/test.log', close: vi.fn(async () => undefined) } as unknown as TurnLogger
  };
}

function makeDeps(state: TurnState, overrides?: Partial<ChatEventDeps>): ChatEventDeps & { _indicators: ReturnType<typeof makeIndicators>; _append: ReturnType<typeof vi.fn> } {
  const indicators = makeIndicators();
  const turnLog = makeTurnLog();
  return {
    state,
    turnLog: turnLog.logger,
    indicators,
    flushPendingEditDiffs: vi.fn(),
    getToolLoopIteration: vi.fn((p: unknown, fallback: number) => {
      const it = (p as { iteration?: unknown } | null | undefined)?.iteration;
      return typeof it === 'number' ? it : fallback;
    }),
    syncState: vi.fn(),
    setStatusMessage: vi.fn(),
    maybeShowOllamaContextWarning: vi.fn(),
    ...overrides,
    _indicators: indicators,
    _append: turnLog.append
  } as ChatEventDeps & { _indicators: ReturnType<typeof makeIndicators>; _append: ReturnType<typeof vi.fn> };
}

describe('handleChatEvent', () => {
  it('llm_start flushes pending edit-diff cards at the iteration boundary before updating currentIteration', async () => {
    // Simulate iter N having captured pending edits, then iter N+1 starting.
    const entry = makeEntry('iter-N work transcript');
    const state = new TurnState(entry);
    state.currentIteration = 3;
    state.currentIterationStartLength = 0;
    // Pretend two edits were captured during iter 3.
    state.pendingWriteBefore.set('/abs/foo.ts', 'before-foo');
    state.pendingWriteAfter.set('/abs/foo.ts', 'after-foo');
    state.pendingWriteTool.set('/abs/foo.ts', 'apply_edit');

    const flushOrder: number[] = [];
    const deps = makeDeps(state, {
      // The flush closure in the provider reads state.currentIteration
      // to compute the checkpoint iteration. Snapshot the value AT FLUSH
      // TIME so we can prove the flush ran BEFORE currentIteration was
      // reassigned.
      flushPendingEditDiffs: vi.fn(() => flushOrder.push(state.currentIteration))
    });

    await handleChatEvent('tool_loop:llm_start', { iteration: 4 }, deps);

    // Flush was invoked once.
    expect(deps.flushPendingEditDiffs).toHaveBeenCalledOnce();
    // It ran WHILE state.currentIteration was still 3 (the OLD iteration).
    // The provider's flush closure reads `state.currentIteration + 1` for
    // the checkpoint iteration, so it expects the OLD value here.
    expect(flushOrder).toEqual([3]);
    // After the handler returns, currentIteration is the new value.
    expect(state.currentIteration).toBe(4);
  });

  it('llm_start does NOT flush when iteration is unchanged (defensive — re-emit of same iter)', async () => {
    const state = new TurnState(makeEntry(''));
    state.currentIteration = 2;
    state.pendingWriteBefore.set('/abs/foo.ts', 'before');

    const deps = makeDeps(state);
    await handleChatEvent('tool_loop:llm_start', { iteration: 2 }, deps);

    // No flush — iteration didn't change.
    expect(deps.flushPendingEditDiffs).not.toHaveBeenCalled();
    // Pending edits still in the map, waiting for the next real boundary.
    expect(state.pendingWriteBefore.has('/abs/foo.ts')).toBe(true);
  });

  it('llm_start snapshots iteration bookkeeping and starts the thinking indicator', async () => {
    const entry = makeEntry('prefix text');
    const state = new TurnState(entry);
    state.currentIteration = 7;
    state.currentIterationStartLength = 999;
    state.ignoreIterationChunks = true;
    state.streamedCharsByIteration.set(7, 314);

    const deps = makeDeps(state);
    await handleChatEvent('tool_loop:llm_start', { iteration: 8, messageCount: 4, promptCharsTotal: 12000 }, deps);

    expect(state.currentIteration).toBe(8);
    expect(state.currentIterationStartLength).toBe(entry.content.length); // snapshotted from assistantEntry
    expect(state.ignoreIterationChunks).toBe(false);
    expect(state.streamedCharsByIteration.get(8)).toBe(0);
    expect(deps._indicators.startThinking).toHaveBeenCalledOnce();
    expect(deps._append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'llm-start',
      iteration: 8,
      messageCount: 4,
      promptCharsTotal: 12000
    }));
  });

  it('llm_chunk flushes pending edit diffs at the iteration boundary before mutating state', async () => {
    const entry = makeEntry('iter-0 transcript');
    const state = new TurnState(entry);
    state.currentIteration = 0;
    state.currentIterationStartLength = 0;
    state.streamedCharsByIteration.set(0, 42);

    const flushOrder: string[] = [];
    const deps = makeDeps(state, {
      flushPendingEditDiffs: vi.fn(() => flushOrder.push(`flush@iter=${state.currentIteration}`)),
    });

    await handleChatEvent('tool_loop:llm_chunk', { iteration: 1, chunk: 'hello world' }, deps);

    // Flush was invoked WHILE state.currentIteration was still 0 — i.e.
    // before the boundary handler reassigned it.
    expect(flushOrder).toEqual(['flush@iter=0']);
    expect(state.currentIteration).toBe(1);
    expect(state.streamedCharsByIteration.get(0)).toBe(42); // prior counter intact
    // iteration moved to 1 mid-handler → suppressStreamPreamble fires
    // (currentIteration > 0) and the chunk is consumed silently. Content
    // unchanged, streamed-chars counter for the new iteration stays at 0.
    expect(entry.content).toBe('iter-0 transcript');
    expect(state.streamedCharsByIteration.get(1)).toBe(0);
    expect(state.ignoreIterationChunks).toBe(true);
  });

  it('llm_chunk stops the tool-call-gen ticker before appending visible content (reasoning fence regression)', async () => {
    // Reproduces the "ticker pill interleaved per word" bug:
    // Iteration N has suppressed prose, which started the tool-call-gen
    // ticker. Then the model opens a reasoning fence and streams
    // tokens. Without stopping the ticker first, every reasoning chunk
    // appends after the still-running ticker marker — and because
    // STATUS_MARKER_RE only strips the marker when it's followed by
    // newline or EOF, the next ticker tick can't strip the stranded
    // marker. It appends another. Result: `⟳ generating tool call ·
    // 68s` shows up between every word of reasoning.
    const entry = makeEntry('');
    const state = new TurnState(entry);
    state.currentIteration = 1;
    state.iterationsWithToolCalls.add(0);

    const deps = makeDeps(state);
    // Simulate a prior suppressed chunk that started the ticker.
    deps.indicators.startToolCallGen();
    // Reset call counts so the contract assertion below only counts
    // the stop triggered by the reasoning chunk.
    (deps.indicators.stopToolCallGen as ReturnType<typeof vi.fn>).mockClear();

    await handleChatEvent('tool_loop:llm_chunk', {
      iteration: 1,
      chunk: '\n```bandit-reasoning\nThe user'
    }, deps);

    // The reasoning chunk path stops the ticker before appending.
    expect(deps.indicators.stopToolCallGen).toHaveBeenCalled();
    // And the chunk is appended (visible content), not suppressed.
    expect(entry.content).toContain('```bandit-reasoning');
    expect(entry.content).toContain('The user');
  });

  it('llm_chunk inside a reasoning fence streams inline even on later iterations', async () => {
    const entry = makeEntry('');
    const state = new TurnState(entry);
    state.currentIteration = 3;
    state.currentIterationStartLength = 0;
    state.iterationsWithToolCalls.add(1);
    state.iterationsWithToolCalls.add(2);

    const deps = makeDeps(state);
    // Open-marker chunk lands AFTER iteration 0 — without the reasoning-fence
    // exception this would be silently swallowed by suppressStreamPreamble.
    await handleChatEvent('tool_loop:llm_chunk', { iteration: 3, chunk: '\n```bandit-reasoning\nthinking out loud' }, deps);

    expect(state.inReasoningFence).toBe(true);
    expect(entry.content).toContain('```bandit-reasoning');
    expect(entry.content).toContain('thinking out loud');
    expect(state.ignoreIterationChunks).toBe(false);
    expect(deps._indicators.stopThinking).toHaveBeenCalled();
    expect(deps.syncState).toHaveBeenCalled();
  });

  it('llm_chunk preserves streamed reasoning and closes an unclosed fence when a tool_call follows', async () => {
    // Real CLI run 2026-06-12: the model streamed a reasoning fence,
    // then emitted a tool_call in the SAME chunk run. The old code wiped
    // the entire iteration segment (reasoning flicker) AND left the
    // ```bandit-reasoning fence unclosed, so the next host bandit-tl
    // fence parsed as the reasoning closer and dumped raw JSON.
    const entry = makeEntry('');
    const state = new TurnState(entry);
    state.currentIteration = 0;
    state.currentIterationStartLength = 0;

    const deps = makeDeps(state);
    await handleChatEvent('tool_loop:llm_chunk', {
      iteration: 0,
      chunk: '\n```bandit-reasoning\nI should read the file.\n```\nNow I act.<tool_call>{"name":"read_file"}'
    }, deps);

    // Reasoning kept (not wiped to the iteration start).
    expect(entry.content).toContain('I should read the file.');
    // Tool-call markup is dropped from the visible transcript.
    expect(entry.content).not.toContain('<tool_call');
    // Fence is balanced — no dangling open marker for the next host fence.
    const opens = (entry.content.match(/```bandit-reasoning/g) ?? []).length;
    const closes = (entry.content.match(/\n```/g) ?? []).length;
    expect(closes).toBeGreaterThanOrEqual(opens);
    expect(state.inReasoningFence).toBe(false);
    expect(state.ignoreIterationChunks).toBe(true);
    expect(state.iterationsWithToolCalls.has(0)).toBe(true);
  });

  it('llm_chunk closes a never-closed reasoning fence before the tool_call marker', async () => {
    // The fence-only variant: model opened ```bandit-reasoning, never
    // emitted a bare ``` closer, then went straight to the tool call.
    const entry = makeEntry('');
    const state = new TurnState(entry);
    state.currentIteration = 0;
    state.currentIterationStartLength = 0;

    const deps = makeDeps(state);
    await handleChatEvent('tool_loop:llm_chunk', {
      iteration: 0,
      chunk: '\n```bandit-reasoning\nThe user wants an overview.<tool_call>{"name":"ls"}'
    }, deps);

    expect(entry.content).toContain('The user wants an overview.');
    expect(entry.content).not.toContain('<tool_call');
    // A closing fence was synthesized so the block renders as finished.
    expect(entry.content.trimEnd().endsWith('```')).toBe(true);
    expect(state.inReasoningFence).toBe(false);
  });

  it('llm_retry preserves attempt counters in trace + status message', async () => {
    const state = new TurnState(makeEntry());
    const deps = makeDeps(state);

    await handleChatEvent('tool_loop:llm_retry', {
      iteration: 2,
      attempt: 3,
      maxAttempts: 5,
      delayMs: 4000,
      reason: '500 from upstream'
    }, deps);

    expect(deps._append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'llm-retry',
      iteration: 2,
      attempt: 3,
      maxAttempts: 5,
      delayMs: 4000,
      reason: '500 from upstream'
    }));
    expect(deps.setStatusMessage).toHaveBeenCalledWith('Upstream hiccup — retrying 3 of 5 in 4s…');
  });

  it('llm_response invokes maybeShowOllamaContextWarning unconditionally; gate lives in the dep', async () => {
    const state = new TurnState(makeEntry());
    const deps = makeDeps(state);

    await handleChatEvent('tool_loop:llm_response', {
      iteration: 1,
      response: 'final answer text',
      responseLength: 17,
      hasToolCallMarkup: false,
      endsWithFenceClose: true,
      llmDurationMs: 1234
    }, deps);

    expect(deps.maybeShowOllamaContextWarning).toHaveBeenCalledOnce();
    expect(deps._append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'llm-response',
      iteration: 1,
      responseLength: 17,
      hasToolCallMarkup: false,
      endsWithFenceClose: true,
      llmDurationMs: 1234
    }));
  });
});
