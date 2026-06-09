/**
 * Contract tests for `buildTurnRunContext` — the pure factory that
 * spins up everything `performToolUseCompletion` needs to start a
 * loop (tool registry, skills, turn log, checkpoint store, memory,
 * hooks, MCP tools).
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) The factory returns a fully-populated `TurnRunContext` — every
 *     field is present, no partial-construction state escapes,
 * (2) Built-in tools are registered on the returned registry
 *     (todo_write / web_fetch / web_search / remember / read_memory /
 *     test_run) — these names are part of the agent's system prompt,
 *     so dropping one is a silent behavior change,
 * (3) MCP failures don't kill turn startup — when `getAllMcpAgentTools`
 *     throws, the factory swallows it and returns the rest of the
 *     context intact, so a broken server can't take down a workspace
 *     that doesn't reference it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';
import type { ProviderContext } from '../../src/provider/context';

vi.mock('vscode', () => ({}));

// ── agent-core mocks ──
const agentCoreMock = vi.hoisted(() => ({
  mcpToolsResult: [] as Array<{ name: string }>,
  mcpToolsThrow: undefined as Error | undefined,
  registeredTools: [] as Array<{ name: string }>,
  activeSkillsResult: [{ id: 'skill-a', name: 'Skill A' }],
  resetRegistered() {
    this.registeredTools.length = 0;
  }
}));

vi.mock('@burtson-labs/agent-core', () => ({
  createDefaultLanguageAdapters: () => ({}),
  // Host-opt-in skill the factory registers for the extension's interactive
  // surface. The skill-level register is a no-op here — these tests assert the
  // TOOL registry contents (built-ins + MCP), which the skill registration
  // doesn't touch in this mock.
  interactionSkill: { id: 'core/interaction', name: 'Ask the User', version: '1.0.0', description: 'mock', activation: 'always', tools: [] },
  createDefaultSkillRegistry: () => ({
    register: (_skill: unknown) => {},
    resolveActiveSkills: (_: string) => agentCoreMock.activeSkillsResult,
    buildToolRegistryWithMap: (_skills: unknown) => ({
      registry: {
        register: (tool: { name: string }) => {
          agentCoreMock.registeredTools.push(tool);
        }
      },
      toolToSkill: new Map<string, string>()
    })
  }),
  registerWorkspaceSkills: vi.fn(async () => 0),
  getAllMcpAgentTools: vi.fn(async () => {
    if (agentCoreMock.mcpToolsThrow) throw agentCoreMock.mcpToolsThrow;
    return agentCoreMock.mcpToolsResult;
  })
}));

vi.mock('@burtson-labs/host-kit', () => {
  const makeBuilder = (name: string) => () => ({ name, type: 'builtin' });
  return {
    CheckpointStore: class {},
    TodoStore: class {},
    buildTodoWriteTool: makeBuilder('todo_write'),
    buildWebFetchTool: makeBuilder('web_fetch'),
    buildWebSearchTool: makeBuilder('web_search'),
    buildRememberTool: makeBuilder('remember'),
    buildReadMemoryTool: makeBuilder('read_memory'),
    buildTestRunTool: makeBuilder('test_run'),
    loadCombinedMemory: vi.fn(async () => ({ content: 'memo', sources: ['BANDIT.md'] })),
    loadHookSettings: vi.fn(async () => ({ hooks: {} })),
    openTurnLog: vi.fn(async () => ({
      filePath: '/ws/.bandit/turns/turn-20260601-abc.jsonl',
      append: vi.fn(async () => undefined)
    })),
    previewText: (s: string) => s.slice(0, 20)
  };
});

vi.mock('../../src/agent/nodeToolContext', () => ({
  NodeToolExecutionContext: class {
    listFiles() { return []; }
    readFile() { return ''; }
  }
}));

vi.mock('../../src/helpers/banditConfigFile', () => ({
  resolveTavilyKey: () => 'tav_test_key'
}));

import { buildTurnRunContext } from '../../src/agent/toolLoopSetup';

function makeCtx(options: { mcpListCount: number }): ProviderContext {
  const list: Array<{ name: string }> = Array.from(
    { length: options.mcpListCount },
    (_, i) => ({ name: `server-${i}` })
  );
  return {
    mcp: { ensureHydrated: async () => undefined },
    mcpPool: { list: () => list }
  } as unknown as ProviderContext;
}

function fakeConfig() {
  return {
    get<T>(_: string, fallback?: T): T { return fallback as T; }
  } as unknown as import('vscode').WorkspaceConfiguration;
}

const baseOptions = {
  workspaceRoot: '/ws',
  configuration: fakeConfig(),
  userGoal: 'do the thing',
  conversation: [
    { id: 'u-1', role: 'user' as const, content: 'previous', timestamp: 0 },
    { id: 'a-1', role: 'assistant' as const, content: 'sure', timestamp: 1 },
    { id: 'u-2', role: 'user' as const, content: 'the goal', timestamp: 2 }
  ] satisfies ConversationEntry[]
};

beforeEach(() => {
  agentCoreMock.resetRegistered();
  agentCoreMock.mcpToolsThrow = undefined;
  agentCoreMock.mcpToolsResult = [];
});

describe('buildTurnRunContext', () => {
  it('returns a fully-populated TurnRunContext with every field present', async () => {
    const result = await buildTurnRunContext(makeCtx({ mcpListCount: 0 }), baseOptions);

    expect(result.workspaceRoot).toBe('/ws');
    expect(result.toolCtx).toBeDefined();
    expect(result.skillRegistry).toBeDefined();
    expect(result.activeSkills).toEqual(agentCoreMock.activeSkillsResult);
    expect(result.registry).toBeDefined();
    expect(result.toolToSkill).toBeInstanceOf(Map);
    expect(result.skillNameById.get('skill-a')).toBe('Skill A');
    expect(result.turnLog).not.toBeNull();
    // turnId derived from the log filename (strip .jsonl).
    expect(result.turnId).toBe('turn-20260601-abc');
    expect(result.checkpointStore).toBeDefined();
    expect(result.memoryBundle.content).toBe('memo');
    expect(result.memoryBundle.sources).toEqual(['BANDIT.md']);
    expect(result.hookSettings).toEqual({ hooks: {} });
    expect(result.todoStore).toBeDefined();
  });

  it('registers the six built-in tools on the returned registry (drop one = silent behavior change)', async () => {
    await buildTurnRunContext(makeCtx({ mcpListCount: 0 }), baseOptions);

    const names = agentCoreMock.registeredTools.map((t) => t.name);
    expect(names).toEqual([
      'todo_write',
      'web_fetch',
      'web_search',
      'remember',
      'read_memory',
      'test_run'
    ]);
  });

  it('MCP failures do not kill turn startup — the factory swallows and returns the rest of the context intact', async () => {
    agentCoreMock.mcpToolsThrow = new Error('mcp explode');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Pretend a server is connected so the failure path actually fires.
    const result = await buildTurnRunContext(makeCtx({ mcpListCount: 1 }), baseOptions);

    expect(result.workspaceRoot).toBe('/ws');
    expect(result.turnId).toBe('turn-20260601-abc');
    // Built-ins still made it onto the registry — only the MCP tools
    // failed.
    const names = agentCoreMock.registeredTools.map((t) => t.name);
    expect(names).toContain('todo_write');
    expect(names).toContain('test_run');
    // The defensive log fired so we have forensics.
    expect(warnSpy).toHaveBeenCalledWith('[mcp] tool registration failed', expect.any(Error));

    warnSpy.mockRestore();
  });
});
