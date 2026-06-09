/**
 * Contract tests for `conversationMessages` — the lifecycle handlers
 * (select / delete / archive / clear / start-new / show-history /
 * request-clear-all).
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `handleSelectConversation` is a no-op fast-path when the
 *     requested id is already current — must NOT cancel the active
 *     stream (preserves user's mid-turn state),
 * (2) `handleClearConversation` resets intent + diff previews + busy
 *     state in the expected order (the cleanup-before-modal pattern),
 * (3) `handleDeleteConversation` routes through `openHistoryView`
 *     only when deleting the current conversation — otherwise just
 *     persists and re-syncs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';
import type { ConversationMessageDeps } from '../../src/provider/messageHandlers/conversationMessages';

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(async () => undefined) }
}));

import {
  handleClearConversation,
  handleDeleteConversation,
  handleSelectConversation
} from '../../src/provider/messageHandlers/conversationMessages';

function makeCtx(options: {
  currentId?: string;
  ensureActiveArchived?: boolean;
}): {
  ctx: ProviderContext;
  intentResetCalls: number;
  diffClearCalls: number;
  syncStateCalls: number;
  conversationsRemoveCalls: string[];
  conversationsUpdateMessagesCalls: number;
  conversationsSelectCalls: string[];
} {
  let currentId = options.currentId;
  let intentResetCalls = 0;
  let diffClearCalls = 0;
  let syncStateCalls = 0;
  const conversationsRemoveCalls: string[] = [];
  let conversationsUpdateMessagesCalls = 0;
  const conversationsSelectCalls: string[] = [];

  const activeRecord = {
    id: 'rec-active',
    name: 'Test',
    messages: [],
    archived: options.ensureActiveArchived ?? true,
    createdAt: 0,
    updatedAt: 0,
    planRuns: []
  };

  const ctx = {
    intent: { reset: () => { intentResetCalls += 1; } },
    diffPreviews: { clearSessions: async () => { diffClearCalls += 1; } },
    conversations: {
      get currentId() { return currentId; },
      ensureActive: () => activeRecord,
      updateMessages: async () => { conversationsUpdateMessagesCalls += 1; },
      select: async (id: string) => { conversationsSelectCalls.push(id); currentId = id; },
      remove: async (id: string) => { conversationsRemoveCalls.push(id); if (currentId === id) currentId = undefined; },
      setArchived: async () => undefined,
      startNew: async () => undefined,
      clearAll: async () => undefined,
      hasArchived: () => false
    },
    syncState: async () => { syncStateCalls += 1; }
  } as unknown as ProviderContext;

  return {
    ctx,
    get intentResetCalls() { return intentResetCalls; },
    get diffClearCalls() { return diffClearCalls; },
    get syncStateCalls() { return syncStateCalls; },
    conversationsRemoveCalls,
    get conversationsUpdateMessagesCalls() { return conversationsUpdateMessagesCalls; },
    conversationsSelectCalls
  } as never;
}

function makeDeps(): {
  deps: ConversationMessageDeps;
  cancelCalls: number;
  resetBusyCalls: number;
  setHistoryCalls: boolean[];
  clearActiveCalls: number;
} {
  let cancelCalls = 0;
  let resetBusyCalls = 0;
  const setHistoryCalls: boolean[] = [];
  let clearActiveCalls = 0;
  let historyVisible = false;

  const deps: ConversationMessageDeps = {
    cancelActiveStream: () => { cancelCalls += 1; },
    resetBusyImmediate: () => { resetBusyCalls += 1; },
    setHistoryVisibleImmediate: (v) => { setHistoryCalls.push(v); historyVisible = v; },
    isHistoryVisible: () => historyVisible,
    clearActiveConversationPointer: () => { clearActiveCalls += 1; }
  };

  return {
    deps,
    get cancelCalls() { return cancelCalls; },
    get resetBusyCalls() { return resetBusyCalls; },
    setHistoryCalls,
    get clearActiveCalls() { return clearActiveCalls; }
  } as never;
}

beforeEach(() => {
  // each test owns its own ctx/deps; nothing global.
});

describe('conversationMessages', () => {
  it('handleSelectConversation is a no-op fast-path when the requested id is already current (preserves mid-turn state)', async () => {
    const ctxWrap = makeCtx({ currentId: 'conv-a' });
    const depsWrap = makeDeps();

    await handleSelectConversation(ctxWrap.ctx, depsWrap.deps, 'conv-a');

    // Must NOT cancel the active stream — that would kill an
    // in-flight turn for no reason.
    expect(depsWrap.cancelCalls).toBe(0);
    expect(ctxWrap.conversationsSelectCalls).toHaveLength(0);
    // syncState fires once to re-render.
    expect(ctxWrap.syncStateCalls).toBe(1);
  });

  it("handleClearConversation cancels the stream, resets intent + diffs, un-archives the active record, then persists empty messages", async () => {
    const ctxWrap = makeCtx({ currentId: 'conv-a', ensureActiveArchived: true });
    const depsWrap = makeDeps();

    await handleClearConversation(ctxWrap.ctx, depsWrap.deps);

    expect(depsWrap.cancelCalls).toBe(1);
    expect(depsWrap.resetBusyCalls).toBe(1);
    expect(ctxWrap.intentResetCalls).toBe(1);
    expect(ctxWrap.diffClearCalls).toBe(1);
    // The active record gets un-archived (mutation visible because
    // ensureActive returns the same reference).
    expect((ctxWrap.ctx.conversations.ensureActive() as { archived: boolean }).archived).toBe(false);
    expect(ctxWrap.conversationsUpdateMessagesCalls).toBe(1);
    expect(ctxWrap.syncStateCalls).toBe(1);
  });

  it('handleDeleteConversation routes through openHistoryView only when deleting the current conversation', async () => {
    // Case A: deleting NON-current — no openHistoryView side effect
    // (no clearActiveConversationPointer, no setHistoryVisible(true)).
    {
      const ctxWrap = makeCtx({ currentId: 'conv-keep' });
      const depsWrap = makeDeps();

      await handleDeleteConversation(ctxWrap.ctx, depsWrap.deps, 'conv-other');

      expect(ctxWrap.conversationsRemoveCalls).toEqual(['conv-other']);
      expect(depsWrap.cancelCalls).toBe(0);
      expect(depsWrap.clearActiveCalls).toBe(0);
      expect(depsWrap.setHistoryCalls).toEqual([]);
      expect(depsWrap.resetBusyCalls).toBe(1);
      expect(ctxWrap.syncStateCalls).toBe(1);
    }

    // Case B: deleting CURRENT — openHistoryView path fires.
    {
      const ctxWrap = makeCtx({ currentId: 'conv-current' });
      const depsWrap = makeDeps();

      await handleDeleteConversation(ctxWrap.ctx, depsWrap.deps, 'conv-current');

      expect(ctxWrap.conversationsRemoveCalls).toEqual(['conv-current']);
      expect(depsWrap.cancelCalls).toBe(1);
      expect(depsWrap.clearActiveCalls).toBe(1);
      expect(depsWrap.setHistoryCalls).toEqual([true]);
      expect(ctxWrap.syncStateCalls).toBe(1);
    }
  });
});
