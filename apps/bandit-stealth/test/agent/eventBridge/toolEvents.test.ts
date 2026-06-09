/**
 * Contract tests for the tool-events family of the tool-use-loop bridge.
 *
 * Pins five behaviors the extraction is meant to preserve byte-for-byte:
 *
 * (1) tool_execute hands the status-line label back to the active-tool
 *     label by calling indicators.stopThinking() AND
 *     indicators.stopToolCallGen() before any state mutation. This is
 *     the receive-side of the v1.7.341 label-flip threshold — agent-core
 *     measures the 5s + 1KB inside startToolCallGen / the indicator's
 *     buildStatusText loop; the bridge's job is to STOP both indicators
 *     the moment a real tool starts so the user sees the running-tool
 *     name and not a stale "streaming response · ## KB" pill. The `task`
 *     tool is the documented exception: tool_execute restarts thinking
 *     because subagent runs are 30-180s of silent thread otherwise.
 *
 * (2) tool_execute renders a `bandit-tl` timeline-row fence with id +
 *     glyph + name + primary + status + skill, and stashes the id in
 *     state.pendingTimelineIds so tool_result can find it. A regression
 *     here would either render a duplicate fence (no dedup) or never
 *     update the row from running → done.
 *
 * (3) tool_result flips the row's status from 'running' to 'done' and
 *     back-fills durationMs from state.toolStartedAt[name]. The duration
 *     is what the webview uses to render the "(2.4s)" subscript on
 *     completed timeline rows — a regression here makes every tool
 *     show 0ms regardless of how long it actually took.
 *
 * (4) tool_result for run_command appends a `bandit-run` IN/OUT card
 *     pairing the cmd from state.pendingRunCommand with the captured
 *     outputSnippet, then clears pendingRunCommand so the next tool's
 *     bandit-run doesn't inherit a stale cmd.
 *
 * (5) tool_error, tool_blocked, tool_not_found write to the turn-log
 *     with their respective event types. No assistant-entry mutation —
 *     these are trace-only signals.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HookSettings, TodoStore, TurnLogger } from '@burtson-labs/host-kit';
import { TurnState } from '../../../src/agent/turnState';
import { handleToolEvent, type ToolEventDeps } from '../../../src/agent/eventBridge/toolEvents';
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

function makeTodoStore(items: Array<{ id: number; status: 'pending' | 'in_progress' | 'done'; content: string }> = []): TodoStore {
  return { snapshot: vi.fn(() => items) } as unknown as TodoStore;
}

function makeDeps(state: TurnState, overrides?: Partial<ToolEventDeps>): ToolEventDeps & {
  _indicators: StatusIndicatorController;
  _append: ReturnType<typeof vi.fn>;
  _capture: ReturnType<typeof vi.fn>;
} {
  const indicators = makeIndicators();
  const append = vi.fn(async () => undefined);
  const turnLog = { append, filePath: '/tmp/test.log', close: vi.fn(async () => undefined) } as unknown as TurnLogger;
  const capture = vi.fn();
  const toolCallDetails = { capture } as unknown as ToolCallDetailService;
  return {
    state,
    turnLog,
    indicators,
    workspaceRoot: '/workspace',
    toolToSkill: new Map(),
    skillNameById: new Map(),
    hookSettings: {} as HookSettings,
    toolCallDetails,
    todoStore: makeTodoStore(),
    syncState: vi.fn(),
    setStatusMessage: vi.fn(),
    updateConversation: vi.fn(),
    ...overrides,
    _indicators: indicators,
    _append: append,
    _capture: capture
  } as ToolEventDeps & {
    _indicators: StatusIndicatorController;
    _append: ReturnType<typeof vi.fn>;
    _capture: ReturnType<typeof vi.fn>;
  };
}

describe('handleToolEvent', () => {
  it('tool_execute stops both indicators (v1.7.341 label-flip handoff) and renders a running bandit-tl row', async () => {
    const state = new TurnState(makeEntry(''));
    const deps = makeDeps(state);

    await handleToolEvent('tool_loop:tool_execute', {
      name: 'search_code',
      params: { pattern: 'foo' }
    }, deps);

    // v1.7.341: BOTH indicators stop on tool_execute. The chat-events module
    // is what flips the label *from* thinking/tool-call-gen via addToolCallBytes;
    // the bridge's job is to hand the label off to "Running tool: …" the moment
    // a real tool starts. A regression where only one indicator stops would
    // leave a stale `⟳ streaming response · 1.2KB` pill above the running row.
    expect(deps._indicators.stopThinking).toHaveBeenCalledOnce();
    expect(deps._indicators.stopToolCallGen).toHaveBeenCalledOnce();

    // bandit-tl fence is appended to the assistant entry with status=running.
    expect(state.assistantEntry.content).toMatch(/```bandit-tl\n/);
    expect(state.assistantEntry.content).toMatch(/"status":"running"/);
    expect(state.assistantEntry.content).toMatch(/"name":"search_code"/);
    expect(state.assistantEntry.content).toMatch(/"glyph":"→"/);

    // Timeline id is stashed for tool_result's later mutation.
    const tlId = state.pendingTimelineIds.get('search_code');
    expect(typeof tlId).toBe('string');
    expect(tlId).toMatch(/^search_code-/);

    // Repeat detection ring-buffer recorded the display.
    expect(state.recentToolCallDisplays).toContain('→ search_code foo');

    // The `task` tool exception (subagent runs are 30-180s silent) does
    // NOT apply for search_code — thinking does not restart.
    expect(deps._indicators.startThinking).not.toHaveBeenCalled();
  });

  it('tool_execute on `task` restarts the thinking indicator to break the silent-subagent freeze', async () => {
    const state = new TurnState(makeEntry(''));
    const deps = makeDeps(state);

    await handleToolEvent('tool_loop:tool_execute', { name: 'task', params: { goal: 'do thing' } }, deps);

    // The two stops fire as usual, then thinking restarts so the ticker
    // keeps cycling while the subagent works.
    expect(deps._indicators.stopThinking).toHaveBeenCalledOnce();
    expect(deps._indicators.stopToolCallGen).toHaveBeenCalledOnce();
    expect(deps._indicators.startThinking).toHaveBeenCalledOnce();
  });

  it('tool_result flips the timeline row to done and back-fills durationMs from state.toolStartedAt', async () => {
    const state = new TurnState(makeEntry(''));
    // Seed a bandit-tl row from a prior tool_execute. Match the exact
    // markup the production handler emits.
    const tlId = 'search_code-abc123-xyzw';
    const seededFence = `\n\n\`\`\`bandit-tl\n${JSON.stringify({
      id: tlId, glyph: '→', name: 'search_code', primary: 'foo', status: 'running', skill: null
    })}\n\`\`\`\n`;
    state.assistantEntry.content = seededFence;
    state.pendingTimelineIds.set('search_code', tlId);
    state.toolStartedAt.set('search_code', Date.now() - 2400); // ~2.4s ago

    const deps = makeDeps(state);
    await handleToolEvent('tool_loop:tool_result', {
      name: 'search_code',
      isError: false,
      outputLength: 42,
      outputSnippet: 'matched',
      outputFull: 'matched text'
    }, deps);

    // Row was rewritten to status=done.
    expect(state.assistantEntry.content).toMatch(/"status":"done"/);
    expect(state.assistantEntry.content).not.toMatch(/"status":"running"/);
    // durationMs was back-filled (~2400 with some slop).
    const durationMatch = state.assistantEntry.content.match(/"durationMs":(\d+)/);
    expect(durationMatch).not.toBeNull();
    const ms = Number(durationMatch?.[1]);
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(ms).toBeLessThan(5000);
    // Pending id was cleared so the next tool result doesn't match this row.
    expect(state.pendingTimelineIds.has('search_code')).toBe(false);
    // ToolCallDetail was captured.
    expect(deps._capture).toHaveBeenCalledWith(tlId, expect.objectContaining({
      tool: 'search_code',
      output: 'matched text',
      outputLength: 42,
      isError: false
    }), '/workspace');
  });

  it('tool_result for run_command appends a bandit-run IN/OUT card and clears pendingRunCommand', async () => {
    const state = new TurnState(makeEntry(''));
    state.pendingRunCommand = { cmd: 'pnpm', args: 'test' };
    state.toolStartedAt.set('run_command', Date.now() - 100);

    const deps = makeDeps(state);
    await handleToolEvent('tool_loop:tool_result', {
      name: 'run_command',
      isError: false,
      outputLength: 17,
      outputSnippet: 'all tests passed'
    }, deps);

    expect(state.assistantEntry.content).toMatch(/```bandit-run\n/);
    expect(state.assistantEntry.content).toMatch(/"cmd":"pnpm test"/);
    expect(state.assistantEntry.content).toMatch(/"out":"all tests passed"/);
    expect(state.assistantEntry.content).toMatch(/"isError":false/);
    // Stale cmd would corrupt the next run_command's card — must clear.
    expect(state.pendingRunCommand).toBeNull();
  });

  it('tool_result for todo_write renders a fresh Plan block and replaces any prior one', async () => {
    const state = new TurnState(makeEntry('preamble text'));
    state.toolStartedAt.set('todo_write', Date.now() - 50);
    state.pendingTimelineIds.set('todo_write', 'todo_write-abc-1234');
    // Seed a bandit-tl row so the status-flip path runs (the timeline
    // mutation lives in the same tool_result handler).
    state.assistantEntry.content =
      'preamble text' +
      `\n\n\`\`\`bandit-tl\n${JSON.stringify({ id: 'todo_write-abc-1234', glyph: '→', name: 'todo_write', primary: null, status: 'running', skill: null })}\n\`\`\`\n`;

    const items = [
      { id: 1, status: 'done' as const, content: 'investigate' },
      { id: 2, status: 'in_progress' as const, content: 'fix the bug' },
      { id: 3, status: 'pending' as const, content: 'write tests' }
    ];
    const deps = makeDeps(state, { todoStore: { snapshot: vi.fn(() => items) } as unknown as TodoStore });

    await handleToolEvent('tool_loop:tool_result', {
      name: 'todo_write',
      isError: false,
      outputLength: 100,
      outputSnippet: 'updated'
    }, deps);

    // Plan block appended with the three statuses rendered as ✓ / ◐ / ○.
    expect(state.assistantEntry.content).toContain('**Plan**');
    expect(state.assistantEntry.content).toContain('- ✓ investigate');
    expect(state.assistantEntry.content).toContain('- ◐ fix the bug');
    expect(state.assistantEntry.content).toContain('- ○ write tests');

    // Now simulate a SECOND todo_write later in the turn — the Plan
    // block should be REPLACED, not stacked.
    const items2 = [
      { id: 1, status: 'done' as const, content: 'investigate' },
      { id: 2, status: 'done' as const, content: 'fix the bug' },
      { id: 3, status: 'in_progress' as const, content: 'write tests' }
    ];
    state.pendingTimelineIds.set('todo_write', 'todo_write-def-5678'); // new tl id (second call)
    state.assistantEntry.content +=
      `\n\n\`\`\`bandit-tl\n${JSON.stringify({ id: 'todo_write-def-5678', glyph: '→', name: 'todo_write', primary: null, status: 'running', skill: null })}\n\`\`\`\n`;

    const deps2 = makeDeps(state, { todoStore: { snapshot: vi.fn(() => items2) } as unknown as TodoStore });
    await handleToolEvent('tool_loop:tool_result', {
      name: 'todo_write',
      isError: false,
      outputLength: 100,
      outputSnippet: 'updated again'
    }, deps2);

    // Only ONE Plan block — the second todo_write replaced the first.
    const planMatches = state.assistantEntry.content.match(/\*\*Plan\*\*/g) ?? [];
    expect(planMatches.length).toBe(1);
    // Latest content: "fix the bug" should now be ✓ done.
    expect(state.assistantEntry.content).toContain('- ✓ fix the bug');
    expect(state.assistantEntry.content).toContain('- ◐ write tests');
  });

  it('tool_error / tool_blocked / tool_not_found write to the turn log only, no entry mutation', async () => {
    const state = new TurnState(makeEntry('original content'));
    const deps = makeDeps(state);

    await handleToolEvent('tool_loop:tool_error', { name: 'apply_edit', error: 'path not found' }, deps);
    await handleToolEvent('tool_loop:tool_blocked', { name: 'run_command', reason: 'blocked by policy' }, deps);
    await handleToolEvent('tool_loop:tool_not_found', { name: 'nonexistent_tool' }, deps);

    expect(deps._append).toHaveBeenNthCalledWith(1, { type: 'tool-error', name: 'apply_edit', error: 'path not found' });
    expect(deps._append).toHaveBeenNthCalledWith(2, { type: 'tool-blocked', name: 'run_command', reason: 'blocked by policy' });
    expect(deps._append).toHaveBeenNthCalledWith(3, { type: 'tool-not-found', name: 'nonexistent_tool' });
    // No entry mutation — these are trace-only signals.
    expect(state.assistantEntry.content).toBe('original content');
  });
});
