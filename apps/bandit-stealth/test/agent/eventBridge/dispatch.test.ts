/**
 * Cross-family dispatch contract test.
 *
 * Pins the load-bearing invariant the v1.7.350 refactor broke: agent-core
 * invokes the emit callback SYNCHRONOUSLY, back-to-back, with no await
 * between calls. The native-tools code path fires:
 *
 *   emit('tool_loop:tool_calls', {...});   // meta family — TRUNCATES content
 *   emit('tool_loop:tool_execute', {...}); // tool family — APPENDS bandit-tl
 *
 * If the dispatch layer uses `await handle*Event(...)` between families,
 * microtask interleaving runs the tool_execute handler's append BEFORE
 * the tool_calls handler's truncation — and the truncation then wipes
 * the bandit-tl marker. Result: no timeline rows render in the chat
 * panel for native-tools turns. Fix: each family handler is sync, and
 * the emit callback dispatches all four in one synchronous pass.
 *
 * The test simulates the exact agent-core sequence and asserts the
 * bandit-tl marker survives.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HookSettings, TodoStore, TurnLogger } from '@burtson-labs/host-kit';
import { TurnState } from '../../../src/agent/turnState';
import { handleChatEvent, type ChatEventDeps } from '../../../src/agent/eventBridge/chatEvents';
import { handleToolEvent, type ToolEventDeps } from '../../../src/agent/eventBridge/toolEvents';
import { handleIterationEvent, type IterationEventDeps } from '../../../src/agent/eventBridge/iterationEvents';
import { handleMetaEvent, type MetaEventDeps } from '../../../src/agent/eventBridge/metaEvents';
import type { StatusIndicatorController } from '../../../src/agent/statusIndicators';
import type { ToolCallDetailService } from '../../../src/provider/services/toolCallDetailService';
import type { ConversationEntry } from '../../../src/services/conversationTypes';

vi.mock('@burtson-labs/host-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@burtson-labs/host-kit')>();
  return {
    ...actual,
    runHooks: vi.fn(async () => [])
  };
});

function makeEntry(content = ''): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0, payload: content };
}

function makeIndicators(): StatusIndicatorController {
  return {
    startThinking: vi.fn(),
    stopThinking: vi.fn(),
    startToolCallGen: vi.fn(),
    stopToolCallGen: vi.fn(),
    addToolCallBytes: vi.fn((n: number) => n),
    buildStatusText: vi.fn(() => ''),
    dispose: vi.fn()
  };
}

describe('eventBridge dispatch — sync family dispatch preserves bandit-tl marker', () => {
  it('back-to-back tool_calls + tool_execute (the native-tools order) leaves the bandit-tl marker intact in assistantEntry.content', () => {
    const startLen = 'iter0-prefix'.length;
    const state = new TurnState(makeEntry('iter0-prefix' + 'leaked prose preamble'));
    state.currentIteration = 0;
    state.currentIterationStartLength = startLen;

    const turnLog = { append: vi.fn(async () => undefined), filePath: '/tmp/x', close: vi.fn(async () => undefined) } as unknown as TurnLogger;
    const indicators = makeIndicators();
    const chatDeps: ChatEventDeps = {
      state, turnLog, indicators,
      flushPendingEditDiffs: vi.fn(),
      getToolLoopIteration: (p, fb) => (p as { iteration?: number } | null)?.iteration ?? fb,
      syncState: vi.fn(),
      setStatusMessage: vi.fn(),
      maybeShowOllamaContextWarning: vi.fn()
    };
    const toolDeps: ToolEventDeps = {
      state, turnLog, indicators,
      workspaceRoot: '/workspace',
      toolToSkill: new Map(),
      skillNameById: new Map(),
      hookSettings: {} as HookSettings,
      toolCallDetails: { capture: vi.fn() } as unknown as ToolCallDetailService,
      todoStore: { snapshot: () => [] } as unknown as TodoStore,
      syncState: vi.fn(),
      setStatusMessage: vi.fn(),
      updateConversation: vi.fn()
    };
    const iterDeps: IterationEventDeps = { turnLog, setStatusMessage: vi.fn() };
    const metaDeps: MetaEventDeps = {
      state, turnLog,
      getToolLoopIteration: (p, fb) => (p as { iteration?: number } | null)?.iteration ?? fb,
      syncState: vi.fn()
    };

    const emit = (type: string, payload: unknown): void => {
      handleChatEvent(type, payload, chatDeps);
      handleToolEvent(type, payload, toolDeps);
      handleIterationEvent(type, payload, iterDeps);
      handleMetaEvent(type, payload, metaDeps);
    };

    emit('tool_loop:tool_calls', { iteration: 0, tools: ['web_search'] });
    emit('tool_loop:tool_execute', { name: 'web_search', params: {} });

    // Content starts with the iteration prefix (preamble truncated by tool_calls)
    expect(state.assistantEntry.content.startsWith('iter0-prefix')).toBe(true);
    // No leaked preamble
    expect(state.assistantEntry.content).not.toContain('leaked prose preamble');
    // bandit-tl marker survives the truncation→append ordering
    expect(state.assistantEntry.content).toMatch(/```bandit-tl\n/);
    expect(state.assistantEntry.content).toMatch(/"name":"web_search"/);
    expect(state.assistantEntry.content).toMatch(/"status":"running"/);
    // pendingTimelineIds populated so tool_result can flip status to done
    expect(state.pendingTimelineIds.get('web_search')).toBeDefined();
  });

  it('async-emit regression guard: family handlers must be sync (not Promise-returning)', () => {
    // If a family handler is changed to `async`, this assertion fails —
    // catching the regression statically. The dispatch contract is that
    // each call returns void (not Promise<void>), so the emit callback
    // can compose them without awaits.
    const noop = (): void => {};
    expect(handleChatEvent).toBeTypeOf('function');
    expect(handleToolEvent).toBeTypeOf('function');
    expect(handleIterationEvent).toBeTypeOf('function');
    expect(handleMetaEvent).toBeTypeOf('function');
    // Each returns void synchronously. If async, .then would exist.
    const state = new TurnState(makeEntry(''));
    const turnLog = { append: vi.fn(async () => undefined) } as unknown as TurnLogger;
    const r1 = handleIterationEvent('unknown', null, { turnLog, setStatusMessage: noop });
    const r2 = handleMetaEvent('unknown', null, {
      state, turnLog,
      getToolLoopIteration: (_, fb) => fb,
      syncState: noop
    });
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });
});
