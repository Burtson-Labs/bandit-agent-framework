/**
 * Contract tests for the subagent-events family of the tool-use-loop bridge.
 *
 * Pins four behaviors the extraction is meant to preserve:
 *
 * (1) task:start creates a per-key buffer (taskId or SYNC_KEY) and
 *     narrates "◉ Investigating: …" to the assistant entry. The
 *     per-key map is the 2026-05-06 regression fix — a single global
 *     buffer collapsed all backgrounded subagents' iter/tool counts
 *     to 0 when 7+ ran in parallel.
 *
 * (2) subagent:tool_loop:tool_execute routes to the buffer matching
 *     the payload's taskId (or SYNC_KEY when absent). Cross-buffer
 *     leakage here is what caused the v1 self-eval to show every
 *     backgrounded card as "0 tools" — events from task A landed in
 *     task B's buffer.
 *
 * (3) task:done on a backgrounded subagent renders a bandit-subagent
 *     card with the buffer's iter/tool counts and the
 *     BackgroundTaskStore record's synopsis, then deletes the buffer.
 *     A SYNC_KEY task:done deliberately does NOT render here — the
 *     parent's tool_result handler renders the sync card.
 *
 * (4) task:done drops the card silently when the assistant entry is
 *     no longer live (parent turn ended, entry filtered out by the
 *     empty-on-error path). Without this gate, an append-and-sync to
 *     a detached entry would silently miss the UI.
 */
import { describe, it, expect, vi } from 'vitest';
import type { BackgroundTaskRecord, BackgroundTaskStore, TurnLogger } from '@burtson-labs/host-kit';
import { TurnState } from '../../../src/agent/turnState';
import { handleSubagentEvent, type SubagentEventDeps } from '../../../src/agent/eventBridge/subagentEvents';
import type { ConversationEntry } from '../../../src/services/conversationTypes';

function makeEntry(content = ''): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0, payload: content };
}

function makeBackground(records: Record<string, BackgroundTaskRecord> = {}): BackgroundTaskStore {
  return {
    get: vi.fn((id: string) => records[id])
  } as unknown as BackgroundTaskStore;
}

function makeDeps(
  state: TurnState,
  overrides?: Partial<SubagentEventDeps>
): SubagentEventDeps & { _syncState: ReturnType<typeof vi.fn>; _append: ReturnType<typeof vi.fn> } {
  const syncState = vi.fn();
  const append = vi.fn(async () => undefined);
  return {
    state,
    turnLog: { append, filePath: '/tmp/test.log', close: vi.fn(async () => undefined) } as unknown as TurnLogger,
    workspaceRoot: '/workspace',
    background: makeBackground(),
    isAssistantEntryLive: vi.fn(() => true),
    syncState,
    ...overrides,
    _syncState: syncState,
    _append: append
  } as SubagentEventDeps & { _syncState: ReturnType<typeof vi.fn>; _append: ReturnType<typeof vi.fn> };
}

describe('handleSubagentEvent', () => {
  it('task:start creates a per-key buffer and narrates the goal inline', async () => {
    const state = new TurnState(makeEntry(''));
    const deps = makeDeps(state);

    // Synchronous subagent — no taskId, lands at SYNC_KEY.
    handleSubagentEvent('task:start', { goal: 'investigate the bug' }, deps);
    expect(state.subagentBuffers.get(TurnState.SYNC_KEY)).toMatchObject({
      goal: 'investigate the bug',
      tools: [],
      backgrounded: false
    });
    expect(state.assistantEntry.content).toContain('◉ Investigating: investigate the bug');
    expect(deps._syncState).toHaveBeenCalled();

    // Backgrounded subagent — keyed by taskId.
    handleSubagentEvent('task:start', { goal: 'parallel work', taskId: 'task-42', background: true }, deps);
    expect(state.subagentBuffers.get('task-42')).toMatchObject({
      goal: 'parallel work',
      tools: [],
      backgrounded: true
    });
    expect(state.subagentBuffers.size).toBe(2); // both buffers coexist
  });

  it('subagent:tool_loop:tool_execute routes to the buffer matching payload taskId', async () => {
    const state = new TurnState(makeEntry(''));
    state.subagentBuffers.set('task-A', { goal: 'A goal', tools: [], backgrounded: true });
    state.subagentBuffers.set('task-B', { goal: 'B goal', tools: [], backgrounded: true });
    state.subagentBuffers.set(TurnState.SYNC_KEY, { goal: 'sync goal', tools: [], backgrounded: false });

    const deps = makeDeps(state);

    handleSubagentEvent('subagent:tool_loop:tool_execute', {
      name: 'search_code', params: { pattern: 'foo' }, taskId: 'task-A'
    }, deps);
    handleSubagentEvent('subagent:tool_loop:tool_execute', {
      name: 'read_file', params: { path: '/x.ts' }, taskId: 'task-B'
    }, deps);
    handleSubagentEvent('subagent:tool_loop:tool_execute', {
      name: 'list_files', params: {} // no taskId → routes to SYNC_KEY
    }, deps);

    expect(state.subagentBuffers.get('task-A')?.tools.map(t => t.name)).toEqual(['search_code']);
    expect(state.subagentBuffers.get('task-B')?.tools.map(t => t.name)).toEqual(['read_file']);
    expect(state.subagentBuffers.get(TurnState.SYNC_KEY)?.tools.map(t => t.name)).toEqual(['list_files']);
  });

  it('task:done for a backgrounded subagent renders a bandit-subagent card with the store synopsis and deletes the buffer', async () => {
    const state = new TurnState(makeEntry('existing content'));
    state.subagentBuffers.set('task-42', {
      goal: 'parallel work',
      tools: [{ name: 'read_file', primary: '/foo.ts' }, { name: 'apply_edit', primary: '/foo.ts' }],
      backgrounded: true
    });

    const record = { synopsis: 'Updated foo.ts to fix the typo' } as BackgroundTaskRecord;
    const deps = makeDeps(state, { background: makeBackground({ 'task-42': record }) });

    handleSubagentEvent('task:done', { iterations: 4, hitLimit: false, taskId: 'task-42' }, deps);

    expect(state.assistantEntry.content).toContain('```bandit-subagent');
    expect(state.assistantEntry.content).toContain('parallel work');
    expect(state.assistantEntry.content).toContain('Updated foo.ts to fix the typo');
    expect(state.assistantEntry.content).toMatch(/"iterations":4/);
    expect(state.assistantEntry.content).toMatch(/"hitLimit":false/);
    expect(state.assistantEntry.content).toMatch(/"isError":false/);
    // Buffer was cleaned up — a follow-on event won't re-render this card.
    expect(state.subagentBuffers.has('task-42')).toBe(false);
    expect(deps._syncState).toHaveBeenCalled();
  });

  it('task:done drops the card when the assistant entry is no longer live', async () => {
    const state = new TurnState(makeEntry('existing content'));
    state.subagentBuffers.set('task-42', {
      goal: 'parallel work',
      tools: [{ name: 'read_file', primary: '/foo.ts' }],
      backgrounded: true
    });

    const deps = makeDeps(state, {
      background: makeBackground({ 'task-42': { synopsis: 'done' } as BackgroundTaskRecord }),
      isAssistantEntryLive: vi.fn(() => false)
    });

    handleSubagentEvent('task:done', { iterations: 1, taskId: 'task-42' }, deps);

    // Card is NOT appended. Append-and-sync to a detached entry would
    // silently miss the UI; the auto-inject path delivers the synopsis
    // on the user's next turn instead.
    expect(state.assistantEntry.content).toBe('existing content');
    expect(deps._syncState).not.toHaveBeenCalled();
    // Buffer is still deleted — preserves the original byte-for-byte behavior.
    expect(state.subagentBuffers.has('task-42')).toBe(false);
  });
});
