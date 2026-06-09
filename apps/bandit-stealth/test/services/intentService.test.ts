/**
 * Contract tests for `IntentService` — the intent slice of
 * conversation state (current chip, workspace-scoped memory, and
 * per-message attach/strip storage hooks).
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) `setInsight()` enriches the input with a derived `summary`
 *     before storing, and `setInsight(undefined)` clears the chip,
 * (2) `recordMemory()` merges in place when (action, summary) matches
 *     an existing entry and prepends a new entry otherwise — and
 *     persists via the workspaceState mock,
 * (3) `dismiss()` strips every intent annotation from the active
 *     conversation AND clears the live chip in one call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEntry, ConversationRecord } from '../../src/services/conversationTypes';
import type { IntentInsight, IntentMemoryEntry } from '../../src/agentTypes';
import type { ProviderContext } from '../../src/provider/context';

vi.mock('vscode', () => ({}));

import { IntentService } from '../../src/provider/services/intentService';

function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'do the thing',
    timestamp: 1,
    ...overrides
  };
}

function makeInsight(overrides: Partial<IntentInsight> = {}): IntentInsight {
  return {
    action: 'refactor',
    target: 'BanditStealthViewProvider',
    intent: 'refactor target',
    summary: 'refactor BanditStealthViewProvider',
    confidence: 0.92,
    ...overrides
  };
}

function makeCtx(initial: ConversationEntry[] = []): {
  ctx: ProviderContext;
  state: { entries: ConversationEntry[]; updateCalls: number; syncs: number; workspaceWrites: Array<{ key: string; value: unknown }> };
} {
  const state = {
    entries: [...initial],
    updateCalls: 0,
    syncs: 0,
    workspaceWrites: [] as Array<{ key: string; value: unknown }>
  };
  const conversationRecord = (): ConversationRecord => ({
    id: 'c-1',
    name: 'Test',
    messages: state.entries,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    planRuns: []
  });
  const ctx = {
    conversations: {
      getCurrent: () => conversationRecord(),
      ensureActive: () => conversationRecord(),
      updateMessages: async (next: ConversationEntry[]) => {
        state.entries = next;
        state.updateCalls += 1;
      }
    },
    extensionContext: {
      workspaceState: {
        update: async (key: string, value: unknown) => {
          state.workspaceWrites.push({ key, value });
        }
      }
    },
    syncState: async () => { state.syncs += 1; }
  } as unknown as ProviderContext;
  return { ctx, state };
}

beforeEach(() => {
  // each test owns its own ctx; nothing global.
});

describe('IntentService', () => {
  it('setInsight() enriches the input with a derived summary and clearing nulls the chip', async () => {
    const { ctx } = makeCtx();
    const svc = new IntentService(ctx, { stored: [] });

    expect(svc.current).toBeUndefined();
    await svc.setInsight(makeInsight({ summary: undefined }));
    expect(svc.current).toBeDefined();
    expect(svc.current?.action).toBe('refactor');
    // summary was derived even though the input omitted it.
    expect(typeof svc.current?.summary).toBe('string');
    expect((svc.current?.summary ?? '').length).toBeGreaterThan(0);

    await svc.setInsight(undefined);
    expect(svc.current).toBeUndefined();
  });

  it('recordMemory() merges on (action, summary) match and prepends otherwise; persists each time', async () => {
    const initial: IntentMemoryEntry[] = [
      { action: 'refactor', target: 'old', summary: 'refactor BanditStealthViewProvider', confidence: 0.4, lastUsed: 1 }
    ];
    const { ctx, state } = makeCtx();
    const svc = new IntentService(ctx, { stored: initial });

    // Same (action, summary) — merge in place. confidence + lastUsed
    // should update; the existing target is overwritten by the new
    // entry's target via the spread merge.
    await svc.recordMemory(makeInsight({ confidence: 0.95 }));
    const afterMerge = svc.memorySnapshot;
    expect(afterMerge).toHaveLength(1);
    expect(afterMerge[0].confidence).toBe(0.95);
    expect(afterMerge[0].target).toBe('BanditStealthViewProvider');
    expect(state.workspaceWrites).toHaveLength(1);

    // Different (action, summary) — prepend a new entry.
    await svc.recordMemory(makeInsight({ action: 'review', summary: 'review the PR', target: 'PR#42' }));
    const afterAdd = svc.memorySnapshot;
    expect(afterAdd).toHaveLength(2);
    expect(afterAdd[0].action).toBe('review');
    expect(afterAdd[1].action).toBe('refactor');
    expect(state.workspaceWrites).toHaveLength(2);
  });

  it('dismiss() strips intent annotations from every message in the active conversation and clears the chip', async () => {
    const annotated: ConversationEntry[] = [
      makeEntry({ id: 'm-1', intent: makeInsight({ action: 'a', summary: 'first' }) }),
      makeEntry({ id: 'm-2' }),
      makeEntry({ id: 'm-3', role: 'assistant', intent: makeInsight({ action: 'b', summary: 'second' }) })
    ];
    const { ctx, state } = makeCtx(annotated);
    const svc = new IntentService(ctx, { stored: [] });
    await svc.setInsight(makeInsight());
    expect(svc.current).toBeDefined();

    await svc.dismiss();

    expect(svc.current).toBeUndefined();
    // Both intent-bearing entries lost their annotation. The plain
    // entry was untouched.
    expect(state.entries.find((e) => e.id === 'm-1')?.intent).toBeUndefined();
    expect(state.entries.find((e) => e.id === 'm-2')?.intent).toBeUndefined();
    expect(state.entries.find((e) => e.id === 'm-3')?.intent).toBeUndefined();
    // updateMessages was called (from clearLatestFromConversation).
    expect(state.updateCalls).toBeGreaterThanOrEqual(1);
  });
});
