/**
 * Contract tests for the meta-events family of the tool-use-loop bridge.
 *
 * Pins three behaviors the extraction is meant to preserve:
 *
 * (1) tool_calls truncates streamed prose since the iteration boundary
 *     and turns on chunk-suppression. The truncation is what cleans up
 *     "Okay, I've read the file. Now I'll …" preambles that small models
 *     leak before they emit the actual tool call markup; a regression
 *     here would leave that preamble in the transcript.
 *
 * (2) cancelled vs compacted go down different finalize paths. cancelled
 *     writes a trace entry and that's it — the parent loop's USER_ABORT
 *     path handles the rest. compacted writes a trace entry with the
 *     before/after token counts so the user can review compaction
 *     pressure post-turn. Conflating these would make every cancellation
 *     look like a compaction (or vice versa) in the trace UI.
 *
 * (3) Trace-only meta events (hallucinated_tool_result,
 *     fired_and_forgotten_nudge, announce_intent_nudge,
 *     json_todo_auto_promoted) write to turnLog only — no state
 *     mutation, no entry mutation. These are observability signals;
 *     a regression that mutated state would silently change loop
 *     behavior on every nudge.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TurnLogger } from '@burtson-labs/host-kit';
import { TurnState } from '../../../src/agent/turnState';
import { handleMetaEvent, type MetaEventDeps } from '../../../src/agent/eventBridge/metaEvents';
import type { ConversationEntry } from '../../../src/services/conversationTypes';

function makeEntry(content = ''): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0, payload: content };
}

function makeDeps(
  state: TurnState,
  overrides?: Partial<MetaEventDeps>
): MetaEventDeps & { _append: ReturnType<typeof vi.fn>; _syncState: ReturnType<typeof vi.fn> } {
  const append = vi.fn(async () => undefined);
  const syncState = vi.fn();
  return {
    state,
    turnLog: { append, filePath: '/tmp/test.log', close: vi.fn(async () => undefined) } as unknown as TurnLogger,
    getToolLoopIteration: vi.fn((p: unknown, fallback: number) => {
      const it = (p as { iteration?: unknown } | null | undefined)?.iteration;
      return typeof it === 'number' ? it : fallback;
    }),
    syncState,
    ...overrides,
    _append: append,
    _syncState: syncState
  } as MetaEventDeps & { _append: ReturnType<typeof vi.fn>; _syncState: ReturnType<typeof vi.fn> };
}

describe('handleMetaEvent', () => {
  it('tool_calls truncates streamed prose to the iteration-start length and enables chunk suppression', async () => {
    const state = new TurnState(makeEntry('iteration-0 prefix' + 'Okay, I\'ll search...' /* leaked preamble */));
    state.currentIteration = 0;
    state.currentIterationStartLength = 'iteration-0 prefix'.length;
    state.ignoreIterationChunks = false;
    state.streamedCharsByIteration.set(0, 27);

    const deps = makeDeps(state);

    await handleMetaEvent('tool_loop:tool_calls', {
      iteration: 0,
      tools: ['search_code']
    }, deps);

    // Iteration is now flagged as a tool-using iteration so the
    // finalize-turn branch in performToolUseCompletion picks the
    // hadToolActivity transcript shape (append finalResponse below).
    expect(state.iterationsWithToolCalls.has(0)).toBe(true);
    expect(state.ignoreIterationChunks).toBe(true);
    // Streamed-chars counter for the iteration is zeroed.
    expect(state.streamedCharsByIteration.get(0)).toBe(0);
    // Preamble is gone — content was truncated to currentIterationStartLength.
    expect(state.assistantEntry.content).toBe('iteration-0 prefix');
    expect(deps._syncState).toHaveBeenCalled();
    expect(deps._append).toHaveBeenCalledWith({ type: 'tool-calls', iteration: 0, tools: ['search_code'] });
  });

  it('tool_calls KEEPS streamed reasoning while dropping the tool-call prose preamble', async () => {
    // Regression for the "reasoning disappears when a tool runs, then all
    // reappears at finalize" churn (2026-06-15, Mark). The iteration
    // streamed a reasoning fence AND a prose preamble; only the prose is
    // noise — the reasoning must stay as a stable card through the turn.
    const prefix = 'earlier transcript\n\n';
    const reasoning = '```bandit-reasoning\nI should read the manifest first.\n```';
    const preamble = '\nOkay, I will read package.json now.';
    const state = new TurnState(makeEntry(prefix + reasoning + preamble));
    state.currentIteration = 1;
    state.currentIterationStartLength = prefix.length;
    state.ignoreIterationChunks = false;

    const deps = makeDeps(state);
    await handleMetaEvent('tool_loop:tool_calls', { iteration: 1, tools: ['read_file'] }, deps);

    // Reasoning survives; prose preamble is gone.
    expect(state.assistantEntry.content).toContain('I should read the manifest first.');
    expect(state.assistantEntry.content).toContain('```bandit-reasoning');
    expect(state.assistantEntry.content).not.toContain('Okay, I will read package.json');
    expect(state.assistantEntry.content.startsWith('earlier transcript')).toBe(true);
    expect(state.iterationsWithToolCalls.has(1)).toBe(true);
  });

  it('cancelled and compacted write distinct trace entries and never touch state', async () => {
    const state = new TurnState(makeEntry('original'));
    state.currentIteration = 3;
    state.iterationsWithToolCalls.add(2);

    const deps = makeDeps(state);

    await handleMetaEvent('tool_loop:cancelled', { iteration: 3, stage: 'mid-stream' }, deps);
    expect(deps._append).toHaveBeenCalledWith({ type: 'cancelled', iteration: 3, stage: 'mid-stream' });

    await handleMetaEvent('tool_loop:compacted', {
      iteration: 3,
      messagesCompacted: 4,
      beforeTokens: 9000,
      afterTokens: 4200
    }, deps);
    expect(deps._append).toHaveBeenLastCalledWith({
      type: 'compacted',
      iteration: 3,
      messagesCompacted: 4,
      beforeTokens: 9000,
      afterTokens: 4200
    });

    // Neither cancelled nor compacted mutates state or the entry —
    // cancelled rides the parent loop's USER_ABORT path; compacted is
    // purely observational.
    expect(state.assistantEntry.content).toBe('original');
    expect(state.currentIteration).toBe(3);
    expect(state.iterationsWithToolCalls.has(2)).toBe(true);
    expect(deps._syncState).not.toHaveBeenCalled();
  });

  it('trace-only meta events touch turnLog only — no state, no entry mutation', async () => {
    const state = new TurnState(makeEntry('original'));
    const deps = makeDeps(state);

    await handleMetaEvent('tool_loop:hallucinated_tool_result', { iteration: 2, responsePreview: 'fake result' }, deps);
    await handleMetaEvent('tool_loop:fired_and_forgotten_nudge', { iteration: 3, backgroundSpawns: 2 }, deps);
    await handleMetaEvent('tool_loop:announce_intent_nudge', { iteration: 4, responsePreview: 'I will…' }, deps);
    await handleMetaEvent('tool_loop:json_todo_auto_promoted', { iteration: 5, itemCount: 3 }, deps);

    expect(deps._append).toHaveBeenCalledTimes(4);
    expect(deps._append).toHaveBeenNthCalledWith(1, { type: 'hallucinated-tool-result', iteration: 2, responsePreview: 'fake result' });
    expect(deps._append).toHaveBeenNthCalledWith(2, { type: 'fired-and-forgotten-nudge', iteration: 3, backgroundSpawns: 2 });
    expect(deps._append).toHaveBeenNthCalledWith(3, { type: 'announce-intent-nudge', iteration: 4, responsePreview: 'I will…' });
    expect(deps._append).toHaveBeenNthCalledWith(4, { type: 'json-todo-auto-promoted', iteration: 5, itemCount: 3 });
    expect(state.assistantEntry.content).toBe('original');
    expect(deps._syncState).not.toHaveBeenCalled();
  });
});
