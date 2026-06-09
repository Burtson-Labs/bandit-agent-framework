/**
 * `buildTurnRunContext` — pure factory that constructs everything
 * `performToolUseCompletion` needs to spin up a tool-use loop. The
 * surface is intentionally I/O-heavy (turn log, checkpoint store,
 * memory bundle, hooks, MCP servers) because the loop expects all
 * of these to exist before the first iteration; pulling the setup
 * into one place means the loop's body doesn't have to reason about
 * partially-constructed state.
 *
 * NOT in this factory:
 * - `providerSettings`, `model`, `temperature` — provider-specific
 *   resolution lives on `BanditStealthViewProvider` (it knows about
 *   Ollama auto-routing, vision-capable fallback, etc.). The
 *   provider hands them in pre-computed.
 * - Mutable per-iteration state (`pendingTimelineIds`,
 *   `pendingWriteBefore`, etc.) — that's closure state of the loop,
 *   not factory output.
 *
 * Pre-extraction (≤ v1.7.349) this was inline at the top of
 * `performToolUseCompletion`. Pulling it into a factory shaves ~85
 * lines off the god method without changing the call graph; the
 * `TurnRunContext` return type is the load-bearing scaffolding the
 * later `turnFinalize.ts` and `eventBridge.ts` extractions
 * consume.
 */
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
  createDefaultLanguageAdapters,
  createDefaultSkillRegistry,
  getAllMcpAgentTools,
  interactionSkill,
  registerWorkspaceSkills
} from '@burtson-labs/agent-core';
import {
  CheckpointStore,
  TodoStore,
  buildReadMemoryTool,
  buildRememberTool,
  buildTestRunTool,
  buildTodoWriteTool,
  buildWebFetchTool,
  buildWebSearchTool,
  loadCombinedMemory,
  loadHookSettings,
  openTurnLog,
  previewText,
  type HookSettings
} from '@burtson-labs/host-kit';
import { resolveTavilyKey } from '../helpers/banditConfigFile';
import type { ProviderContext } from '../provider/context';
import type { ConversationEntry } from '../services/conversationTypes';
import { NodeToolExecutionContext } from './nodeToolContext';

type SkillRegistry = ReturnType<typeof createDefaultSkillRegistry>;
type ToolRegistry = ReturnType<SkillRegistry['buildToolRegistryWithMap']>['registry'];
type ToolToSkillMap = ReturnType<SkillRegistry['buildToolRegistryWithMap']>['toolToSkill'];
type ActiveSkills = ReturnType<SkillRegistry['resolveActiveSkills']>;
type TurnLog = Awaited<ReturnType<typeof openTurnLog>> | null;

/**
 * Everything `performToolUseCompletion` needs to start the loop. The
 * factory returns this in one call so the caller doesn't see any
 * partially-constructed intermediate state.
 */
export interface TurnRunContext {
  workspaceRoot: string;
  toolCtx: NodeToolExecutionContext;
  skillRegistry: SkillRegistry;
  activeSkills: ActiveSkills;
  registry: ToolRegistry;
  toolToSkill: ToolToSkillMap;
  skillNameById: Map<string, string>;
  turnLog: TurnLog;
  turnId: string;
  checkpointStore: CheckpointStore;
  memoryBundle: { content: string; sources: string[] };
  hookSettings: HookSettings;
  todoStore: TodoStore;
}

export interface BuildTurnRunContextOptions {
  workspaceRoot: string;
  configuration: vscode.WorkspaceConfiguration;
  userGoal: string;
  /** Current conversation messages — used to extract the last user
   *  message so on-mention MCP servers only register when their
   *  triggers appear. */
  conversation: ConversationEntry[];
}

export async function buildTurnRunContext(
  ctx: ProviderContext,
  options: BuildTurnRunContextOptions
): Promise<TurnRunContext> {
  const { workspaceRoot, configuration, userGoal, conversation } = options;

  const toolCtx = new NodeToolExecutionContext(workspaceRoot, createDefaultLanguageAdapters(), {
    // ask_user → the webview question card, via the provider's gate service.
    requestUserInput: (req) => ctx.multiQuestionGate.request(req.questions)
  });

  // Resolve active skills (built-in + workspace custom) and build the tool registry.
  const skillRegistry = createDefaultSkillRegistry();
  // The ask_user tool ships in a host-opt-in skill (not in the default
  // registry) — the extension has an interactive webview surface, so register
  // it here alongside the built-ins.
  skillRegistry.register(interactionSkill);
  await registerWorkspaceSkills(
    skillRegistry,
    (pattern, cwd) => toolCtx.listFiles(pattern, cwd),
    (absPath) => toolCtx.readFile(absPath),
    workspaceRoot
  ).catch(() => 0);

  // Open a per-turn transcript log so we always have forensics when the
  // agent claims something it didn't actually do. Writes to
  // .bandit/turns/turn-<timestamp>.jsonl in the workspace.
  const turnLog = await openTurnLog(workspaceRoot).catch(() => null);
  await turnLog?.append({ type: 'user-prompt', prompt: previewText(userGoal) });

  // Derive a short turn id from the log filename so checkpoints
  // and turn logs line up on disk for forensic replay.
  const turnId = turnLog
    ? path.basename(turnLog.filePath).replace(/\.jsonl$/, '')
    : `turn-${Date.now()}`;
  const checkpointStore = new CheckpointStore({ workspaceRoot });

  const activeSkills = skillRegistry.resolveActiveSkills(userGoal);
  const { registry, toolToSkill } = skillRegistry.buildToolRegistryWithMap(activeSkills);
  const skillNameById = new Map(activeSkills.map((s) => [s.id, s.name]));

  // Host-kit additions: project memory (BANDIT.md / CLAUDE.md), hooks, extra tools.
  const memoryBundle = await loadCombinedMemory(workspaceRoot).catch(() => ({ content: '', sources: [] as string[] }));
  const hookSettings: HookSettings = await loadHookSettings(workspaceRoot).catch(() => ({ hooks: {} }));
  const todoStore = new TodoStore();
  registry.register(buildTodoWriteTool(todoStore));
  registry.register(buildWebFetchTool());
  // Web search — uses Tavily API. The tool returns a clear "not
  // configured" error if no key is set, so the model knows to fall
  // back to web_fetch with a known URL. Key resolution order:
  // env TAVILY_API_KEY → ~/.bandit/config.json → VS Code setting.
  registry.register(buildWebSearchTool({
    apiKey: resolveTavilyKey(configuration)
  }));
  registry.register(buildRememberTool());
  registry.register(buildReadMemoryTool());
  // test_run — auto-detect framework, parse output, hand the agent
  // a tight pass/fail summary so fix-test-rerun loops close cleanly
  // without flooding context with raw test stdout.
  registry.register(buildTestRunTool());

  // MCP tools — surface every connected server's tools as
  // `<server>.<tool>` entries in the per-turn registry. The pool is
  // session-scoped so a server spawned for prompt N is still
  // connected for prompt N+1; `getAllMcpAgentTools` is cheap on
  // subsequent turns because tool lists are cached until disconnect.
  // Off by default — empty pool = zero behavior change. Failures are
  // isolated per-server inside the pool.
  try {
    await ctx.mcp.ensureHydrated(workspaceRoot);
    if (ctx.mcpPool.list().length > 0) {
      // Pass the user's last prompt so on-mention servers only
      // register when their triggers appear in the text — keeps the
      // prompt budget small for users with many servers.
      const lastUserMessage = [...conversation].reverse().find((e) => e.role === 'user')?.content ?? '';
      const mcpTools = await getAllMcpAgentTools(ctx.mcpPool, lastUserMessage);
      for (const t of mcpTools) {registry.register(t);}
    }
  } catch (err) {
    // Defensive: pool methods are designed to swallow per-server
    // errors, but a config-loading blowup shouldn't kill the turn.
    console.warn('[mcp] tool registration failed', err);
  }

  return {
    workspaceRoot,
    toolCtx,
    skillRegistry,
    activeSkills,
    registry,
    toolToSkill,
    skillNameById,
    turnLog,
    turnId,
    checkpointStore,
    memoryBundle,
    hookSettings,
    todoStore
  };
}
