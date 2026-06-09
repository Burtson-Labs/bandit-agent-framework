/**
 * Contract tests for `TurnState` — the per-turn mutable state container
 * for the tool-use loop's event bridge.
 *
 * These tests pin the three behaviors the upcoming eventBridge split
 * depends on:
 * (1) empty defaults — every Map / Set / flag matches the byte-for-byte
 *     initial state the inline declarations had in performToolUseCompletion.
 *     A regression here would silently change first-iteration behavior
 *     (e.g. ignoreIterationChunks defaulting true would suppress the
 *     pure-Q&A streaming path).
 * (2) iteration reset — resetForNewIteration zeroes the streamed-chars
 *     counter for the new iteration but leaves prior-iteration counters
 *     intact. The finalize-turn path reads finalIteration's counter to
 *     decide whether to animate the model's final prose, so a regression
 *     here would either re-animate every turn or never animate.
 * (3) subagent buffer keying — bufferKeyFor returns SYNC_KEY for missing
 *     /empty taskIds and the taskId verbatim for valid strings. The
 *     2026-05-06 self-eval regression was caused by a single global
 *     subagent buffer; the per-task keying must survive every refactor.
 */
import { describe, it, expect } from 'vitest';
import { TurnState, type SubagentBuffer } from '../../src/agent/turnState';
import type { ConversationEntry } from '../../src/services/conversationTypes';

function makeEntry(): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content: '', timestamp: 0, payload: '' };
}

describe('TurnState', () => {
  it('composes with empty defaults that match the inline declarations', () => {
    const state = new TurnState(makeEntry());

    expect(state.lastAnnouncedSkillId).toBeNull();
    expect(state.pendingRunCommand).toBeNull();
    expect(state.pendingEditPath).toBeNull();

    expect(state.toolStartedAt.size).toBe(0);
    expect(state.pendingWriteBefore.size).toBe(0);
    expect(state.pendingWriteAfter.size).toBe(0);
    expect(state.pendingWriteTool.size).toBe(0);
    expect(state.pendingTimelineIds.size).toBe(0);
    expect(state.subagentBuffers.size).toBe(0);
    expect(state.streamedCharsByIteration.size).toBe(0);
    expect(state.iterationsWithToolCalls.size).toBe(0);
    expect(state.recentToolCallDisplays.length).toBe(0);

    expect(state.currentIteration).toBe(0);
    expect(state.currentIterationStartLength).toBe(0);
    expect(state.ignoreIterationChunks).toBe(false);
    expect(state.inReasoningFence).toBe(false);

    // Chat-streaming defaults consumed by buildChatFn. These need to be
    // false / 0 at turn start so the first chat() call sees a clean slate:
    // images can be attached on the first iteration, the watchdog notice
    // hasn't been shown yet, and no chats are in flight.
    expect(state.imagesAlreadySent).toBe(false);
    expect(state.inflightChats).toBe(0);
    expect(state.largePromptWatchdogNoticeShown).toBe(false);

    expect(TurnState.SYNC_KEY).toBe('sync');
    expect(TurnState.REPEAT_WINDOW).toBe(6);
  });

  it('resets iteration-local fields without clobbering prior counters', () => {
    const state = new TurnState(makeEntry());

    // Simulate iteration 0 streaming 42 chars and toggling chunk-suppression.
    state.currentIteration = 0;
    state.streamedCharsByIteration.set(0, 42);
    state.ignoreIterationChunks = true;
    state.iterationsWithToolCalls.add(0);

    state.resetForNewIteration(1, 137);

    expect(state.currentIteration).toBe(1);
    expect(state.currentIterationStartLength).toBe(137);
    expect(state.ignoreIterationChunks).toBe(false);
    // New iteration starts at zero, prior counter is preserved (the
    // finalize path reads streamedCharsByIteration.get(finalIteration)).
    expect(state.streamedCharsByIteration.get(1)).toBe(0);
    expect(state.streamedCharsByIteration.get(0)).toBe(42);
    // Tool-call set is iteration-scoped collateral — reset does NOT
    // touch it (turn-end uses iterationsWithToolCalls.size to pick the
    // hadToolActivity branch).
    expect(state.iterationsWithToolCalls.has(0)).toBe(true);
  });

  it('keys subagent buffers by payload.taskId, falling back to SYNC_KEY', () => {
    const state = new TurnState(makeEntry());

    // Synchronous subagent — no taskId.
    expect(state.bufferKeyFor({})).toBe(TurnState.SYNC_KEY);
    expect(state.bufferKeyFor(undefined)).toBe(TurnState.SYNC_KEY);
    expect(state.bufferKeyFor(null)).toBe(TurnState.SYNC_KEY);
    expect(state.bufferKeyFor({ taskId: '' })).toBe(TurnState.SYNC_KEY);
    expect(state.bufferKeyFor({ taskId: 123 })).toBe(TurnState.SYNC_KEY);

    // Backgrounded subagent — taskId is the string id.
    expect(state.bufferKeyFor({ taskId: 'task-abc' })).toBe('task-abc');

    // Independent buffers per key (the regression the keying was added to fix).
    const syncBuf: SubagentBuffer = { goal: 'foo', tools: [], backgrounded: false };
    const bgBuf: SubagentBuffer = { goal: 'bar', tools: [], backgrounded: true };
    state.subagentBuffers.set(TurnState.SYNC_KEY, syncBuf);
    state.subagentBuffers.set('task-abc', bgBuf);
    expect(state.subagentBuffers.get(TurnState.SYNC_KEY)).toBe(syncBuf);
    expect(state.subagentBuffers.get('task-abc')).toBe(bgBuf);
    expect(state.subagentBuffers.size).toBe(2);
  });
});
