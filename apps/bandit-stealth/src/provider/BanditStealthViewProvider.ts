/**
 * BanditStealthViewProvider — VS Code WebviewViewProvider hosting the
 * Bandit chat UI. Owns view binding, the agent run orchestrator
 * (performToolUseCompletion), the message dispatcher (handleMessage),
 * the agent-event bridge (applyAgentEnvironmentMessage), and the
 * stateful intent/account/conversation methods that hold class
 * fields. Constructed once in activate() (../extension.ts) and
 * registered as a singleton view.
 *
 * Cohesive concerns are extracted into ../helpers/, ../agent/,
 * ../commands/, ../provider/, and ../slash/.
 */
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import type { McpClientPool} from '@burtson-labs/agent-core';
import { createToolUseLoop, createDefaultLanguageAdapters, createDefaultSkillRegistry, registerWorkspaceSkills, TelemetryExporter, resolveTelemetryConfig, type ChatFn, type ToolLoopMessage } from '@burtson-labs/agent-core';
import {
  runHooks,
  buildTaskTool,
  buildCheckTaskTool,
  buildListTasksTool,
  buildInsightsAiCallback,
  type AiSummaryFn,
  type OneShotChatFn,
  InMemoryBackgroundTaskStore,
  type BackgroundTaskRecord,
  type BackgroundTaskStore,
  SessionPermissionStore,
  previewText,
  CheckpointStore
} from '@burtson-labs/host-kit';
import type { AIChatRequest, AIChatResponse, AIMessageContentPart , OllamaEmbeddingClient} from '@burtson-labs/stealth-core-runtime';
import { createProvider, type ProviderKind, type ProviderSettings, buildSlimContext, getModelCapabilities, getModelBehaviorProfile, resolveOllamaRuntimeOptions, type BuiltContext } from '@burtson-labs/stealth-core-runtime';
import type { StealthAgentRuntime} from '../agent/agentRuntime';
import { type IUndoManager } from '../agent/agentRuntime';
import { buildTurnRunContext } from '../agent/toolLoopSetup';
import { composeFinalAssistantEntry, finalizeTurnAlways, finalizeTurnError, finalizeTurnSuccess } from '../agent/turnFinalize';
import { TurnState } from '../agent/turnState';
import { buildChatFn } from '../agent/chatFn';
import { buildBeforeToolExecute } from '../agent/beforeToolExecute';
import { dispatchAgentEnvironmentMessage } from '../agent/agentEnvironmentBridge';
import { runOcrFallback } from '../agent/ocrFallback';
import { runLegacyDirectStream } from '../agent/legacyDirectStream';
import { composeAgentSystemPrompt } from '../agent/agentSystemPrompt';
import { buildFlushPendingEditDiffs } from '../agent/diffFlush';
import { buildMaybeShowOllamaContextWarning } from '../agent/ollamaContextWarning';
import { handleChatEvent, type ChatEventDeps } from '../agent/eventBridge/chatEvents';
import { handleToolEvent, type ToolEventDeps } from '../agent/eventBridge/toolEvents';
import { handleIterationEvent, type IterationEventDeps } from '../agent/eventBridge/iterationEvents';
import { handleSubagentEvent, type SubagentEventDeps } from '../agent/eventBridge/subagentEvents';
import { handleMetaEvent, type MetaEventDeps } from '../agent/eventBridge/metaEvents';
import { NodeToolExecutionContext } from '../agent/nodeToolContext';
import type { PromptPipeline } from '../agent/promptPipeline';
import { ConversationService } from '../services/conversationService';
import { environmentService } from '../agent/environmentService';
import type { AgentReport, Plan } from '@burtson-labs/stealth-core-runtime';
import type { DiffContentProvider } from '../diffContentProvider';
import {
  isLikelyBinary
} from '../helpers/formatting';
import {
  formatAgentReport,
  buildAgentSummaryHeadline,
  buildAgentSummaryPayload,
  describeAgentReport
} from '../helpers/agentReport';
import { buildSystemPrompt } from '../helpers/systemPrompt';
import {
  collectCompletionResult,
  extractJsonObject,
  truncateForFeedback,
  buildIntentClassificationMessages,
  buildFeedbackTriageMessages
} from '../helpers/completion';
import {
  sanitizeConversationName,
  deriveConversationNameFromEntries,
  createConversationId,
  createConversationEntry,
  normalizeConversationFeedback
} from '../helpers/conversation';
import { clonePlan, createPlanRunId } from '../helpers/plan';
import { ToolCallDetailService } from './services/toolCallDetailService';
import { PermissionGateService } from './services/permissionGateService';
import { MultiQuestionGateService } from './services/multiQuestionGateService';
import { BackgroundTaskCoordinator } from './services/backgroundTaskCoordinator';
import { AccountService } from './services/accountService';
import { IntentService } from './services/intentService';
import { DiffPreviewService } from './services/diffPreviewService';
import { VoiceService } from './services/voiceService';
import { McpService } from './services/mcpService';
import {
  summarizeIntent,
  normalizeIntentInsight
} from '../helpers/intent';
import {
  resolveIntentUrl,
  resolveSemanticUrl,
  resolveFeedbackUrl
} from '../helpers/endpoints';
import { buildWebviewHtml } from '../helpers/webviewHtml';
import { searchWorkspaceFiles } from '../helpers/workspaceFileSearch';
import { readVoiceProviderSettings, readVoiceGates } from '../helpers/voiceConfig';
import {
  writeTavilyKeyToBanditConfig,
  clearTavilyKeyFromBanditConfig,
  resolveTavilyKey,
  readBanditConfig
} from '../helpers/banditConfigFile';
import { handleSlashCommand as dispatchSlashCommand } from '../slash';

import {
  API_KEY_SECRET_KEY,
  OLLAMA_AUTH_SECRET_KEY,
  CONVERSATION_STORAGE_KEY,
  CONVERSATION_HISTORY_STORAGE_KEY,
  MODE_STORAGE_KEY,
  INTENT_MEMORY_STORAGE_KEY
} from '../storageKeys';
import { createStatusIndicators } from '../agent/statusIndicators';
import { SlowStateCache } from './slowStateCache';
import type { ProviderContext } from './context';
import {
  dispatchConfigMessage
} from './messageHandlers/configMessages';
import {
  type ConversationMessageDeps,
  dispatchConversationMessage,
  handleClearConversation
} from './messageHandlers/conversationMessages';
import { dispatchMcpMessage } from './messageHandlers/mcpMessages';
import {
  type ApiKeyMessageDeps,
  dispatchApiKeyMessage
} from './messageHandlers/apiKeyMessages';
import {
  dispatchTraceMessage,
  handleRequestTraceList
} from './messageHandlers/traceMessages';
import {
  type PlanMessageDeps,
  dispatchPlanMessage
} from './messageHandlers/planMessages';
import {
  type BridgeMessageDeps,
  dispatchBridgeMessage
} from './messageHandlers/bridgeMessages';

import type {
  ConversationRole,
  ConversationEntry,
  ConversationPlanStepState,
  ConversationPlanRun,
  ConversationRecord,
  ConversationSummary,
  ModeKind,
  FeedbackRating
} from '../services/conversationTypes';
import type {
  IntentInsight,
  IntentMemoryEntry,
  FeedbackRequest,
  WebviewState
} from '../agentTypes';
import type {
  IncomingMessage,
  OutgoingMessage,
  TraceListMode
} from '../messages';
export class BanditStealthViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, ProviderContext {
  public static readonly viewType = 'banditStealth.chat';

  public view: vscode.WebviewView | undefined;
  public readonly conversations: ConversationService;
  private isBusy = false;
  private pendingPrompt: string | undefined;
  private pendingOpenSettings = false;
  private activeStream: AsyncIterator<AIChatResponse> | undefined;
  // Per-turn cancellation. Created at the start of each tool-use-loop chat
  // turn (the simple non-agent chat path uses `activeStream` instead).
  // `cancelActiveStream()` aborts this — the loop, the chat function, and
  // the underlying provider request all see signal.aborted and unwind.
  private activeAbortController: AbortController | undefined;
  private activeTurnStartedAt = 0;
  /** App-level OTLP telemetry exporter — opt-in, off by default. One instance,
   *  re-resolved per turn from ~/.bandit/config.json so a config change takes
   *  effect without a reload. Turns are serial per provider, so one instance is
   *  safe. Tagged service.name=bandit-extension to separate IDE from CLI. */
  private telemetry: TelemetryExporter | null = null;
  private statusText = 'Ready';
  private ollamaStatus: 'ready' | 'offline' | 'no-model' | 'unknown' = 'unknown';
  private ollamaModelMissing: string | undefined;
  /** One-shot guard for the Ollama context-length tip. Fires after the
   * first tool_loop:llm_response event when the loaded num_ctx is too
   * low — see checkOllamaLoadedContext. Reset is per-session-lifetime
   * (no setter); we don't repeat the toast even after a reload because
   * the user has been told once and a fix requires restarting Ollama. */
  private ollamaContextWarned = false;
  private activeMode: ModeKind;
  /** Per-session "always allow for this session" permission grants. */
  public readonly permissions = new SessionPermissionStore();
  /** Long-lived background-subagent task store. Lives for the lifetime
   * of the webview view; tasks survive across user prompts so the
   * agent can spawn detached work, keep talking, and pick up the
   * synopsis on a later turn. Webview live-tile subscribes to the
   * events emitted here. */
  public readonly background: BackgroundTaskStore = new InMemoryBackgroundTaskStore();
  /** In-chat permission card injector + resolver. Owns the
   *  `pendingPermissions` map and the card lifecycle (inject →
   *  resolve → replace marker). See
   *  `services/permissionGateService.ts`. Constructed in the
   *  constructor body because the service takes `this` as its
   *  `ProviderContext`. */
  public readonly permissionGate: PermissionGateService;
  /** In-chat ask-user card bridge — posts `userInputRequest` to the webview
   *  and resolves the `ask_user` tool's Promise when the user submits. See
   *  `services/multiQuestionGateService.ts`. Constructed in the constructor
   *  body because the service takes `this` as its `ProviderContext`. */
  public readonly multiQuestionGate: MultiQuestionGateService;

  // ── Delegation properties for ConversationService ───────────────────────────
  // These bridge existing call sites to the extracted service without changing
  // every reference. They'll be removed when the full migration is complete.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get conversationHistory() { return (this.conversations as any)['history'] as Map<string, ConversationRecord>; }
  private get currentConversationId() { return this.conversations.currentId; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private set currentConversationId(v: string | undefined) { (this.conversations as any)['_currentId'] = v; }
  private get conversation() { return this.conversations.messages; }
  private set conversation(v: ConversationEntry[]) { /* no-op: messages managed by service */ }
  private get historyVisible() { return this.conversations.historyVisible; }
  private set historyVisible(v: boolean) { this.conversations.historyVisible = v; }
  /** Intent slice — current detection, workspace-scoped memory, and
   *  the per-message attach/strip storage hooks. See
   *  `services/intentService.ts`. Constructed in the constructor
   *  body — needs `this` as its ProviderContext and the stored
   *  memory list from workspaceState. */
  public readonly intent: IntentService;
  /** Agent-edit diff preview lifecycle — extract, present, apply /
   *  explain / discard, restore-from-backup. See
   *  `services/diffPreviewService.ts`. Constructed in the constructor
   *  body. */
  public readonly diffPreviews: DiffPreviewService;
  /** Voice surface: TTS auto-speak + manual playback, STT, and the
   *  extension-side mic recorder (probe / install offer / start /
   *  stop / cancel). See `services/voiceService.ts`. */
  public readonly voice: VoiceService;
  private agentActivityQueue: Promise<void> = Promise.resolve();
  private agentEnvironmentSubscription: vscode.Disposable | undefined;
  private workspaceFileIndex: string[] | undefined;
  private syncScheduled = false;
  private syncPromise: Promise<void> | undefined;
  // Per-turn cache of slow-changing webview-state fields. Pre-v1.7.347
  // `flushState` ran on a 16 ms debounce during streaming and on every
  // tick did 2× `await context.secrets.get(...)` + `await
  // buildMcpSnapshot(...)` + `resolveTavilyKey(config)` even though none
  // of those values change during a single turn — secrets only mutate
  // on explicit user action and MCP pool state is stable mid-stream.
  // At sustained 30-60 tok/s that was ~120 secret reads/sec + ~60 MCP
  // snapshot builds/sec for fields the webview reads but doesn't change.
  // Cache populates on the first flush of a turn, reuses for every
  // subsequent flush until slowStateCache.invalidate() fires from a key
  // mutation, config change, or MCP pool change.
  public readonly slowStateCache = new SlowStateCache();
  /** Bandit Cloud account profile + usage fetches. See
   *  `services/accountService.ts`. Constructed in the constructor
   *  body — takes `this` as its ProviderContext. */
  public readonly account: AccountService;
  /** Session-scoped MCP client pool lifecycle — lazy init behind
   *  trust gate, hydration, reload, snapshot, sync API key cache.
   *  See `services/mcpService.ts`. Constructed in the constructor
   *  body. */
  public readonly mcp: McpService;
  /** Mid-turn background-completion injection coordinator (v1.7.336+).
   *  Owns the queue of subagent completions that arrive WHILE the
   *  parent agent loop is iterating, plus the per-turn drain and the
   *  webview cancel/dismiss bridges. See
   *  `services/backgroundTaskCoordinator.ts`. Constructed in the
   *  constructor body — it takes `this` as its ProviderContext. */
  public readonly backgroundTasks: BackgroundTaskCoordinator;

  /** Provider-side delegate for the `ProviderContext.mcpPool`
   *  contract. Keeps the existing external API surface intact while
   *  routing through the McpService instance. */
  public get mcpPool(): McpClientPool {
    return this.mcp.pool;
  }
  /** Tool-call detail cache + click-to-open handler. Owns the per-runId
   *  Map, the 1000-entry eviction policy, and the disk-store
   *  composition. See `services/toolCallDetailService.ts`. */
  public readonly toolCallDetails = new ToolCallDetailService();
  private undoSnapshotsAvailable = false;
  public readonly undo: IUndoManager;
  /** Lazily initialized local embedding client (nomic-embed-text). */
  private localEmbeddingClient: OllamaEmbeddingClient | undefined;

  /** Fires whenever the provider's busy/status state changes. */
  private readonly _onDidChangeStatus = new vscode.EventEmitter<{ busy: boolean; text: string; contextBudget?: { tokenEstimate: number; contextWindow: number; source: string } }>();
  public readonly onDidChangeStatus: vscode.Event<{ busy: boolean; text: string; contextBudget?: { tokenEstimate: number; contextWindow: number; source: string } }> = this._onDidChangeStatus.event;

  /** Last known context budget from ContextBuilder — shown in status bar tooltip. */
  private lastContextBudget: { tokenEstimate: number; contextWindow: number; source: string } | undefined;

  /** ProviderContext accessor — returns the constructor-injected
   *  `vscode.ExtensionContext`. Internal call sites still use
   *  `this.context` directly to avoid a 100-site rename. */
  public get extensionContext(): vscode.ExtensionContext { return this.context; }

  /** Deps bundle the extracted conversationMessages handlers need —
   *  preserves the pre-extraction "set busy fields without firing
   *  events" behavior via callbacks rather than going through
   *  setBusy/setStatusMessage. */
  private readonly convMessageDeps: ConversationMessageDeps = {
    cancelActiveStream: () => this.cancelActiveStream(),
    resetBusyImmediate: () => { this.isBusy = false; this.statusText = 'Ready'; },
    setHistoryVisibleImmediate: (value) => { this.historyVisible = value; },
    isHistoryVisible: () => this.historyVisible,
    // The setter for `currentConversationId` mutates the ConversationService
    // internally via the existing delegate. The `this.conversation = []`
    // assignment is a no-op via a no-op setter but is preserved for
    // behavioral fidelity to the pre-extraction code. `clearActivePlan`
    // drops the active plan pointer in ConversationService.
    clearActiveConversationPointer: () => {
      this.currentConversationId = undefined;
      this.conversation = [];
      this.conversations.clearActivePlan();
    }
  };

  /** Deps the apiKey message handlers need — `setApiKey`
   *  specifically uses the no-event "drop busy flag" pattern. */
  private readonly apiKeyMessageDeps: ApiKeyMessageDeps = {
    cancelActiveStream: () => this.cancelActiveStream(),
    resetBusyImmediate: () => { this.isBusy = false; }
  };

  /** Deps the planMessages handlers need — `replayStep` lives on
   *  the agent runtime (not on ProviderContext) and
   *  `undoSnapshotsAvailable` is a provider-internal flag that the
   *  undo `finally` writes regardless of success/failure. */
  private readonly planMessageDeps: PlanMessageDeps = {
    replayPlanStep: (stepId, mode) => this.agentRuntime.replayStep(stepId, mode),
    setUndoSnapshotsAvailable: (value) => { this.undoSnapshotsAvailable = value; }
  };

  /** Deps for the `agent:*` event bridge — only `arePlanArtifactsEnabled`
   *  is provider-bound (it reads `banditStealth.debug.emitPlanJson`).
   *  Everything else flows through `ProviderContext.conversations`. */
  private readonly agentEnvironmentBridgeDeps = {
    arePlanArtifactsEnabled: (): boolean => {
      const configuration = vscode.workspace.getConfiguration('banditStealth');
      return configuration.get<boolean>('debug.emitPlanJson', true);
    }
  };

  /** Deps the bridgeMessages handlers need — the feedback
   *  pipeline (conversation lookup, optimistic-then-finalize flow,
   *  network submit + fallback) is still too coupled to the
   *  provider's chat state to extract into a service, so the
   *  submitFeedback handler delegates back via this callback. */
  private readonly bridgeMessageDeps: BridgeMessageDeps = {
    submitFeedback: (messageId, rating) => this.handleFeedbackSubmission(messageId, rating)
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agentRuntime: StealthAgentRuntime,
    private readonly promptPipeline: PromptPipeline,
    public readonly diffContentProvider: DiffContentProvider
  ) {
    this.undo = this.agentRuntime.getUndoManager();
    const storedMode = context.workspaceState.get<ModeKind>(MODE_STORAGE_KEY, 'ask');
    this.activeMode = storedMode === 'agent' ? 'agent' : 'ask';

    // ConversationService handles all state loading, normalization, and persistence.
    this.conversations = new ConversationService({
      storage: context.workspaceState,
      historyStorageKey: CONVERSATION_HISTORY_STORAGE_KEY,
      legacyStorageKey: CONVERSATION_STORAGE_KEY
    });

    // PermissionGateService takes `this` as its ProviderContext, so it
    // must be constructed AFTER conversations (the only service slot
    // the gate's ctx-typed parameter strictly needs to be populated).
    this.permissionGate = new PermissionGateService(this);
    this.multiQuestionGate = new MultiQuestionGateService(this);
    this.backgroundTasks = new BackgroundTaskCoordinator(this);
    this.account = new AccountService(this);
    this.diffPreviews = new DiffPreviewService(this, {
      sendFeedback: (payload, configuration) => this.sendFeedbackRequest(payload, configuration)
    });
    this.voice = new VoiceService(this);
    this.mcp = new McpService(this);

    const storedIntentMemory = context.workspaceState.get<IntentMemoryEntry[]>(INTENT_MEMORY_STORAGE_KEY) ?? [];
    this.intent = new IntentService(this, { stored: storedIntentMemory });

    this.undoSnapshotsAvailable = this.undo.hasSnapshots();
    const snapshotSubscription = this.undo.onDidUpdateSnapshots((count) => {
      const nextAvailable = count > 0;
      if (nextAvailable === this.undoSnapshotsAvailable) {
        return;
      }
      this.undoSnapshotsAvailable = nextAvailable;
      void this.syncState();
    });
    context.subscriptions.push(snapshotSubscription);

    this.agentEnvironmentSubscription = environmentService.subscribe((message) => {
      this.handleAgentEnvironmentMessage(message);
    });
    context.subscriptions.push(this.agentEnvironmentSubscription);

    this.background.on('complete', (record) => {
      this.notifyUser('background', 'Bandit background task complete', `${record.id}: ${record.goal.slice(0, 160)}`);
      this.backgroundTasks.enqueue(record);
    });
    this.background.on('failed', (record) => {
      this.notifyUser('error', 'Bandit background task failed', `${record.id}: ${record.error ?? record.goal}`);
      this.backgroundTasks.enqueue(record);
    });
    this.background.on('cancelled', (record) => {
      this.backgroundTasks.enqueue(record);
    });

    void this.loadWorkspaceFileIndex().catch(() => {
      // Ignore index warmup failures; we'll retry lazily when needed.
    });
    void this.account.refresh();
  }

  public async reveal(presetPrompt?: string): Promise<void> {
    this.pendingPrompt = presetPrompt ?? this.pendingPrompt;
    await vscode.commands.executeCommand('banditStealth.chat.focus');

    if (this.view) {
      this.view.show?.(true);
      await this.syncState();
    }
  }

  public async openTraceViewer(mode: TraceListMode = 'all'): Promise<void> {
    await this.reveal();
    await handleRequestTraceList(this, mode);
  }

  public async promptForApiKey(): Promise<void> {
    const secret = await vscode.window.showInputBox({
      prompt: 'Enter your Bandit AI key',
      placeHolder: 'bai_...',
      ignoreFocusOut: true,
      password: true
    });

    if (!secret) {
      return;
    }

    await this.context.secrets.store(API_KEY_SECRET_KEY, secret.trim());
    this.slowStateCache.invalidate();
    await this.syncState();
    // silent — the settings surface flips to "key set".
    void this.account.refresh();
  }

  public async clearApiKey(): Promise<void> {
    this.cancelActiveStream();
    await this.context.secrets.delete(API_KEY_SECRET_KEY);
    this.slowStateCache.invalidate();
    await this.syncState();
    // silent success — key-removed confirmation was a reliable noise source.
    void this.account.refresh();
  }

  public async setOllamaAuthToken(rawValue?: string): Promise<void> {
    // Prompt when called without a value (from the Command Palette). The
    // inline settings panel passes the value directly via postMessage.
    const value = typeof rawValue === 'string'
      ? rawValue
      : await vscode.window.showInputBox({
        title: 'Ollama Auth Token',
        prompt: 'Bearer token or proxy credential for your custom Ollama endpoint. Sent as Authorization: Bearer <token>.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste your token (stored in VS Code secrets)'
      });
    const trimmed = (value ?? '').trim();
    if (!trimmed) {return;}
    await this.context.secrets.store(OLLAMA_AUTH_SECRET_KEY, trimmed);
    this.slowStateCache.invalidate();
    await this.syncState();
  }

  public async clearOllamaAuthToken(): Promise<void> {
    await this.context.secrets.delete(OLLAMA_AUTH_SECRET_KEY);
    this.slowStateCache.invalidate();
    await this.syncState();
  }

  /** BYOK entry point for the Tavily web-search API key. The key is now
   *  written to TWO locations so it stays in sync between the IDE and
   *  the CLI:
   *
   *    1. ~/.bandit/config.json `tools.tavily.apiKey` — the canonical
   *       location the CLI's `/tavily` command writes to. Setting it
   *       from the IDE means the CLI sees the same key on the next
   *       turn (and vice versa) — same file, both read it.
   *    2. The VS Code global setting `banditStealth.webSearch.tavilyApiKey` —
   *       kept for backward compat: existing users who set the key
   *       there before v1.7.332 won't have to re-enter it, and Settings
   *       Sync still carries the value across devices.
   *
   *  Resolution order at read time: env TAVILY_API_KEY → ~/.bandit/config.json →
   *  VS Code setting. Env always wins (per-shell override); the file is
   *  the user's stored choice; the VS Code setting is the legacy fallback. */
  public async setTavilyKey(rawValue?: string): Promise<void> {
    const value = typeof rawValue === 'string'
      ? rawValue
      : await vscode.window.showInputBox({
        title: 'Tavily Web Search API Key',
        prompt: 'Paste your Tavily API key (free tier at https://tavily.com). Enables the agent\'s web_search tool — ranked snippets for docs, library APIs, and error messages.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'tvly-...'
      });
    const trimmed = (value ?? '').trim();
    if (!trimmed) {return;}
    // Canonical write — same file the CLI's /tavily command writes to.
    try {
      writeTavilyKeyToBanditConfig(trimmed);
    } catch (err) {
      // Soft-fail to VS Code setting only — better partial sync than
      // a hard failure when the home dir isn't writeable (rare, but
      // ssh-fs setups and locked-down corporate machines hit this).
      void vscode.window.showWarningMessage(
        `Bandit: saved Tavily key to VS Code settings, but couldn't write ~/.bandit/config.json (${err instanceof Error ? err.message : String(err)}). The CLI may not see this key.`
      );
    }
    // Legacy / Settings Sync mirror.
    const config = vscode.workspace.getConfiguration('banditStealth');
    await config.update('webSearch.tavilyApiKey', trimmed, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('Bandit: Tavily key saved (shared with CLI). web_search is now enabled.');
    this.slowStateCache.invalidate();
    await this.syncState();
  }

  public async clearTavilyKey(): Promise<void> {
    // Clear both locations so neither surface holds a stale key.
    try { clearTavilyKeyFromBanditConfig(); } catch { /* best-effort */ }
    const config = vscode.workspace.getConfiguration('banditStealth');
    await config.update('webSearch.tavilyApiKey', undefined, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('Bandit: Tavily key cleared from both VS Code settings and ~/.bandit/config.json. web_search now returns "not configured" until you set a new key.');
    await this.syncState();
  }

  public async showApiKeyOverlay(): Promise<void> {
    this.pendingOpenSettings = true;
    await this.reveal();
    if (this.view) {
      this.postMessage({ type: 'openSettings' });
      this.pendingOpenSettings = false;
    }
  }

  public async setPendingPrompt(prompt: string): Promise<void> {
    this.pendingPrompt = prompt;
    await this.syncState();
  }

  public setOllamaStatus(status: 'ready' | 'offline' | 'no-model' | 'unknown', missingModel?: string): void {
    this.ollamaStatus = status;
    this.ollamaModelMissing = missingModel;
    void this.syncState();
  }

  public async toggleMode(): Promise<void> {
    const nextMode: ModeKind = this.activeMode === 'agent' ? 'ask' : 'agent';
    await this.updateActiveMode(nextMode, { announce: true });
  }

  private async updateActiveMode(mode: ModeKind, options?: { announce?: boolean }): Promise<void> {
    if (mode !== 'ask' && mode !== 'agent') {
      return;
    }
    if (this.activeMode === mode) {
      return;
    }
    this.activeMode = mode;
    await this.context.workspaceState.update(MODE_STORAGE_KEY, mode);
    await this.syncState();
    if (options?.announce) {
      const label = mode === 'agent' ? 'Agent' : 'Ask';
      void vscode.window.showInformationMessage(`Bandit Stealth switched to ${label} mode.`);
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    environmentService.setWebview(view.webview);

    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message: IncomingMessage) => {
      void this.handleMessage(message);
    });

    // Push background-task lifecycle events to the webview so the
    // live-tile reflects state in real time. We bind these listeners
    // once per view-resolve — VS Code calls resolveWebviewView when
    // the view first becomes visible, and again after disposal if the
    // user closes + reopens the panel. The store survives across
    // those resolves because it's a class field; the listener wiring
    // is per-resolve so we always talk to the freshest webview.
    const broadcastTask = (record: BackgroundTaskRecord) => {
      this.postMessage({ type: 'backgroundTaskUpdate', task: record });
    };
    this.background.on('start', broadcastTask);
    this.background.on('progress', broadcastTask);
    this.background.on('complete', broadcastTask);
    this.background.on('failed', broadcastTask);
    this.background.on('cancelled', broadcastTask);
    // Initial snapshot — webview asks us the same thing via
    // requestState but that's geared to the chat view; this is the
    // dedicated bg-task push so the tile renders immediately on mount
    // even mid-conversation.
    this.postMessage({ type: 'backgroundTaskList', tasks: this.background.list() });

    void this.syncState();

    // Hydrate the MCP pool eagerly on first view-resolve so the
    // Settings → Connections panel has data the instant the user
    // opens it. Wrapped in try/catch so any MCP failure (missing
    // node_modules, SDK ESM/CJS resolution issue, malformed config
    // file) degrades silently to "no MCP" instead of blocking
    // extension activation — MCP is opt-in, never a hard dep.
    void (async () => {
      try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        await this.mcp.ensureHydrated(root);
        await this.syncState();
      } catch (err) {
        console.warn('[bandit][mcp] hydrate-on-resolve failed', err);
      }
    })();

    // Terminal-mode routing. When the user has banditStealth.useTerminal
    // turned on, clicking the Activity Bar icon (which is the only way
    // VS Code "opens" the view — it bypasses the askBandit command, so
    // the existing revealWithSelection check is skipped) should still
    // spawn the integrated-terminal CLI. Fire once when the view first
    // becomes visible and again on subsequent visibility transitions
    // if the user has since flipped the setting on. Gated by a
    // per-session "already opened" flag so toggling between views
    // doesn't respawn the terminal on every tab switch.
    const tryOpenTerminalIfEnabled = () => {
      const useTerminal = vscode.workspace
        .getConfiguration('banditStealth')
        .get<boolean>('useTerminal', false);
      if (!useTerminal) {return;}
      // De-dupe: VS Code fires onDidChangeVisibility multiple times as
      // the Activity Bar repaints. Keep the launch to one per session
      // unless the user explicitly dismisses and re-opens the terminal.
      const existingBanditTerminal = vscode.window.terminals.find(t => t.name === 'Bandit');
      if (existingBanditTerminal) {
        existingBanditTerminal.show();
        return;
      }
      void vscode.commands.executeCommand('banditStealth.openInTerminal');
    };
    tryOpenTerminalIfEnabled();
    view.onDidChangeVisibility(() => {
      if (view.visible) {tryOpenTerminalIfEnabled();}
    });
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (message.type === 'requestState') {
      await this.syncState();
      return;
    }

    // Topic dispatchers — each owns a cluster of related message types
    // and returns `true` once it handles one. First match wins.
    const configDeps = { syncState: () => this.syncState() };
    if (await dispatchApiKeyMessage(this, this.apiKeyMessageDeps, message)) {return;}
    if (await dispatchMcpMessage(this, message)) {return;}
    if (await dispatchConversationMessage(this, this.convMessageDeps, message)) {return;}
    if (await dispatchBridgeMessage(this, this.bridgeMessageDeps, message)) {return;}
    if (await dispatchPlanMessage(this, this.planMessageDeps, message)) {return;}
    if (await dispatchTraceMessage(this, message)) {return;}
    if (await dispatchConfigMessage(configDeps, message)) {return;}

    // Provider-bound credentials — these stay inline because each calls
    // a provider-class method directly. Moving them into a topic file
    // would require a deps callback per call site without net LOC win.
    if (message.type === 'setOllamaAuthToken') {
      await this.setOllamaAuthToken(message.value);
      return;
    }
    if (message.type === 'clearOllamaAuthToken') {
      await this.clearOllamaAuthToken();
      return;
    }
    if (message.type === 'setTavilyKey') {
      await this.setTavilyKey(message.value);
      return;
    }
    if (message.type === 'clearTavilyKey') {
      await this.clearTavilyKey();
      return;
    }
    if (message.type === 'clearApiKey') {
      await this.clearApiKey();
      return;
    }

    // setProvider has inline policy: update the global config, prompt
    // for an API key if switching to bandit and none is stored, then
    // re-sync. Kept inline because the requireApiKey branch reads from
    // `this.context.secrets` and writes to `this.postMessage` — two
    // provider-class surfaces that don't have a topic-file fit.
    if (message.type === 'setProvider') {
      const normalized: ProviderKind = message.value;
      if (normalized !== 'bandit' && normalized !== 'ollama' && normalized !== 'openai-compatible') {
        return;
      }

      const configuration = vscode.workspace.getConfiguration('banditStealth');
      await configuration.update('provider', normalized, vscode.ConfigurationTarget.Global);

      if (normalized === 'bandit') {
        const apiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
        if (!apiKey) {
          this.postMessage({ type: 'requireApiKey' });
        }
      }

      // Silent provider switch — the active-provider pill already reflects it.
      await this.syncState();
      void this.account.refresh();
      return;
    }

    // cancelResponse splits on activeMode — the agent runtime branch
    // routes through agentRuntime.cancel() and emits an agent:log
    // event; the chat-stream branch calls cancelActiveStream(). Both
    // reset busy state.
    if (message.type === 'cancelResponse') {
      if (this.activeMode === 'agent') {
        this.agentRuntime.cancel();
        await environmentService.postToWebview({ type: 'agent:log', entry: { message: 'Cancellation requested…', level: 'warn' } });
        await this.setBusy(false, 'Agent cancelled');
        return;
      }
      this.cancelActiveStream();
      await this.setBusy(false, 'Cancelled');
      return;
    }

    if (message.type === 'sendPrompt') {
      await this.handlePrompt(
        message.text,
        message.images,
        message.mode ?? 'ask',
        message.files,
        message.autoContext
      );
      return;
    }

    // Remaining provider-bound one-liners. Each calls into a provider
    // method (or service) directly; the falls-through structure on the
    // tail is preserved from pre-collapse so the message-type checks
    // stay mutually exclusive.
    if (message.type === 'setMode') {return;} // legacy no-op
    if (message.type === 'requestAccountProfile') { void this.account.refresh(); return; }
    if (message.type === 'requestAccountUsage') { await this.account.sendUsage(); return; }
    if (message.type === 'permissionResponse') { this.permissionGate.respond(message.id, message.choice, message.notes); return; }
    if (message.type === 'userInputResponse') { this.multiQuestionGate.respond(message.id, message.answers, message.cancelled); return; }
    if (message.type === 'requestSkillList') { void this.sendSkillList(); return; }
    if (message.type === 'requestContextFiles') { await this.handleContextFileRequest(); return; }
    if (message.type === 'searchWorkspaceFiles') { await this.handleWorkspaceFileSearch(message.query); return; }
    if (message.type === 'openToolDetail') { await this.toolCallDetails.openInEditor(message.runId); return; }

    // Voice/mic — every one-line delegate to the VoiceService.
    if (message.type === 'speakMessage') { await this.voice.handleSpeak(message.entryId, message.text); return; }
    if (message.type === 'transcribeAudio') { await this.voice.handleTranscribe(message.audioBase64, message.mimeType); return; }
    if (message.type === 'extensionMicProbe') { this.voice.handleMicProbe(); return; }
    if (message.type === 'extensionMicInstallOffer') { this.voice.handleMicInstallOffer(); return; }
    if (message.type === 'extensionMicStart') { await this.voice.handleMicStart(); return; }
    if (message.type === 'extensionMicStop') { await this.voice.handleMicStop(); return; }
    if (message.type === 'extensionMicCancel') { this.voice.handleMicCancel(); return; }
  }

  private async handleWorkspaceFileSearch(rawQuery: string): Promise<void> {
    const entries = await searchWorkspaceFiles(rawQuery);
    this.postMessage({ type: 'workspaceFileSuggestions', entries });
  }

  private async handlePrompt(
    rawText: string,
    images: string[] | undefined,
    mode: 'ask' | 'agent',
    files?: string[],
    autoContext?: boolean
  ): Promise<void> {
    const prompt = rawText.trim();
    if (!prompt) {
      this.postMessage({ type: 'notification', message: 'Enter a prompt to continue.' });
      return;
    }

    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.getProviderKind(configuration);
    const apiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
    const requestedImages = Array.isArray(images)
      ? images.map((image) => (typeof image === 'string' ? image.trim() : '')).filter((image) => image.length > 0)
      : [];
    const askModel = this.resolveChatModel(configuration, requestedImages.length > 0);
    const allowInlineImages = this.canUseInlineImages(configuration, askModel);
    // OCR-first fallback for image-bearing prompts on non-vision models.
    // See ../agent/ocrFallback.ts for the full logic.
    const ocrWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const ocrResult = !allowInlineImages && requestedImages.length > 0
      ? await runOcrFallback(requestedImages, configuration, ocrWorkspaceRoot)
      : { text: '', engine: null };
    const ocrExtractedText = ocrResult.text;
    const ocrEngineUsed = ocrResult.engine;
    const normalizedImages = allowInlineImages
      ? requestedImages
      // OCR succeeded → consume the images (don't also send them as
      // inline content to a non-vision model where they'd be rejected).
      : (ocrExtractedText ? [] : requestedImages);

    if (!allowInlineImages && requestedImages.length > 0 && !ocrExtractedText) {
      this.postMessage({
        type: 'notification',
        message:
          providerKind === 'ollama'
            ? `Inline images are disabled because "${askModel}" is not configured as a vision model. Set banditStealth.ollamaVisionModel to gemma3 or another vision-capable model.`
            : 'Inline images are only supported for Bandit AI bandit-core models.'
      });
    }
    if (ocrEngineUsed) {
      this.postMessage({
        type: 'notification',
        message: `Extracted text from image via ${ocrEngineUsed} — staying on ${askModel} for this turn.`
      });
    }

    if (this.historyVisible) {
      this.historyVisible = false;
    }

    if (!apiKey && providerKind === 'bandit') {
      this.postMessage({ type: 'requireApiKey' });
      await this.showApiKeyOverlay();
      return;
    }

    const currentConversation = this.ensureActiveConversation();
    if (currentConversation.archived) {
      currentConversation.archived = false;
    }

    const autoContextRequested = autoContext !== false;
    const manualContextFiles = Array.isArray(files) ? files.slice() : [];
    const manualContextProvided = manualContextFiles.length > 0;
    let contextFiles = manualContextFiles;
    const heuristicsAllowAuto = this.shouldInjectContext(prompt);
    const allowAutoContext = autoContextRequested && heuristicsAllowAuto;
    const semanticContextPromise =
      providerKind === 'bandit' && apiKey
        ? this.fetchSemanticKnowledge(prompt, configuration, apiKey).catch((error) => {
            console.warn('Semantic context fetch failed', error);
            return '';
          })
        : Promise.resolve('');

    if (contextFiles.length === 0) {
      if (allowAutoContext) {
        void this.setStatusMessage('Selecting context files…');
        const autoFiles = await this.autoSelectContextFiles(prompt);
        if (autoFiles.length > 0) {
          contextFiles = autoFiles;
          // Silent — the chip row underneath the input already shows attached files.
        }
      } else if (!autoContextRequested) {
        // user disabled auto context; no action
      } else {
        const contextMessage: OutgoingMessage = {
          type: 'contextInjectionSkipped',
          reason: 'simple-prompt',
          prompt: prompt.slice(0, 160)
        };
        this.postMessage(contextMessage);
      }
    }

    const contextSource: "manual" | "auto" | undefined =
      contextFiles.length > 0 ? (manualContextProvided ? "manual" : "auto") : undefined;

    const contextExpansion =
      contextFiles.length > 0
        ? await (async () => {
            void this.setStatusMessage('Preparing attached context…');
            return this.expandPromptWithFiles(prompt, contextFiles, {
              source: contextSource
            });
          })()
        : { display: prompt, payload: prompt, warnings: [], contextFiles: [] };
    for (const warning of contextExpansion.warnings) {
      this.postMessage({ type: 'notification', message: warning });
    }

    const entryImages = normalizedImages
        .map((image) => this.extractImagePayload(image))
        .filter((image) => image.length > 0);
    const semanticContext = await semanticContextPromise;
    const payloadWithKnowledge = semanticContext
      ? `${semanticContext}\n\n${contextExpansion.payload}`
      : contextExpansion.payload;
    const userEntry = createConversationEntry('user', contextExpansion.display, {
      images: entryImages,
      payload: payloadWithKnowledge,
      contextFiles: contextExpansion.contextFiles,
      contextSource
    });

    const usageCheck = this.calculateContextUsage(configuration, [...this.conversation, userEntry]);
    if (usageCheck && usageCheck.used > usageCheck.limit) {
      this.postMessage({ type: 'notification', message: `Message would exceed Bandit AI context window (${usageCheck.used.toLocaleString()} / ${usageCheck.limit.toLocaleString()} tokens).` });
      return;
    }
    await this.updateConversation([...this.conversation, userEntry]);
    await this.syncState();

    // Single execution path: always use the tool-use loop.
    // The model decides whether to use tools (for code tasks) or just answer (for questions).
    await this.performCompletion(apiKey ?? '', configuration);
  }

  private async handleContextFileRequest(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.postMessage({ type: 'notification', message: 'Open a workspace to attach files.' });
      return;
    }

    const selection = await this.pickContextAttachments();
    if (!selection) {
      return;
    }

    const attachments = selection.files.length > 0
      ? await this.loadContextFileAttachments(workspaceFolder, selection.files)
      : [];
    if (attachments.length > 0) {
      this.postMessage({ type: 'contextFilesAdded', files: attachments });
    }

    if (selection.addImage) {
      const images = await this.pickImageAttachments(workspaceFolder);
      if (images.length > 0) {
        this.postMessage({ type: 'imageAttachmentsAdded', images });
      }
    }
  }

  private async expandPromptWithFiles(
    prompt: string,
    files: string[] | undefined,
    options?: { source?: "manual" | "auto" }
  ): Promise<{ display: string; payload: string; warnings: string[]; contextFiles: string[] }> {
    if (!files || files.length === 0) {
      return { display: prompt, payload: prompt, warnings: [], contextFiles: [] };
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return {
        display: prompt,
        payload: prompt,
        warnings: ['Context files require an open workspace.'],
        contextFiles: []
      };
    }

    const uniquePaths = Array.from(new Set(files.map((file) => file.trim()).filter((file) => file.length > 0)));
    if (uniquePaths.length === 0) {
      return { display: prompt, payload: prompt, warnings: [], contextFiles: [] };
    }

    const workspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
    const blocks: string[] = [];
    const warnings: string[] = [];
    const includedPaths: string[] = [];

    const limit = 5;
    if (uniquePaths.length > limit) {
      // Silent cap: pushing this as a warning floods the notification area.
    }
    const pathsToProcess = uniquePaths.slice(0, limit);

    for (const relativePath of pathsToProcess) {
      const absolutePath = path.resolve(workspaceRoot, relativePath);
      if (!absolutePath.startsWith(workspaceRoot)) {
        warnings.push(`Skipping ${relativePath} (outside workspace).`);
        continue;
      }

      try {
        const uri = vscode.Uri.file(absolutePath);
        const stat = await vscode.workspace.fs.stat(uri);
        // Sniff the first 4KB to detect binary without reading the full file —
        // a 400KB JPG shouldn't incur a full-file read just to classify it.
        const headBuf = await vscode.workspace.fs.readFile(uri).then(b => b.slice(0, 4096));
        if (isLikelyBinary(headBuf)) {
          // Silent skip — user sees the absent attachment, no toast needed.
          continue;
        }
        // Reference-only: list path + size so the model knows the file
        // exists and how big it is, but DOES NOT inline the content.
        // The model has `read_file` and will fetch on demand. Previously
        // we inlined up to ~40KB per file, which for a typical 3-file
        // auto-context attachment burned 30-120k tokens before the turn
        // even started — on a 16k num_ctx Ollama model that deleted the
        // system prompt via compaction before iteration 1 finished.
        blocks.push(`- \`${relativePath}\` (${stat.size} bytes) — use read_file when needed`);
        includedPaths.push(relativePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Unable to read ${relativePath}: ${message}`);
      }
    }

    if (blocks.length === 0) {
      return { display: prompt, payload: prompt, warnings, contextFiles: [] };
    }

    // The deliberation phrasing we used to ship here ("briefly reason whether
    // they are required … if unnecessary, ignore them and explain why") gave
    // small models a free escape hatch: when the task felt big, they'd write
    // a reasoning paragraph instead of calling tools. Action-worded prompts
    // need action-worded framing. We still allow read-only questions to skip
    // edits — the tools themselves are optional — but we no longer prompt
    // the model to talk about the files instead of touching them.
    const instructions = options?.source === 'auto'
      ? [
          'The files below are the target of this request.',
          'Use `read_file` to load them, then `write_file` (or the relevant edit tool) to apply the changes.',
          'Do not stop after describing the code — complete the task by invoking tools.'
        ].join(' ')
      : '';
    const payloadSections: string[] = [];
    if (prompt.length > 0) {
      payloadSections.push(prompt);
    }
    if (instructions) {
      payloadSections.push(instructions);
    }
    payloadSections.push(`---\nRelevant files (read them with \`read_file\` before editing):\n${blocks.join('\n')}`);
    const payload = payloadSections.join('\n\n');
    const display = prompt;
    return { display, payload, warnings, contextFiles: includedPaths };
  }

  private shouldInjectContext(prompt: string): boolean {
    const lower = prompt.trim().toLowerCase();
    if (!lower) {
      return true;
    }
    const short = lower.split(/\s+/).filter((token) => token.length > 0).length < 6;
    const simple = /\b(who|what|where|when|hi|hello|hey|are you)\b/.test(lower);
    return !(short && simple);
  }

  private async autoSelectContextFiles(prompt: string, limit = 3): Promise<string[]> {
    // Pared-down auto-context. We attach (1) the active editor file
    // and (2) explicit `path/to/file` mentions in the prompt, and
    // nothing else. Keyword-scoring the workspace index against the
    // prompt was a token-burning heuristic guess that often attached
    // the wrong files; the agent's read_file / list_files / grep tools
    // can fetch source on demand. Project memory (BANDIT.md /
    // CLAUDE.md) injects independently of this setting.

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const index = await this.loadWorkspaceFileIndex();
    const added = new Set<string>();
    const selected: string[] = [];
    const addFile = (file: string) => {
      if (!file || added.has(file) || selected.length >= limit) {
        return;
      }
      added.add(file);
      selected.push(file);
    };

    // Active editor file — the visible document the user is currently
    // focused on. Confined to the current workspace; scheme must be
    // `file` so we don't try to attach untitled or virtual docs.
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && activeDoc.uri.scheme === 'file') {
      const abs = activeDoc.uri.fsPath;
      if (abs.startsWith(workspaceRoot)) {
        const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
        if (rel) {addFile(rel);}
      }
    }

    // Explicit path mentions — user typed something that looks like a
    // workspace-relative file path. Match against the index so we
    // confirm the file actually exists before attaching.
    if (Array.isArray(index) && index.length > 0) {
      const pathPattern = /(?:[^\s"'`]+\/)*[A-Za-z0-9_.-]+\.(?:tsx|ts|jsx|js|json|md|css|scss|html|yml|yaml|cs|py|go|rs|java|rb|php|sql)/gi;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = pathPattern.exec(prompt)) !== null) {
        const sanitized = m[0]
          .replace(/\\/g, '/')
          .replace(/^\.\/+/, '')
          .replace(/^\/+/, '')
          .replace(/\s+$/, '');
        if (!sanitized || seen.has(sanitized.toLowerCase())) {continue;}
        seen.add(sanitized.toLowerCase());
        const lower = sanitized.toLowerCase();
        const exact = index.find((entry) => entry.toLowerCase() === lower);
        if (exact) {
          addFile(exact);
        } else {
          const partial = index.find((entry) => entry.toLowerCase().endsWith(lower));
          if (partial) {addFile(partial);}
        }
        if (selected.length >= limit) {break;}
      }
    }

    // Filesystem sanity check. The workspace index is loaded once and
    // cached for the life of the panel — files deleted/renamed after
    // that load can still appear as candidates, and the extension would
    // attach "src/utils/scoring.ts" (from the cached index) even though
    // the real file no longer exists. Confirm every selected path still
    // resolves before handing the list back. If any path is missing, we
    // drop it AND force a fresh index scan so subsequent prompts don't
    // keep offering the ghost path. Observed in pburg-bowl on 2026-04-21.
    if (selected.length === 0) {
      return selected;
    }
    const verified: string[] = [];
    let anyMissing = false;
    for (const relPath of selected) {
      try {
        const absolute = path.resolve(workspaceRoot, relPath);
        if (!absolute.startsWith(workspaceRoot)) {
          anyMissing = true;
          continue;
        }
        await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
        verified.push(relPath);
      } catch {
        anyMissing = true;
      }
    }
    if (anyMissing) {
      // Invalidate the cache so the next auto-context pass picks up the
      // real filesystem state — otherwise we keep handing out the same
      // stale paths every prompt.
      this.workspaceFileIndex = undefined;
    }
    return verified;
  }

  private async pickContextAttachments(): Promise<{ files: string[]; addImage: boolean } | undefined> {
    const files = await this.loadWorkspaceFileIndex();
    if (files.length === 0) {
      // silent — the empty state is self-evident (chip row stays empty).
      return undefined;
    }

    type ContextQuickPickItem = vscode.QuickPickItem & { value: string };
    const items: ContextQuickPickItem[] = files.map((relativePath) => {
      const normalized = relativePath.replace(/\\/g, '/');
      const segments = normalized.split('/');
      const label = segments.pop() ?? normalized;
      const description = segments.join('/');
      return {
        label,
        description,
        detail: normalized,
        value: normalized
      };
    });

    const addImageItem: ContextQuickPickItem = {
      label: '$(file-media) Add image…',
      description: 'Attach an image from disk.',
      detail: '',
      value: '__add_image__',
      alwaysShow: true
    };

    const quickPick = vscode.window.createQuickPick<ContextQuickPickItem>();
    quickPick.canSelectMany = true;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.placeholder = 'Search workspace files to attach…';
    quickPick.title = 'Add Bandit context';
    quickPick.items = [addImageItem, ...items];

    const selection = await new Promise<ContextQuickPickItem[] | undefined>((resolve) => {
      let resolved = false;
      const finalize = (value: ContextQuickPickItem[] | undefined) => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve(value);
      };
      quickPick.onDidAccept(() => {
        finalize([...quickPick.selectedItems]);
        quickPick.hide();
      });
      quickPick.onDidHide(() => finalize(undefined));
      quickPick.show();
    });
    quickPick.dispose();

    if (!selection || selection.length === 0) {
      return undefined;
    }

    const addImage = selection.some((item) => item.value === '__add_image__');
    const filesToAttach = selection
      .filter((item) => item.value !== '__add_image__')
      .map((item) => item.value)
      .filter((value, index, array) => array.indexOf(value) === index);

    return { files: filesToAttach, addImage };
  }

  private async loadWorkspaceFileIndex(force = false): Promise<string[]> {
    if (!force && Array.isArray(this.workspaceFileIndex) && this.workspaceFileIndex.length > 0) {
      return this.workspaceFileIndex;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.workspaceFileIndex = [];
      return [];
    }

    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.bandit/**}';
    const uris = await vscode.workspace.findFiles('**/*', exclude, 6000);
    const root = folder.uri.fsPath;
    const files = uris
      .map((uri) => path.relative(root, uri.fsPath).replace(/\\/g, '/'))
      .filter((relative) => relative && !relative.endsWith('/'));

    files.sort((a, b) => a.localeCompare(b));
    this.workspaceFileIndex = files;
    return files;
  }

  private async loadContextFileAttachments(
    workspaceFolder: vscode.WorkspaceFolder,
    files: string[]
  ): Promise<Array<{ path: string; preview?: string }>> {
    if (files.length === 0) {
      return [];
    }

    const workspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const attachments: Array<{ path: string; preview?: string }> = [];

    for (const relativePath of files) {
      const normalized = relativePath.replace(/\\/g, '/');
      const absolutePath = path.resolve(workspaceRoot, normalized);
      if (!absolutePath.startsWith(workspaceRoot)) {
        this.postMessage({ type: 'notification', message: `Skipping ${normalized} (outside workspace).` });
        continue;
      }

      const uri = vscode.Uri.file(absolutePath);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        let preview = '';
        if (stat.size <= 200_000) {
          const buffer = await vscode.workspace.fs.readFile(uri);
          if (isLikelyBinary(buffer)) {
            preview = 'Binary file — preview unavailable.';
          } else {
            const decoded = decoder.decode(buffer);
            preview = this.buildContextPreview(decoded);
          }
        } else {
          preview = 'Preview unavailable (file larger than 200 KB).';
        }
        attachments.push({ path: normalized, preview });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.postMessage({ type: 'notification', message: `Unable to read ${normalized}: ${message}` });
      }
    }

    return attachments;
  }

  private async pickImageAttachments(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Add image',
      defaultUri: workspaceFolder.uri,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }
    });

    if (!uris || uris.length === 0) {
      return [];
    }

    const maxBytes = 4_000_000; // ~4 MB
    const images: string[] = [];

    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > maxBytes) {
          this.postMessage({ type: 'notification', message: `${path.basename(uri.fsPath)} is larger than 4 MB and was skipped.` });
          continue;
        }
        const buffer = await vscode.workspace.fs.readFile(uri);
        const ext = path.extname(uri.fsPath).toLowerCase();
        const mime = this.getImageMimeType(ext);
        const base64 = Buffer.from(buffer).toString('base64');
        images.push(`data:${mime};base64,${base64}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.postMessage({ type: 'notification', message: `Unable to load image ${path.basename(uri.fsPath)}: ${message}` });
      }
    }

    return images;
  }

  private getImageMimeType(ext: string): string {
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.webp':
        return 'image/webp';
      case '.bmp':
        return 'image/bmp';
      case '.svg':
      case '.svgz':
        return 'image/svg+xml';
      case '.png':
      default:
        return 'image/png';
    }
  }

  private buildContextPreview(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return '';
    }
    const lines = normalized.split('\n');
    const snippet = lines.slice(0, 3).join(' · ');
    if (snippet.length <= 120) {
      return snippet;
    }
    return `${snippet.slice(0, 119)}…`;
  }


  private async startAgentGoal(goal: string): Promise<void> {
    this.cancelActiveStream();
    this.activeMode = 'agent';
    const conversation = this.ensureActiveConversation();
    environmentService.setRunContext({
      conversationId: conversation.id,
      conversationName: conversation.name,
      runId: undefined
    });
    if (this.historyVisible) {
      this.historyVisible = false;
    }
    await this.context.workspaceState.update(MODE_STORAGE_KEY, this.activeMode);
    await this.setBusy(true, 'Agent running…');
    try {
      const report = await this.promptPipeline.execute(goal, 'agent');
      const summary = formatAgentReport(report);
      const agentReply = await this.generateAgentReply(goal, report).catch((replyError) => {
        void environmentService.postToWebview({ type: 'agent:log', entry: { message: `Reply error: ${replyError instanceof Error ? replyError.message : String(replyError)}`, level: 'warn' } });
        return undefined;
      });
      const trimmedReply = agentReply?.trim() ?? null;
      const primaryContent = trimmedReply ?? buildAgentSummaryHeadline(report);
      await this.appendAssistantMessage(primaryContent, {
        payload: buildAgentSummaryPayload(report, summary, trimmedReply)
      });
      await this.setBusy(false);
      void this.diffPreviews.presentFromReport(report).catch((error) => {
        console.warn('Unable to present diff feedback', error);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown issue.';
      this.postMessage({ type: 'error', message: `Agent error: ${message}` });
      void vscode.window.showErrorMessage(`Agent error: ${message}`);
      await environmentService.postToWebview({ type: 'agent:log', entry: { message: `Error: ${message}`, level: 'error' } });
      await environmentService.postToWebview({ type: 'agent:status', text: 'Agent failed', phase: 'error' });
      await environmentService.postToWebview({ type: 'agent:final', report: { evaluation: { success: false } } });
      await this.appendAssistantMessage(`Agent run failed: ${message}`);
      await this.setBusy(false, 'Agent failed');
    } finally {
      environmentService.setRunContext(undefined);
    }
  }

  private async previewAgentPlan(goal: string): Promise<void> {
    const conversation = this.ensureActiveConversation();
    environmentService.setRunContext({
      conversationId: conversation.id,
      conversationName: conversation.name,
      runId: undefined
    });
    try {
      const report = await this.promptPipeline.preview(goal);
      if (Array.isArray(report.plan?.steps) && report.plan.steps.length > 0) {
        // silent — the Plan tab itself surfaces the new preview.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preview failed.';
      console.warn('Plan preview error', error);
      this.postMessage({ type: 'notification', message: `Plan preview failed: ${message}` });
    } finally {
      environmentService.setRunContext(undefined);
    }
  }

  private buildAgentCompletionRequest(goal: string, report: AgentReport, configuration: vscode.WorkspaceConfiguration): AIChatRequest {
    const providerKind = this.getProviderKind(configuration);
    const model = providerKind === 'ollama'
      ? this.resolveAgentModel(configuration)
      : (configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1');
    const temperature = configuration.get<number>('temperature', 0.2);
    const topP = configuration.get<number>('topP', 1);

    const messages: AIChatRequest['messages'] = [
      {
        role: 'system',
        content: 'You are Bandit Stealth, an expert coding assistant operating inside VS Code. Provide a concise, accurate response to the user goal using only information contained in the agent run summary. If steps are marked as placeholders or no concrete changes were made, state that clearly. Never claim that code was modified unless the summary explicitly indicates a real change.'
      },
      {
        role: 'user',
        content: `User goal: ${goal}\n\nAgent report:\n${describeAgentReport(report)}\n\nRespond directly to the user goal.`
      }
    ];

    const request: AIChatRequest = {
      model,
      messages,
      stream: true,
      temperature
    };

    if (typeof topP === 'number' && !Number.isNaN(topP)) {
      request.options = { top_p: topP };
    }

    return request;
  }

  private async generateAgentReply(goal: string, report: AgentReport): Promise<string | undefined> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.getProviderKind(configuration);
    const apiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
    if (providerKind === 'bandit' && !apiKey) {
      return undefined;
    }

    const ollamaAuth = await Promise.resolve(this.context.secrets.get(OLLAMA_AUTH_SECRET_KEY)).catch(() => undefined);
    const provider = await createProvider(this.buildProviderSettings(configuration, apiKey ?? '', ollamaAuth));
    const request = this.buildAgentCompletionRequest(goal, report, configuration);

    let response = '';
    try {
      for await (const chunk of provider.chat(request)) {
        const content = chunk?.message?.content ?? '';
        if (content) {
          response += content;
        }
        if (chunk?.done) {
          break;
        }
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const trimmed = response.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  public async appendAssistantMessage(content: string, options?: { payload?: unknown }): Promise<void> {
    let payload: string | undefined;
    if (options && Object.prototype.hasOwnProperty.call(options, 'payload')) {
      const value = options.payload;
      if (typeof value === 'string') {
        payload = value;
      } else if (value !== undefined) {
        try {
          payload = JSON.stringify(value);
        } catch {
          payload = content;
        }
      }
    }
    const assistantEntry = createConversationEntry('assistant', content, { payload: payload ?? content });
    if (this.historyVisible) {
      this.historyVisible = false;
    }
    await this.updateConversation([...this.conversation, assistantEntry]);
    await this.syncState();
  }

  private async evaluateIntentForPrompt(
    entry: ConversationEntry,
    prompt: string,
    configuration: vscode.WorkspaceConfiguration,
    providerKind: ProviderKind
  ): Promise<void> {
    if (providerKind !== 'bandit') {
      await this.intent.attachToMessage(entry.id, undefined);
      await this.intent.setInsight(undefined);
      return;
    }

    try {
      await this.setStatusMessage('Detecting intent…');
      const insight = await this.interpretIntent(prompt, configuration, providerKind);
      if (insight) {
        const enriched = { ...insight, summary: summarizeIntent(insight) };
        await this.intent.attachToMessage(entry.id, enriched);
        await this.intent.recordMemory(enriched);
        await this.intent.setInsight(enriched);
        await this.setStatusMessage(`Intent detected: ${enriched.summary}`);
      } else {
        await this.intent.attachToMessage(entry.id, undefined);
        await this.intent.setInsight(undefined);
        await this.setStatusMessage('No specific intent detected');
      }
    } catch (error) {
      console.warn('Intent detection failed', error);
      await this.intent.attachToMessage(entry.id, undefined);
      await this.intent.setInsight(undefined);
      await this.setStatusMessage('Intent unavailable');
    }
  }

  private async performCompletion(apiKey: string, configuration: vscode.WorkspaceConfiguration): Promise<void> {
    // Intercept slash commands before they reach the agent — sending
    // meta-commands to the model as a user prompt makes small models
    // hallucinate "I don't have a /memory tool" responses (observed
    // 2026-04-27 on S3Api with gemma4:e4b: prompt was `/memory`, the
    // agent emitted iterations:0 and a polite refusal). The CLI has a
    // full slash-command system; the IDE handles the most common ones
    // here and tells the user politely about the rest.
    const lastUserMessage = [...this.conversation].reverse().find(e => e.role === 'user')?.content ?? '';
    const trimmed = lastUserMessage.trim();
    if (trimmed.startsWith('/rewind')) {
      await this.handleRewindCommand(trimmed);
      return;
    }
    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      const handled = await this.handleSlashCommand(trimmed, configuration);
      if (handled) {return;}
    }
    // Bash shortcut — `!ls -la`, `!brew install ripgrep`, etc. Runs
    // directly through bash with the user's full shell, bypassing the
    // allow-list (the user is explicitly invoking, not the agent) but
    // keeping BLOCKED_PATTERNS for catastrophic guards. Same shape as
    // Claude Code's `!` and Aider's `/run`. The output renders as a
    // chat card so the conversation reflects what was just run.
    if (trimmed.startsWith('!') && trimmed.length > 1) {
      await this.handleBashShortcut(trimmed.slice(1).trim());
      return;
    }
    // Delegate to tool use loop when the feature is enabled.
    if (configuration.get<boolean>('enableToolUse', true)) {
      await this.performToolUseCompletion(apiKey, configuration, lastUserMessage);
      return;
    }

    // Opt-out fallback: the user disabled `enableToolUse`. Run a
    // tool-less direct stream against `provider.chat`. See
    // ../agent/legacyDirectStream.ts for the load-bearing behaviors.
    await runLegacyDirectStream({
      apiKey,
      configuration,
      secrets: this.context.secrets,
      getConversation: () => this.conversation,
      setConversation: (entries) => { this.conversation = entries; },
      setActiveStream: (stream) => { this.activeStream = stream; },
      getProviderKind: (cfg) => this.getProviderKind(cfg),
      describeProvider: (kind) => this.describeProvider(kind),
      buildProviderSettings: (cfg, key, ollamaAuth) => this.buildProviderSettings(cfg, key, ollamaAuth),
      buildChatRequest: (cfg, contextBlock) => this.buildChatRequest(cfg, contextBlock),
      buildContextBlock: (prompt, cfg) => this.buildContextBlock(prompt, cfg),
      setBusy: (busy, statusText) => this.setBusy(busy, statusText),
      setStatusMessage: (text) => { void this.setStatusMessage(text); },
      cancelActiveStream: () => this.cancelActiveStream(),
      updateConversation: (entries, options) => this.updateConversation(entries, options),
      syncState: () => this.syncState(),
      postMessage: (msg) => this.postMessage(msg)
    });
  }

  /**
   * Handle `/rewind` slash command in the composer. No args lists the
   * most recent checkpoints; `/rewind <id>` or `/rewind last` applies
   * one. Result is posted as a synthetic assistant entry so it lives
   * in the conversation history alongside the diff cards that created
   * those checkpoints.
   */
  private async handleRewindCommand(raw: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const store = new CheckpointStore({ workspaceRoot });
    const arg = raw.slice('/rewind'.length).trim();
    const systemEntry = createConversationEntry('assistant', '', { payload: '' });
    this.conversation.push(systemEntry);
    const render = async (content: string) => {
      systemEntry.content = content;
      systemEntry.payload = content;
      systemEntry.timestamp = Date.now();
      await this.updateConversation(this.conversation);
      await this.syncState();
    };
    try {
      if (!arg) {
        const list = await store.list(10);
        if (list.length === 0) {
          await render('_No checkpoints yet — rewind is available after the agent makes an edit._');
          return;
        }
        const rows = list.map((e, i) => {
          const tag = i === 0 ? '**most recent**' : '';
          return `- \`${e.id}\` · ${e.tool} \`${e.relPath}\` · **+${e.plus} −${e.minus}** ${tag}`;
        });
        await render(
          [
            '**Recent checkpoints** — `/rewind <id>` or `/rewind last` to restore:',
            '',
            ...rows
          ].join('\n')
        );
        return;
      }
      let targetId = arg;
      if (arg === 'last' || arg === '--last') {
        const list = await store.list(1);
        if (list.length === 0) {
          await render('_No checkpoints to rewind to._');
          return;
        }
        targetId = list[0].id;
      }
      const entry = await store.rewind(targetId);
      if (!entry) {
        await render(`_Checkpoint \`${targetId}\` not found. Run \`/rewind\` to list available ids._`);
        return;
      }
      const action = entry.isNewFile ? 'deleted (was new file)' : 'restored to pre-edit state';
      await render(
        [
          `**↶ rewound** \`${entry.id}\` — ${entry.relPath} ${action}.`,
          '',
          `_Turn \`${entry.turnId}\` · iteration ${entry.iteration} · ${entry.tool}_`
        ].join('\n')
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await render(`_Rewind failed: ${msg}_`);
    }
  }

  /**
   * `!`-prefix bash shortcut. The user typed something like `!ls -la`
   * or `!brew install ripgrep` in the composer — runs it directly via
   * the shell, bypassing the agent and the run_command allow-list (the
   * user is the one explicitly invoking, not the model). Output lands
   * in the chat as a system message so the conversation reflects what
   * was just run. BLOCKED_PATTERNS-style guards still apply for
   * catastrophic commands. Same shape as Claude Code's `!` and
   * Aider's `/run`.
   */
  private async handleBashShortcut(command: string): Promise<void> {
    const cmd = command.trim();
    if (!cmd) {return;}
    // Same catastrophic guards run_command applies (rm -rf, mkfs, dd if=).
    // The user typed the command themselves, but a fat-finger on `rm -rf
    // ~` deserves a refusal rather than an obedient execution.
    const BLOCKED = [/rm\s+-rf/, /rmdir\s+\//, /\bmkfs\b/, /dd\s+if=/];
    for (const pattern of BLOCKED) {
      if (pattern.test(cmd)) {
        const entry = createConversationEntry(
          'assistant',
          `_Refusing to run \`${cmd}\` — matches blocked pattern \`${pattern.source}\`. Run it in your shell directly if you really mean it._`,
          { payload: '' }
        );
        this.conversation.push(entry);
        await this.updateConversation(this.conversation);
        await this.syncState();
        return;
      }
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const runId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Render an in-flight card so the user sees the command is running.
    const renderCard = (out: string, isError: boolean) => {
      const payload = JSON.stringify({ runId, cmd, out, isError, truncated: false, totalLen: out.length });
      const fence = `\n\n\`\`\`bandit-run\n${payload}\n\`\`\`\n`;
      const entry = createConversationEntry('assistant', fence, { payload: '' });
      this.conversation.push(entry);
      void this.updateConversation(this.conversation);
      void this.syncState();
    };
    try {
      const { exec } = await import('child_process');
      const { stdout, stderr, exitCode } = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>((resolve) => {
        const child = exec(
          cmd,
          { cwd: workspaceRoot, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
          (err, stdout, stderr) => {
            const exitCode = err && typeof (err as NodeJS.ErrnoException).code === 'number'
              ? (err as { code: number }).code
              : err ? 1 : 0;
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode });
          }
        );
        // The exec callback handles termination; nothing else to do.
        void child;
      });
      const combined = [
        stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
        stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
        `exit code: ${exitCode}`
      ].filter(Boolean).join('\n\n');
      const MAX = 8_000;
      const out = combined.length > MAX ? `${combined.slice(0, MAX)}\n\n[truncated]` : combined;
      renderCard(out, exitCode !== 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderCard(`Error: ${msg}`, true);
    }
  }

  /**
   * Generic slash-command handler for the IDE composer. Returns true
   * when the input was a recognized slash command (whether the side
   * effect succeeded or just emitted a help message); false to let the
   * caller fall through to the model.
   *
   * The CLI ships a much larger slash-command surface in
   * `apps/bandit-cli/src/slashCommands.ts`; the IDE intentionally
   * implements only the subset that makes sense from a chat composer
   * (no /theme — handled in Settings; no /paste — Ctrl+V already works;
   * no /usage — Account tab already shows it). For everything else we
   * emit a "use the CLI" pointer so the model never sees the slash
   * input and small models can't hallucinate a refusal.
   */
  private async handleSlashCommand(
    raw: string,
    configuration: vscode.WorkspaceConfiguration
  ): Promise<boolean> {
    return dispatchSlashCommand(raw, configuration, {
      conversation: this.conversation,
      updateConversation: (entries) => this.updateConversation(entries),
      syncState: () => this.syncState(),
      clearCurrentConversation: () => handleClearConversation(this, this.convMessageDeps),
      getProviderKind: (cfg) => this.getProviderKind(cfg),
      resolveOllamaBaseModel: (cfg) => this.resolveOllamaBaseModel(cfg),
      hasBanditApiKey: async () => Boolean((await this.context.secrets.get(API_KEY_SECRET_KEY))?.trim())
    });
  }

  /**
   * Ask-mode completion backed by the text-based tool use loop.
   * Active when `banditStealth.enableToolUse` is true.
   *
   * The loop injects XML tool definitions into the system prompt, executes
   * <tool_call> blocks emitted by the model, and returns the final answer
   * once no more tool calls appear.
   */
  /** (Re)build the telemetry exporter from ~/.bandit/config.json + the current
   *  bearer. Returns null (disabled) unless the user opted in. Never throws. */
  private ensureTelemetry(apiKey: string): void {
    try {
      const cfg = resolveTelemetryConfig({
        telemetry: readBanditConfig().telemetry,
        banditApiKey: apiKey || undefined,
        serviceName: 'bandit-extension'
      });
      this.telemetry = cfg ? new TelemetryExporter(cfg) : null;
    } catch {
      this.telemetry = null;
    }
  }

  private async performToolUseCompletion(
    apiKey: string,
    configuration: vscode.WorkspaceConfiguration,
    userGoal: string
  ): Promise<void> {
    // Inject any background subagent results into the goal before the
    // model sees it. Doing this here (rather than inside the loop)
    // means the synopsis lands as part of the user's turn, not as a
    // mid-stream system message — which is what the model expects.
    userGoal = this.backgroundTasks.drainCompletions(userGoal);
    this.cancelActiveStream();
    const providerKind = this.getProviderKind(configuration);
    const providerLabel = this.describeProvider(providerKind);
    await this.setBusy(true, `Tool agent starting…`);
    this.activeTurnStartedAt = Date.now();

    const assistantEntry = createConversationEntry('assistant', '', { payload: '' });
    let assistantAdded = false;
    // Hoisted so the catch block can clear the thinking / tool-call-gen
    // markers when an error (e.g. Ollama 404) interrupts mid-loop. The
    // real implementation is assigned once the try-block constructs
    // the indicators below.
    let disposeIndicators: () => void = () => {};
    // Set in catch so the finally's telemetry endTurn can mark the turn span.
    let turnTelemetryError: string | undefined;

    try {
      const workspaceRootCheck = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRootCheck) {
        throw new Error('Tool use requires an open workspace folder.');
      }

      const ollamaAuth = await Promise.resolve(this.context.secrets.get(OLLAMA_AUTH_SECRET_KEY)).catch(() => undefined);
      const providerSettings = this.buildProviderSettings(configuration, apiKey, ollamaAuth);
      const model = providerKind === 'ollama'
        ? this.resolveAgentModel(configuration)
        : configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1';
      const temperature = configuration.get<number>('temperature', 0.2);

      // App-level telemetry (opt-in, off by default). Re-resolved per turn so a
      // config edit applies without a reload; no-op when disabled.
      this.ensureTelemetry(apiKey);
      this.telemetry?.startTurn(userGoal, model);

      // Build the entire loop setup (tool registry, skills, turn log,
      // checkpoint store, memory, hooks, MCP tools) in one factory call
      // so the rest of this method doesn't have to reason about
      // partial-construction order. See agent/toolLoopSetup.ts.
      const turnRunCtx = await buildTurnRunContext(this, {
        workspaceRoot: workspaceRootCheck,
        configuration,
        userGoal,
        conversation: this.conversation
      });
      const {
        workspaceRoot,
        toolCtx,
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
      } = turnRunCtx;
      // Mutable per-turn state for the tool-use loop's event bridge.
      // Owns every variable previously declared as a local `let` /
      // `const Map()` here so the event handlers can be extracted into
      // separate files without dragging 16 closure references with them.
      // Field shapes preserved byte-for-byte. See src/agent/turnState.ts.
      const state = new TurnState(assistantEntry);
      // Flush all pending diff cards — called on iteration boundaries
      // and at turn end. Parallel edits to the same file produce ONE
      // cumulative card (before = iteration-start disk state, after =
      // current disk state). Parallel edits to different files each
      // get their own card. Run synchronously to avoid racing with the
      // next iteration's content truncation.
      const flushPendingEditDiffs = buildFlushPendingEditDiffs({
        state,
        assistantEntry,
        workspaceRoot,
        checkpointStore,
        turnId,
        syncState: () => { void this.syncState(); }
      });
      // Subagent buffer + key helpers are now on TurnState (see field
      // doc on `state.subagentBuffers` and method doc on `state.bufferKeyFor`).

      const indicators = createStatusIndicators({
        getAssistantEntry: () => assistantEntry,
        syncState: () => { void this.syncState(); },
        setStatusMessage: (text) => { void this.setStatusMessage(text); },
        providerLabel
      });
      disposeIndicators = () => indicators.dispose();

      // Ring buffer for repeat-tool-call detection lives on TurnState
      // (`state.recentToolCallDisplays`, window size `TurnState.REPEAT_WINDOW`).

      // Pull images from the most recent user entry in the conversation
      // so the tool-use loop can forward them to the provider on the
      // FIRST iteration. Without this, images attached to the user's
      // prompt never reached the model — the tool-use adapter was
      // stripping `content` + `role` only and dropping `images`. Only
      // send on the first chat() call of the turn; subsequent
      // iterations are tool-result follow-ups with no new image.
      const allowInlineImages = this.canUseInlineImages(configuration, model);
      const lastUserEntryForImages = [...this.conversation]
        .reverse()
        .find((entry) => entry.role === 'user');
      const turnImages = allowInlineImages && lastUserEntryForImages?.images
        ? lastUserEntryForImages.images
            .map((image) => this.extractImagePayload(image))
            .filter((image) => image.length > 0)
        : [];
      // `imagesAlreadySent`, `inflightChats`, and
      // `largePromptWatchdogNoticeShown` now live on TurnState — see
      // the chat-streaming state block in src/agent/turnState.ts.

      // Resolve user's thinking-mode preference. "auto" → no override;
      // "on" / "off" → force that state via request.think. Read once
      // per turn so mid-session toggles of the setting take effect on
      // the NEXT prompt without rebuilding providers.
      const thinkingModePref = vscode.workspace
        .getConfiguration('banditStealth')
        .get<'auto' | 'on' | 'off'>('thinkingMode', 'auto');
      const thinkOverride =
        thinkingModePref === 'on' ? true :
        thinkingModePref === 'off' ? false :
        undefined;

      // Per-turn cancellation. Webview "Stop" button calls
      // cancelActiveStream() which abort()s this controller; both the
      // tool-use loop and the chat closure observe `signal.aborted` and
      // unwind. Cleared in the finally block below.
      this.activeAbortController?.abort();
      const turnAbortController = new AbortController();
      this.activeAbortController = turnAbortController;
      const turnSignal = turnAbortController.signal;
      const provider = await createProvider(providerSettings);
      const getConfiguredWatchdogMs = (): number | undefined => {
        const raw = vscode.workspace
          .getConfiguration('banditStealth')
          .get<number>('watchdogMs', -1);
        return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
          ? Math.floor(raw)
          : undefined;
      };

      // Adapt provider.chat() → ChatFn. The full closure body lives in
      // src/agent/chatFn.ts; load-bearing behaviors (reasoning fence
      // state machine, no-token watchdog, abort signal, inflightChats
      // bump in finally) are pinned by contract tests in
      // test/agent/chatFn.test.ts. Do not inline back into this method
      // without preserving every behavior documented in buildChatFn's
      // JSDoc.
      const chat: ChatFn = buildChatFn({
        state,
        provider,
        model,
        temperature,
        thinkOverride,
        turnImages,
        turnSignal,
        getConfiguredWatchdogMs,
        setStatusMessage: (text) => { void this.setStatusMessage(text); }
      });

      // Shared gate applied to every tool call (main loop + Task subagents).
      // Order: hooks first (scripted guardrails), then permission policy
      // (user-facing "allow this write?" modal). Either can abort the call.
      // Full implementation lives in src/agent/beforeToolExecute.ts; the
      // load-bearing behaviors (turn-local auto-grant, inflight promise
      // sharing, autoApproveEdits bypass, deny-with-notes phrasing) are
      // pinned by contract tests in test/agent/beforeToolExecute.test.ts.
      const beforeToolExecute = buildBeforeToolExecute({
        state,
        assistantEntry,
        permissionGate: this.permissionGate,
        permissionStore: this.permissions,
        hookSettings,
        workspaceRoot,
        userGoal,
        turnLog,
        notifyUser: (kind, title, message) => this.notifyUser(kind, title, message)
      });

      const modelCaps = getModelCapabilities(model);
      const behaviorProfile = getModelBehaviorProfile(model);
      const runtimeOpts = resolveOllamaRuntimeOptions(model);
      const messageTokenBudget = Math.floor(runtimeOpts.num_ctx * 0.75);
      // Native tool calling when the model advertises it — Qwen2.5-Coder,
      // Llama 3.1+, Devstral, DeepSeek-Coder-V2+, Nemotron. Skips the
      // XML tool block in the system prompt (~1000-1800 tokens) and
      // routes schemas through Ollama's `tools` field where the model's
      // chat template serializes them natively. Enabled on both direct
      // Ollama and the bandit cloud path — the cloud provider's
      // serializeBanditPayload forwards `tools` as an unknown top-level
      // key which the gateway's BuildOllamaRequestPayloadAsync relays
      // to upstream Ollama via AdditionalProperties.
      const nativeTools = modelCaps.supportsToolCalling
        && behaviorProfile.protocol.preferred === 'native-tools'
        && (providerKind === 'ollama' || providerKind === 'bandit');
      const nativeToolFailureFallback = behaviorProfile.protocol.nativeToolFailureFallback !== false;
      const outputBudgetTokens = behaviorProfile.context.outputBudgetTokens;
      const maxParallelTools = behaviorProfile.reliability.maxParallelTools;

      // Deps for the subagent-events family. Constructed before the
      // task tool registers because its `onEvent` closure captures these.
      const subagentEventDeps: SubagentEventDeps = {
        state,
        turnLog,
        workspaceRoot,
        background: this.background,
        isAssistantEntryLive: () => this.conversation.some(e => e.id === assistantEntry.id),
        syncState: () => { void this.syncState(); }
      };

      // Background-subagent companion tools — registered first so the
      // task tool below sees them via parentRegistry.getAll(). The store
      // is the same one the live-tile is subscribed to, so calls from
      // either path keep the UI in sync.
      registry.register(buildCheckTaskTool(this.background));
      registry.register(buildListTasksTool(this.background));
      // Holder for the parent's system prompt — populated below once
      // baseSystemPrompt + memoryBlock + operationalHints + skill
      // instructions are built. The task tool reads this lazily at
      // subagent-spawn time so the subagent inherits the EXACT prompt
      // the parent is using, not a hand-rolled fork. fix for
      // subagent stall.
      const parentPromptHolder: { current: string | undefined } = { current: undefined };
      // Register the Task tool so the model can delegate scoped work to a subagent.
      registry.register(buildTaskTool({
        chat,
        parentRegistry: registry,
        ctx: toolCtx,
        backgroundStore: this.background,
        beforeToolExecute,
        parentSystemPrompt: () => parentPromptHolder.current,
        // v1.7.338: cascade Stop from the IDE's webview cancel button down
        // to in-flight subagents. The getter resolves at each subagent
        // spawn so we always read the CURRENT turn's controller (it's
        // replaced on every new prompt). Without this, hitting Stop in
        // the IDE only aborted the parent loop; the 3 background
        // subagents kept running their own loops and the only escape
        // was killing the extension host process.
        getParentSignal: () => turnAbortController.signal,
        subagentLoopOptions: () => ({
          nativeTools,
          nativeToolFailureFallback,
          messageTokenBudget,
          maxParallelTools,
          outputBudgetTokens
        }),
        onEvent: (type, payload) => {
          handleSubagentEvent(type, payload, subagentEventDeps);
        }
      }));

      // Compose the system prompt the loop hands to the model AND the
      // string subagents inherit via parentPromptHolder. See
      // ../agent/agentSystemPrompt.ts for the layering rules.
      const systemPrompt = await composeAgentSystemPrompt({
        userGoal,
        configuration,
        providerKind,
        model,
        activeSkills,
        memoryBundle,
        buildContextBlock: (prompt, cfg) => this.buildContextBlock(prompt, cfg)
      });
      parentPromptHolder.current = systemPrompt;

      await this.updateConversation([...this.conversation, assistantEntry], { persist: false });
      assistantAdded = true;
      await this.syncState();

      // Iteration-streaming bookkeeping (state.streamedCharsByIteration,
      // state.iterationsWithToolCalls, state.currentIteration, state.currentIterationStartLength,
      // state.ignoreIterationChunks, state.inReasoningFence) all live on TurnState.
      // The reasoning-fence flag in particular must stay on state so the
      // chat-events handler can keep routing reasoning chunks past
      // suppressStreamPreamble — without that, chain-of-thought only
      // surfaces at turn end via finalResponse instead of inline with
      // the iteration that emitted it.

      // Raised defaults 2026-04-22: Gemma-class models don't parallelize
      // tool calls (supportsToolCalling=false, so they serialize one
      // apply_edit per iteration) and were consistently hitting the
      // previous 8-iteration cap mid-task on real "document N methods"
      // requests. Large frontier models still finish in 3-5 iterations
      // by parallelizing; the extra headroom is dead weight for them
      // and a genuine unblock for the 12B/26B class.
      const defaultMaxIterations = modelCaps.tier === 'large' ? 20 : modelCaps.tier === 'medium' ? 20 : 12;
      const maxIterations = configuration.get<number>('toolUse.maxIterations', defaultMaxIterations);

      const maybeShowOllamaContextWarning = buildMaybeShowOllamaContextWarning({
        isAlreadyShown: () => this.ollamaContextWarned,
        markShown: () => { this.ollamaContextWarned = true; },
        getProviderKind: (cfg) => this.getProviderKind(cfg),
        resolveOllamaBaseModel: (cfg) => this.resolveOllamaBaseModel(cfg)
      });

      const chatEventDeps: ChatEventDeps = {
        state,
        turnLog,
        indicators,
        flushPendingEditDiffs,
        getToolLoopIteration: (p, fallback) => this.getToolLoopIteration(p, fallback),
        syncState: () => { void this.syncState(); },
        setStatusMessage: (text) => { void this.setStatusMessage(text); },
        maybeShowOllamaContextWarning
      };

      const toolEventDeps: ToolEventDeps = {
        state,
        turnLog,
        indicators,
        workspaceRoot,
        toolToSkill,
        skillNameById,
        hookSettings,
        toolCallDetails: this.toolCallDetails,
        todoStore,
        syncState: () => { void this.syncState(); },
        setStatusMessage: (text) => { void this.setStatusMessage(text); },
        // Preserves the original tool_execute behavior: push the current
        // conversation list to the webview WITHOUT persisting so the
        // timeline card flush is visible before the next iteration's
        // chunks arrive. The conversations.messages getter is the
        // authoritative source — keep using it here so a follow-up
        // refactor of the conversation service is the only place that
        // can break this contract.
        updateConversation: () => {
          void this.updateConversation([...this.conversations.messages], { persist: false });
        }
      };

      const iterationEventDeps: IterationEventDeps = {
        turnLog,
        setStatusMessage: (text) => { void this.setStatusMessage(text); }
      };

      const metaEventDeps: MetaEventDeps = {
        state,
        turnLog,
        getToolLoopIteration: (p, fallback) => this.getToolLoopIteration(p, fallback),
        syncState: () => { void this.syncState(); }
      };

      const loop = createToolUseLoop(registry, toolCtx, {
        maxIterations,
        beforeToolExecute,
        emitEvent: (type, payload) => {
          // Telemetry tap (sync, no-op when disabled) — observes only.
          this.telemetry?.onEvent(type, payload);
          // CRITICAL: this MUST be a sync callback (no awaits between
          // family dispatches). agent-core invokes emit() back-to-back
          // synchronously — `emit('tool_calls'); emit('tool_execute');`
          // in the same call stack. If we await each family handler,
          // microtask interleaving makes tool_execute's handler append
          // the bandit-tl marker BEFORE tool_calls's handler truncates
          // content to currentIterationStartLength — and the truncation
          // then wipes the marker. The bandit-tl timeline rows
          // disappeared from the chat panel on the v1.7.349-era native-
          // tools path. Keep these calls sync.
          handleChatEvent(type, payload, chatEventDeps);
          handleToolEvent(type, payload, toolEventDeps);
          handleIterationEvent(type, payload, iterationEventDeps);
          handleMetaEvent(type, payload, metaEventDeps);
        }
      });

      // Compaction budget: reserve ~25% of num_ctx for the model's
      // response + system prompt headroom, give the remaining ~75% to
      // the rolling tool-result history. Ollama's runtime options are
      // the single source of truth here — if the cluster rebuilds the
      // 31B Modelfile with a larger num_ctx, this auto-adapts.
      // Seed the tool-use loop with prior conversation turns so
      // follow-up prompts ("you didn't update the health controller")
      // carry context from the previous turn. Without this, the
      // extension called loop.run(userGoal, ...) every turn, which
      // starts fresh with only the system prompt + current user
      // message — the model had no memory of what it just did. The
      // CLI already does this via runWithMessages; parity now.
      const seedMessages: ToolLoopMessage[] = this.conversation
        .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
        .filter((entry) => entry.id !== assistantEntry.id)
        .filter((entry) => typeof entry.content === 'string' && entry.content.trim().length > 0)
        .map((entry) => ({
          role: entry.role as 'user' | 'assistant',
          content: typeof entry.content === 'string' ? entry.content : ''
        }));
      // Ensure the current user turn is the last message the loop sees.
      if (seedMessages.length === 0 || seedMessages[seedMessages.length - 1].content !== userGoal) {
        seedMessages.push({ role: 'user', content: userGoal });
      }
      const result = await loop.runWithMessages(seedMessages, chat, systemPrompt, {
        messageTokenBudget,
        nativeTools,
        nativeToolFailureFallback,
        maxParallelTools,
        outputBudgetTokens,
        signal: turnSignal,
        // Mid-turn injection of completed-subagent synopses (v1.7.336+).
        // backgroundTasks coordinator subscribes to the store's
        // complete/failed/cancelled events and queues synopses; this
        // callback drains them at each iteration boundary so the
        // parent loop sees results as they arrive instead of poll-
        // spinning on check_task.
        drainExternalMessages: () => this.backgroundTasks.drainPendingMessages()
      });
      if (this.activeAbortController === turnAbortController) {
        this.activeAbortController = undefined;
      }
      indicators.stopThinking();
      indicators.stopToolCallGen();
      // Final iteration's edits weren't flushed by an iteration
      // boundary (there wasn't a next iteration). Flush them now so
      // the user sees diff cards for the last edit batch too.
      flushPendingEditDiffs();
      await turnLog?.append({
        type: 'final-response',
        iterations: result.iterations,
        hitLimit: result.hitLimit,
        finalPreview: previewText(result.finalResponse),
        logPath: turnLog.filePath
      });
      await runHooks('Stop', hookSettings, {}, workspaceRoot).catch(() => undefined);
      // Compose the assistant entry's final content. The helper owns
      // the tool-activity transcript merge, the pure-Q&A short-circuit,
      // the animation gate, and the tail-marker strip — see its JSDoc
      // for the load-bearing details.
      await composeFinalAssistantEntry({
        state,
        assistantEntry,
        finalResponseRaw: result.finalResponse,
        iterations: result.iterations,
        animateAssistantResponse: (entry, text) => this.animateAssistantResponse(entry, text)
      });

      await finalizeTurnSuccess({
        ctx: this,
        configuration,
        userGoal,
        apiKey,
        providerKind,
        assistantEntry,
        activeTurnStartedAt: this.activeTurnStartedAt,
        disposeIndicators,
        iterations: result.iterations,
        voice: this.voice
      });
    } catch (error) {
      turnTelemetryError = (error as { code?: string })?.code === 'USER_ABORT' ? 'cancelled' : 'error';
      await finalizeTurnError({
        ctx: this,
        configuration,
        userGoal,
        apiKey,
        providerKind,
        assistantEntry,
        activeTurnStartedAt: this.activeTurnStartedAt,
        disposeIndicators,
        error,
        assistantAdded
      });
    } finally {
      this.telemetry?.endTurn(turnTelemetryError ? { error: turnTelemetryError } : undefined);
      await finalizeTurnAlways({
        ctx: this,
        cancelActiveStream: () => this.cancelActiveStream()
      });
    }
  }

  private getToolLoopIteration(payload: unknown, fallback: number): number {
    if (payload && typeof payload === 'object') {
      const rawIteration = (payload as { iteration?: unknown }).iteration;
      if (typeof rawIteration === 'number' && Number.isFinite(rawIteration) && rawIteration >= 0) {
        return Math.floor(rawIteration);
      }
    }
    return fallback;
  }

  private async animateAssistantResponse(entry: ConversationEntry, text: string, preamble?: string): Promise<void> {
    const source = text.trim();
    const prefix = preamble ? `${preamble.trimEnd()}\n\n` : '';
    if (!source) {
      entry.content = preamble ? preamble.trimEnd() : '';
      entry.payload = entry.content;
      entry.timestamp = Date.now();
      return;
    }

    const tokens = source.split(/(\s+)/).filter((token) => token.length > 0);
    const maxChunks = 60;
    const chunkSize = Math.max(1, Math.ceil(tokens.length / maxChunks));
    // Seed the entry with the preserved activity transcript so the
    // diff cards / plan remain visible while the final prose animates
    // in beneath them.
    entry.content = prefix;
    entry.payload = prefix;
    entry.timestamp = Date.now();
    await this.syncState();

    for (let index = 0; index < tokens.length; index += chunkSize) {
      const chunk = tokens.slice(index, index + chunkSize).join('');
      entry.content += chunk;
      entry.payload = entry.content;
      entry.timestamp = Date.now();
      await this.syncState();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private buildChatRequest(configuration: vscode.WorkspaceConfiguration, contextBlock?: string): AIChatRequest {
    const providerKind = this.getProviderKind(configuration);
    const lastUserEntry = [...this.conversation]
      .reverse()
      .find((entry) => entry.role === 'user');
    const hasImages = Boolean(lastUserEntry?.images?.length);
    const model = providerKind === 'ollama'
      ? this.resolveChatModel(configuration, hasImages)
      : (configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1');
    const temperature = configuration.get<number>('temperature', 0.2);
    const topP = configuration.get<number>('topP', 1);
    const allowInlineImages = this.canUseInlineImages(configuration, model);
    const messages: AIChatRequest['messages'] = [];

    const systemPrompt = buildSystemPrompt({ providerKind, configuration, contextBlock, modelIdOverride: model, userGoal: lastUserEntry?.content });
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      });
    }

    for (const entry of this.conversation) {
      messages.push({
        role: entry.role,
        content: this.buildMessageContent(entry, allowInlineImages)
      });
    }

    const request: AIChatRequest = {
      model,
      messages,
      stream: true,
      temperature
    };

    if (typeof topP === 'number' && !Number.isNaN(topP)) {
      request.options = { top_p: topP };
    }

    if (allowInlineImages && lastUserEntry) {
      const payloadImages = lastUserEntry?.images
        ?.map((image) => this.extractImagePayload(image))
        .filter((image) => image.length > 0);
      if (payloadImages && payloadImages.length > 0) {
        request.images = payloadImages;
      }
    }

    return request;
  }

  private buildMessageContent(entry: ConversationEntry, allowInlineImages: boolean): AIChatRequest['messages'][number]['content'] {
    const payload = typeof entry.payload === 'string' && entry.payload.length > 0
      ? entry.payload
      : entry.content;
    const text = typeof payload === 'string' ? payload : payload != null ? String(payload) : '';

    if (!allowInlineImages) {
      return text;
    }

    const images = Array.isArray(entry.images) ? entry.images : [];
    if (images.length === 0) {
      return text;
    }

    const parts: AIMessageContentPart[] = [];
    if (text.trim().length > 0) {
      parts.push({ type: 'text', text });
    }

    for (const rawImage of images) {
      const normalized = this.extractImagePayload(rawImage);
      if (!normalized) {
        continue;
      }
      parts.push({ type: 'image_url', image_url: { url: normalized } });
    }

    if (parts.length === 0) {
      return text;
    }

    if (parts.length === 1 && parts[0]?.type === 'text') {
      return parts[0].text;
    }

    return parts;
  }

  private isInlineImageEnabled(configuration: vscode.WorkspaceConfiguration): boolean {
    const provider = this.getProviderKind(configuration);
    if (provider === 'bandit') {
      // Defer to the capability profile instead of a hardcoded
      // `bandit-core` prefix check. bandit-logic (Qwen 3.6 27B wrapper)
      // is multimodal — declaring supportsVision: true in its profile
      // means we should let images through. The previous prefix check
      // returned false for bandit-logic and the webview disabled the
      // image-upload UI even though the gateway path could have
      // handled the image fine. .
      const model = configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1';
      return this.modelSupportsVision(model);
    }
    if (provider === 'ollama') {
      const visionModel = this.resolveChatModel(configuration, true);
      return this.canUseInlineImages(configuration, visionModel);
    }
    return false;
  }

  private calculateContextUsage(configuration: vscode.WorkspaceConfiguration, overrideMessages?: ConversationEntry[]): { used: number; limit: number } | undefined {
    if (!this.isInlineImageEnabled(configuration)) {
      return undefined;
    }

    const limit = 128_000;
    const messages = overrideMessages ?? this.conversation;
    const hasImages = messages.some((entry) => Array.isArray(entry.images) && entry.images.length > 0);
    const providerKind = this.getProviderKind(configuration);
    const model = providerKind === 'ollama'
      ? this.resolveChatModel(configuration, hasImages)
      : (configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1');
    const systemPrompt = buildSystemPrompt({ providerKind, configuration, modelIdOverride: model });
    let used = 0;
    if (systemPrompt) {
      used += this.estimateTokenUsage(systemPrompt);
    }

    for (const entry of messages) {
      const messageContent = typeof entry.payload === 'string' && entry.payload.length > 0 ? entry.payload : entry.content;
      used += this.estimateTokenUsage(messageContent);
      if (Array.isArray(entry.images) && entry.images.length > 0) {
        used += entry.images.length * 2048;
      }
    }

    return { used, limit };
  }

  private async interpretIntent(
    prompt: string,
    configuration: vscode.WorkspaceConfiguration,
    providerKind: ProviderKind
  ): Promise<IntentInsight | undefined> {
    if (providerKind !== 'bandit') {
      return undefined;
    }
    const apiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
    if (!apiKey) {
      return undefined;
    }

    const intentUrl = resolveIntentUrl(configuration);
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
    const filePath = editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
    const languageId = editor?.document.languageId;

    const payload = {
      text: prompt,
      mode: 'agent' as ModeKind,
      provider: providerKind,
      context: {
        filePath,
        languageId,
        selection,
        workspace: vscode.workspace.name
      }
    };

    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      return undefined;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${trimmedApiKey}`
    };

    let rawData: Record<string, unknown> | undefined;
    let primaryError: unknown;

    try {
      const response = await fetch(intentUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Intent request failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
      }

      rawData = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      primaryError = error;
      console.warn('Bandit intent endpoint unavailable, attempting completions fallback.', error);
    }

    if (!rawData) {
      try {
        rawData = await this.requestIntentViaCompletions(
          prompt,
          {
            mode: 'agent' as ModeKind,
            filePath,
            languageId,
            selection,
            workspace: vscode.workspace.name ?? undefined
          },
          configuration,
          trimmedApiKey
        );
      } catch (fallbackError) {
        const finalError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        if (primaryError instanceof Error) {
          throw new Error(`${primaryError.message}; completions fallback failed: ${finalError.message}`);
        }
        throw finalError;
      }
    }

    if (!rawData) {
      return undefined;
    }

    const normalized = normalizeIntentInsight({
      ...rawData,
      action: typeof rawData.action === 'string' && rawData.action.trim().length > 0
        ? rawData.action
        : 'general_assist',
      summary: typeof rawData.summary === 'string' ? rawData.summary : undefined,
      intent: typeof rawData.intent === 'string' ? rawData.intent : undefined,
      target: typeof rawData.target === 'string' ? rawData.target : undefined,
      confidence: typeof rawData.confidence === 'number' ? rawData.confidence : undefined,
      rationale: typeof rawData.rationale === 'string' ? rawData.rationale : undefined,
      raw: rawData
    });

    if (!normalized) {
      return undefined;
    }

    const summary = summarizeIntent(normalized);
    return { ...normalized, summary };
  }

  private async fetchSemanticKnowledge(
    prompt: string,
    configuration: vscode.WorkspaceConfiguration,
    apiKey: string
  ): Promise<string> {
    try {
      const semanticUrl = resolveSemanticUrl(configuration);
      const response = await fetch(semanticUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          text: prompt,
          topK: 1,
          ns: 'bandit-core'
        })
      });
      if (!response.ok) {
        return '';
      }
      const results = (await response.json()) as Array<{ payload?: { text?: string; source?: string; ns?: string } }>;
      const top = Array.isArray(results) ? results[0] : undefined;
      const snippet = top?.payload?.text ?? '';
      if (!snippet || typeof snippet !== 'string') {
        return '';
      }
      return `Bandit context:\n${snippet.trim()}`;
    } catch (error) {
      console.warn('Semantic knowledge lookup failed:', error);
      return '';
    }
  }

  private async requestIntentViaCompletions(
    prompt: string,
    context: { mode: ModeKind; filePath?: string; languageId?: string; selection?: string; workspace?: string },
    configuration: vscode.WorkspaceConfiguration,
    apiKey: string
  ): Promise<Record<string, unknown> | undefined> {
    if (this.getProviderKind(configuration) !== 'bandit') {
      return undefined;
    }
    const messages = buildIntentClassificationMessages(prompt, context);
    const responseText = await this.runBanditCompletion(messages, configuration, apiKey, { temperature: 0 });
    const parsed = extractJsonObject(responseText);
    if (!parsed) {
      console.warn('Intent fallback response not parseable as JSON.', responseText);
      return undefined;
    }
    return parsed;
  }

  private async submitFeedbackViaCompletions(
    payload: FeedbackRequest,
    configuration: vscode.WorkspaceConfiguration,
    apiKey: string
  ): Promise<void> {
    if (this.getProviderKind(configuration) !== 'bandit') {
      return;
    }
    const messages = buildFeedbackTriageMessages(payload);
    const responseText = await this.runBanditCompletion(messages, configuration, apiKey, { temperature: 0.15 });
    const parsed = extractJsonObject(responseText);
    if (parsed) {
      console.info('Feedback captured via completions fallback:', parsed);
    } else {
      console.info('Feedback captured via completions fallback (raw):', responseText.trim());
    }
  }

  private async runBanditCompletion(
    messages: AIChatRequest['messages'],
    configuration: vscode.WorkspaceConfiguration,
    apiKey: string,
    options?: { temperature?: number; topP?: number }
  ): Promise<string> {
    if (this.getProviderKind(configuration) !== 'bandit') {
      throw new Error('Bandit completion fallback unavailable for the current provider.');
    }

    const modelSetting = configuration.get<string>('model', 'bandit-core-1');
    const model = modelSetting && modelSetting.trim().length > 0 ? modelSetting.trim() : 'bandit-core-1';
    const ollamaAuth = await Promise.resolve(this.context.secrets.get(OLLAMA_AUTH_SECRET_KEY)).catch(() => undefined);
    const provider = await createProvider(this.buildProviderSettings(configuration, apiKey, ollamaAuth));

    const request: AIChatRequest = {
      model,
      messages,
      stream: false,
      temperature: options?.temperature ?? 0
    };

    const topPSetting = typeof options?.topP === 'number' ? options.topP : configuration.get<number>('topP', 1);
    if (typeof topPSetting === 'number' && !Number.isNaN(topPSetting)) {
      request.options = { top_p: topPSetting };
    }

    return collectCompletionResult(provider, request);
  }

  private findNearestUserMessage(messages: ConversationEntry[], referenceId: string): ConversationEntry | undefined {
    const index = messages.findIndex((entry) => entry.id === referenceId);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = messages[cursor];
      if (candidate?.role === 'user') {
        return candidate;
      }
    }
    return undefined;
  }

  private async handleFeedbackSubmission(messageId: string, rating: FeedbackRating): Promise<void> {
    const conversation = this.ensureActiveConversation();
    const index = conversation.messages.findIndex((entry) => entry.id === messageId);
    if (index === -1) {
      return;
    }

    const target = conversation.messages[index];
    if (target.role !== 'assistant') {
      return;
    }

    const updated: ConversationEntry = {
      ...target,
      feedback: {
        rating,
        submitted: false,
        submittedAt: Date.now()
      }
    };

    conversation.messages[index] = updated;
    this.conversation = conversation.messages;
    await this.persistConversationHistory();
    await this.syncState();

    try {
      await this.sendChatFeedback(updated, rating, conversation);
      conversation.messages[index] = {
        ...updated,
        feedback: {
          ...(updated.feedback ?? {}),
          submitted: true,
          submittedAt: Date.now()
        }
      };
      this.conversation = conversation.messages;
      await this.persistConversationHistory();
      await this.syncState();
      // silent acknowledgement — the thumbs-up/down button state flips visually.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage({ type: 'notification', message: `Unable to send feedback: ${message}` });
    }
  }

  private async sendChatFeedback(
    entry: ConversationEntry,
    rating: FeedbackRating,
    conversation: ConversationRecord
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const nearestUser = this.findNearestUserMessage(conversation.messages, entry.id);
    const summary = truncateForFeedback(entry.content, 1600);
    const prompt = nearestUser ? truncateForFeedback(nearestUser.content, 800) : undefined;

    const descriptionParts = [
      `Rating: ${rating}`,
      `Assistant message:\n${summary}`
    ];

    if (prompt) {
      descriptionParts.push(`User prompt:\n${prompt}`);
    }

    if (entry.intent?.summary) {
      descriptionParts.push(`Intent: ${entry.intent.summary}`);
    }

    const payload: FeedbackRequest = {
      title: rating === 'up' ? 'Chat feedback — positive' : 'Chat feedback — needs improvement',
      description: descriptionParts.join('\n\n'),
      category: rating === 'up' ? 'feature' : 'improvement',
      priority: rating === 'down' ? 'high' : 'medium',
      sessionInfo: { conversationId: this.currentConversationId }
    };

    await this.sendFeedbackRequest(payload, configuration);
  }

  public async sendFeedbackRequest(payload: FeedbackRequest, configuration: vscode.WorkspaceConfiguration): Promise<void> {
    const feedbackUrl = resolveFeedbackUrl(configuration);
    const providerKind = this.getProviderKind(configuration);
    const apiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
    const trimmedApiKey = apiKey?.trim() ?? '';

    if (providerKind === 'bandit' && trimmedApiKey.length === 0) {
      throw new Error('Bandit API key required.');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (trimmedApiKey.length > 0) {
      headers.Authorization = `Bearer ${trimmedApiKey}`;
    }

    try {
      const response = await fetch(feedbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Feedback request failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
      }
    } catch (error) {
      if (providerKind === 'bandit' && trimmedApiKey.length > 0) {
        console.warn('Bandit feedback endpoint unavailable, attempting completions fallback.', error);
        await this.submitFeedbackViaCompletions(payload, configuration, trimmedApiKey);
        return;
      }

      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private estimateTokenUsage(text: string | undefined): number {
    if (!text) {
      return 0;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return 0;
    }
    return Math.max(1, Math.ceil(trimmed.length / 4));
  }

  private extractImagePayload(image: string): string {
    if (typeof image !== 'string') {
      return '';
    }
    const trimmed = image.trim();
    if (!trimmed) {
      return '';
    }
    if (/^data:/i.test(trimmed) || /^https?:/i.test(trimmed)) {
      return trimmed;
    }
    return `data:image/png;base64,${trimmed}`;
  }

  /**
   * Builds a slim workspace-context block: open editor path + git-modified
   * file names. NO embeddings, NO file contents, NO network — just
   * metadata pointing the agent at where to look. The agent uses its own
   * tools (`read_file` / `grep` / `list_dir`) to read whatever it actually
   * cares about.
   *
   * replaced the heavy ContextBuilder pipeline (Qdrant +
   * nomic-embed-text + per-file content dump) with this slim path.
   * Reasons: the heavy version dumped full file contents into the prompt
   * (~12.8 KB on every turn) and added 500 ms–2 s of latency per turn
   * for embedding round-trips. With auto-context defaulted off, real
   * users almost never enabled it because of that cost. The slim version
   * is so cheap (a `git status` + a path read) that the setting can
   * actually be useful when ON.
   *
   * The setting name (`banditStealth.autoContextEnabled`) is preserved
   * for back-compat. Default stays false in flip to true in
   * a follow-up once the slim path has soaked.
   */
  public async buildContextBlock(userMessage: string, configuration: vscode.WorkspaceConfiguration): Promise<BuiltContext | undefined> {
    if (!userMessage.trim()) {return undefined;}
    const autoContextEnabled = configuration.get<boolean>('autoContextEnabled', false) ?? false;
    if (!autoContextEnabled) {return undefined;}

    const editor = vscode.window.activeTextEditor;
    const currentFilePath = editor?.document.uri.fsPath;
    const gitModifiedFiles = await this.getGitModifiedNames();

    const result = buildSlimContext({ currentFilePath, gitModifiedFiles });
    if (result.source === 'none') {return undefined;}

    // Keep the status-bar contextBudget signal alive so existing UI keeps
    // rendering. The slim path produces tiny token estimates by design;
    // the bar will show "auto-context: pinned-only · ~N tokens".
    const recentUserEntry = [...this.conversation].reverse().find((entry) => entry.role === 'user');
    const hasRecentImages = Boolean(recentUserEntry?.images?.length);
    const modelId = this.getProviderKind(configuration) === 'ollama'
      ? this.resolveChatModel(configuration, hasRecentImages)
      : configuration.get<string>('model', 'bandit-core-1');
    const caps = getModelCapabilities(modelId);
    const budget = { tokenEstimate: result.tokenEstimate, contextWindow: caps.contextWindow, source: result.source };
    this.lastContextBudget = budget;
    this._onDidChangeStatus.fire({ busy: this.isBusy, text: this.statusText, contextBudget: budget });

    return result;
  }

  /**
   * Lists up to 10 git-modified file names (no contents) for slim context.
   * Uses `git status --porcelain` so we get both staged and unstaged
   * changes plus a one-letter status code (M/A/D/?/R). Silent failure if
   * git is unavailable or the workspace has no repo — slim context just
   * falls back to "open editor only" or "none".
   */
  private async getGitModifiedNames(): Promise<Array<{ path: string; status?: string }>> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {return [];}

    const git = spawnSync('git', ['status', '--porcelain', '--no-renames'], {
      cwd: workspaceRoot,
      encoding: 'utf8'
    });

    if (git.status !== 0 || !git.stdout) {return [];}

    return git.stdout
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter(Boolean)
      .map((line) => {
        // Porcelain v1: 2-char status (XY), space, then path.
        // Collapse to a single non-space code so the prompt stays readable.
        const xy = line.slice(0, 2);
        const code = (xy[0] !== ' ' ? xy[0] : xy[1]) || undefined;
        const filePath = line.slice(3).trim();
        return { path: filePath, status: code };
      })
      .filter((e) => e.path)
      .slice(0, 10);
  }

  public getProviderKind(configuration: vscode.WorkspaceConfiguration): ProviderKind {
    const rawProvider = configuration.get<string>('provider', 'ollama');
    const normalized = typeof rawProvider === 'string' ? rawProvider.trim().toLowerCase() : 'ollama';

    if (normalized === 'ollama') {return 'ollama';}
    if (normalized === 'openai-compatible' || normalized === 'openai') {return 'openai-compatible';}
    return 'bandit';
  }

  private normalizeConfiguredModel(modelValue: string | undefined, fallback: string): string {
    const normalized = typeof modelValue === 'string' ? modelValue.trim() : '';
    if (normalized.length > 0) {
      return normalized;
    }
    return fallback;
  }

  private isOllamaAutoRoutingEnabled(configuration: vscode.WorkspaceConfiguration): boolean {
    return configuration.get<boolean>('ollamaAutoRouteModels', true) !== false;
  }

  private resolveOllamaBaseModel(configuration: vscode.WorkspaceConfiguration): string {
    return this.normalizeConfiguredModel(
      configuration.get<string>('ollamaModel', 'gemma3:12b'),
      'gemma3:12b'
    );
  }

  private resolveOllamaCodingModel(configuration: vscode.WorkspaceConfiguration): string {
    const explicitCodingModel = this.normalizeConfiguredModel(
      configuration.get<string>('ollamaCodingModel', ''),
      ''
    );
    if (explicitCodingModel) {
      return explicitCodingModel;
    }
    const explicitAgentModel = this.normalizeConfiguredModel(
      configuration.get<string>('agentOllamaModel', ''),
      ''
    );
    if (explicitAgentModel) {
      return explicitAgentModel;
    }
    return this.resolveOllamaBaseModel(configuration);
  }

  private resolveOllamaVisionModel(configuration: vscode.WorkspaceConfiguration): string {
    const explicitVisionModel = this.normalizeConfiguredModel(
      configuration.get<string>('ollamaVisionModel', ''),
      ''
    );
    if (explicitVisionModel) {
      return explicitVisionModel;
    }
    return this.resolveOllamaBaseModel(configuration);
  }

  private resolveChatModel(configuration: vscode.WorkspaceConfiguration, hasImages: boolean): string {
    if (this.getProviderKind(configuration) !== 'ollama') {
      return this.normalizeConfiguredModel(
        configuration.get<string>('model', 'bandit-core-1'),
        'bandit-core-1'
      );
    }
    if (!this.isOllamaAutoRoutingEnabled(configuration)) {
      return this.resolveOllamaBaseModel(configuration);
    }
    return hasImages
      ? this.resolveOllamaVisionModel(configuration)
      : this.resolveOllamaCodingModel(configuration);
  }

  private resolveAgentModel(configuration: vscode.WorkspaceConfiguration): string {
    if (this.getProviderKind(configuration) !== 'ollama') {
      return this.normalizeConfiguredModel(
        configuration.get<string>('model', 'bandit-core-1'),
        'bandit-core-1'
      );
    }
    const explicitAgentModel = this.normalizeConfiguredModel(
      configuration.get<string>('agentOllamaModel', ''),
      ''
    );
    if (explicitAgentModel) {
      return explicitAgentModel;
    }
    if (!this.isOllamaAutoRoutingEnabled(configuration)) {
      return this.resolveOllamaBaseModel(configuration);
    }
    return this.resolveOllamaCodingModel(configuration);
  }

  private modelSupportsVision(modelId: string): boolean {
    const normalizedModelId = modelId.trim().toLowerCase();
    if (!normalizedModelId) {
      return false;
    }
    if (getModelCapabilities(normalizedModelId).supportsVision) {
      return true;
    }
    return normalizedModelId.includes('vision')
      || normalizedModelId.includes('llava')
      || normalizedModelId.includes('-vl')
      || normalizedModelId.includes('vl:')
      || normalizedModelId.startsWith('gemma3:')
      || normalizedModelId.startsWith('gemma4:')
      || normalizedModelId.startsWith('gemma4');
  }

  private canUseInlineImages(configuration: vscode.WorkspaceConfiguration, modelId?: string): boolean {
    const provider = this.getProviderKind(configuration);
    if (provider === 'bandit') {
      const model = this.normalizeConfiguredModel(
        modelId ?? configuration.get<string>('model', 'bandit-core-1'),
        'bandit-core-1'
      );
      // Use the capability profile (modelCapabilities.ts) instead of a
      // hardcoded `bandit-core` prefix check. bandit-logic (qwen3.6:27b
      // wrapper) is multimodal too — declaring supportsVision: true in
      // its profile means we should hand the image straight to the
      // model rather than running Apple Vision / tesseract OCR
      // first-pass. Hardcoding the prefix was bypassing the profile and
      // forcing OCR even when the model could see the image natively.
      return this.modelSupportsVision(model);
    }
    if (provider === 'ollama') {
      const candidateModel = this.normalizeConfiguredModel(modelId, this.resolveOllamaVisionModel(configuration));
      return this.modelSupportsVision(candidateModel);
    }
    return false;
  }

  public describeProvider(kind: ProviderKind): string {
    switch (kind) {
      case 'ollama':
        return 'Ollama';
      case 'openai-compatible':
        return 'OpenAI-compatible';
      default:
        return 'Bandit AI';
    }
  }

  private buildProviderSettings(configuration: vscode.WorkspaceConfiguration, apiKey: string, ollamaAuthToken?: string): ProviderSettings {
    const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
    const rawHeaders = configuration.get<Record<string, string>>('ollamaHeaders', {}) || {};
    const cleanHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (!key || typeof key !== 'string') {continue;}
      if (key.toLowerCase() === 'content-type') {continue;} // always forced by provider
      if (typeof value === 'string' && value.length > 0) {cleanHeaders[key] = value;}
    }
    // Auto-inject the secrets-stored Authorization header when present —
    // but ONLY if the user hasn't already declared an explicit
    // Authorization header in settings. Explicit config wins so custom
    // schemes (Basic, PrivateToken, etc.) aren't overridden.
    const hasExplicitAuth = Object.keys(cleanHeaders).some(k => k.toLowerCase() === 'authorization');
    if (ollamaAuthToken && !hasExplicitAuth) {
      cleanHeaders['Authorization'] = `Bearer ${ollamaAuthToken}`;
    }
    // OpenAI-compatible config — symmetric to ollamaHeaders parsing so
    // users can target Together, OpenRouter, Groq, LM Studio, etc. with
    // an explicit base URL, model id, and optional bearer/extra
    // headers. The Bandit-cloud and Ollama paths above are unchanged.
    const rawOpenaiHeaders = configuration.get<Record<string, string>>('openaiHeaders', {}) || {};
    const cleanOpenaiHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawOpenaiHeaders)) {
      if (!key || typeof key !== 'string') {continue;}
      if (key.toLowerCase() === 'content-type') {continue;}
      if (typeof value === 'string' && value.length > 0) {cleanOpenaiHeaders[key] = value;}
    }
    return {
      kind: this.getProviderKind(configuration),
      apiKey,
      apiUrl: configuration.get<string>('apiUrl', 'https://api.burtson.ai/completions'),
      // ollamaBaseUrl is the new primary; ollamaUrl is the legacy alias
      ollamaUrl:
        configuration.get<string>('ollamaBaseUrl', '') ||
        configuration.get<string>('ollamaUrl', DEFAULT_OLLAMA_URL) ||
        DEFAULT_OLLAMA_URL,
      ollamaNodeUrl: configuration.get<string>('ollamaNodeUrl', '') || undefined,
      ollamaModel: this.resolveOllamaBaseModel(configuration),
      ollamaHeaders: Object.keys(cleanHeaders).length > 0 ? cleanHeaders : undefined,
      openaiBaseUrl: configuration.get<string>('openaiBaseUrl', '') || undefined,
      openaiApiKey: configuration.get<string>('openaiApiKey', '') || undefined,
      openaiModel: configuration.get<string>('openaiModel', '') || undefined,
      openaiHeaders: Object.keys(cleanOpenaiHeaders).length > 0 ? cleanOpenaiHeaders : undefined
    };
  }

  /**
   * Build the AI summary callback for `/insights` from the IDE side.
   *
   * Mirrors the CLI path one-for-one: same provider settings, same
   * one-shot streaming-collect chat, same shared
   * `buildInsightsAiCallback` helper. Consent is auto-allowed for
   * Ollama (data never leaves the machine) and gated by the
   * `banditStealth.insightsAi` setting for cloud — `auto` (default)
   * prompts the user once with Allow/Always/Never; `allow` and `deny`
   * skip the prompt. Returns `undefined` to skip AI, in which case the
   * report falls back to the static, non-AI render.
   */
  public async buildInsightsAiCallbackForIde(): Promise<AiSummaryFn | undefined> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.getProviderKind(configuration);
    const apiKey = (await this.context.secrets.get(API_KEY_SECRET_KEY)) ?? '';
    const ollamaAuth = await Promise.resolve(this.context.secrets.get(OLLAMA_AUTH_SECRET_KEY)).catch(() => undefined);
    if (providerKind === 'bandit' && !apiKey) {return undefined;}

    if (providerKind !== 'ollama') {
      const consent = configuration.get<'auto' | 'allow' | 'deny'>('insightsAi', 'auto');
      if (consent === 'deny') {return undefined;}
      if (consent === 'auto') {
        const choice = await vscode.window.showInformationMessage(
          'Allow Bandit to send aggregate session counts (no file paths, no full prompts) to your cloud model for an AI insights summary?',
          { modal: false },
          'Allow once',
          'Always allow',
          'Never'
        );
        if (!choice || choice === 'Never') {
          if (choice === 'Never') {
            try {
              await configuration.update('insightsAi', 'deny', vscode.ConfigurationTarget.Global);
            } catch {
              // Older install where banditStealth.insightsAi isn't yet
              // declared in contributes.configuration. Don't block the
              // user — fall back to a soft warning so the choice still
              // takes effect for THIS session.
              void vscode.window.showWarningMessage(
                'Could not save your "Never" choice — your installed Bandit extension is out of date and does not yet recognize this setting. Update the Bandit Stealth extension and try again. Skipping AI insights for this run.'
              );
            }
          }
          return undefined;
        }
        if (choice === 'Always allow') {
          try {
            await configuration.update('insightsAi', 'allow', vscode.ConfigurationTarget.Global);
          } catch {
            // Same fallback — let the user proceed for THIS run instead
            // of erroring out. Surface the cause so they can update.
            void vscode.window.showWarningMessage(
              'Could not save your "Always allow" choice — your installed Bandit extension is out of date and does not yet recognize this setting. Update the Bandit Stealth extension to persist the choice. Continuing with AI insights for this run.'
            );
          }
        }
      }
    }

    const settings = this.buildProviderSettings(configuration, apiKey, ollamaAuth);
    const model = providerKind === 'ollama'
      ? this.resolveOllamaBaseModel(configuration)
      : (configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1');

    const oneShotChat: OneShotChatFn = async (prompt, opts) => {
      try {
        const provider = await createProvider(settings);
        const messages: AIChatRequest['messages'] = [];
        if (opts?.systemPrompt) {
          messages.push({ role: 'system', content: opts.systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        const request: AIChatRequest = {
          model,
          messages,
          stream: true,
          temperature: 0.3
        };
        const timeoutMs = opts?.timeoutMs ?? 30_000;
        let collected = '';
        const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
        const stream = (async () => {
          for await (const chunk of provider.chat(request)) {
            const text = (chunk as AIChatResponse).message?.content ?? '';
            if (typeof text === 'string' && text.length > 0) {collected += text;}
            if ((chunk as AIChatResponse).done) {break;}
          }
          return collected;
        })();
        const result = await Promise.race([stream, deadline]);
        return typeof result === 'string' && result.trim().length > 0 ? result : null;
      } catch {
        return null;
      }
    };

    return buildInsightsAiCallback({ oneShotChat, modelLabel: model });
  }

  public async setBusy(value: boolean, message?: string): Promise<void> {
    this.isBusy = value;
    if (typeof message === 'string') {
      this.statusText = message;
    } else if (!value) {
      this.statusText = 'Ready';
    }
    this._onDidChangeStatus.fire({ busy: this.isBusy, text: this.statusText, contextBudget: this.lastContextBudget });
    await this.syncState();
  }

  public async setStatusMessage(message: string): Promise<void> {
    this.statusText = message;
    this._onDidChangeStatus.fire({ busy: this.isBusy, text: this.statusText, contextBudget: this.lastContextBudget });
    await this.syncState();
  }

  public notifyUser(kind: 'approval' | 'complete' | 'error' | 'background', title: string, message: string, durationMs = 0): void {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    if (!(configuration.get<boolean>('notifications.enabled', true) ?? true)) {return;}
    const panelVisible = Boolean((this.view as { visible?: boolean } | undefined)?.visible);
    const minTurnMs = configuration.get<number>('notifications.minTurnMs', 30_000) ?? 30_000;
    if (kind === 'approval' && panelVisible) {return;}
    if (kind === 'complete' && panelVisible && durationMs < minTurnMs) {return;}

    const detail = message.length > 240 ? `${message.slice(0, 237)}...` : message;
    this.postMessage({ type: 'notification', message: `${title}: ${detail}` });
    if (kind === 'error') {
      void vscode.window.showErrorMessage(`${title}: ${detail}`);
    } else if (kind === 'approval') {
      void vscode.window.showWarningMessage(`${title}: ${detail}`, 'Open Bandit').then((choice) => {
        if (choice === 'Open Bandit') {void this.reveal();}
      });
    } else {
      void vscode.window.showInformationMessage(`${title}: ${detail}`);
    }
  }

  /**
   * Build the skill list the composer's `/` picker shows. Reuses the same
   * registry the tool-use loop instantiates per turn so the picker reflects
   * exactly what the agent would activate. Built-in skills are identified by
   * ids that match the curated set from `createDefaultSkillRegistry`; everything
   * else comes from `.bandit/skills/` in the workspace.
   */
  private async sendSkillList(): Promise<void> {
    const BUILTIN_SKILL_IDS = new Set([
      'core/filesystem',
      'core/git',
      'review/code-review',
      'testing/test-gen',
      'agent/plan',
      'search/semantic'
    ]);

    try {
      const registry = createDefaultSkillRegistry();
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const toolCtx = new NodeToolExecutionContext(workspaceRoot, createDefaultLanguageAdapters());
        await registerWorkspaceSkills(
          registry,
          (pattern, cwd) => toolCtx.listFiles(pattern, cwd),
          (absPath) => toolCtx.readFile(absPath),
          workspaceRoot
        ).catch(() => 0);
      }
      const skills = registry.getAll().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: BUILTIN_SKILL_IDS.has(skill.id) ? 'builtin' as const : 'workspace' as const
      }));
      // Sort: built-ins first (preserving default order), workspace second (alphabetical by id).
      const builtin = skills.filter((s) => s.source === 'builtin');
      const workspace = skills
        .filter((s) => s.source === 'workspace')
        .sort((a, b) => a.id.localeCompare(b.id));
      this.postMessage({ type: 'skillList', skills: [...builtin, ...workspace] });
    } catch (error) {
      console.warn('sendSkillList failed', error);
      this.postMessage({ type: 'skillList', skills: [] });
    }
  }

  private async flushState(): Promise<void> {
    if (!this.view) {
      return;
    }

    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.getProviderKind(configuration);
    // Resolve the slow-changing fields from cache when one is valid and
    // we're mid-stream. The cache lives until slowStateCache.invalidate()
    // fires from a key/secret mutation, a banditStealth.* config change,
    // or an explicit hand-off. Outside streaming, always do the fresh
    // resolve so external mutations (CLI's /tavily, another window
    // setting a key, etc.) reflect promptly.
    let slow = this.slowStateCache.get();
    if (!slow || !this.isBusy) {
      const storedApiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
      const apiKeyTrimmed = storedApiKey?.trim() || undefined;
      const storedOllamaAuth = await Promise.resolve(
        this.context.secrets.get(OLLAMA_AUTH_SECRET_KEY)
      ).catch(() => undefined);
      // Tavily BYOK presence. Resolves through the same chain the chat
      // engine uses (env → ~/.bandit/config.json → VS Code setting) so
      // the Settings panel's "Saved" badge reflects whichever surface
      // (CLI's /tavily or the IDE's Connections card) actually set the
      // key — not just the legacy VS Code setting. The webview only
      // ever sees the boolean; the key bytes never cross the postMessage
      // boundary.
      slow = {
        hasStoredApiKey: Boolean(storedApiKey),
        hasApiKey: providerKind === 'ollama' ? true : Boolean(storedApiKey),
        apiKeyTrimmed,
        hasOllamaAuthToken: Boolean(storedOllamaAuth),
        hasTavilyKey: Boolean(resolveTavilyKey(configuration)),
        mcpSnapshot: await this.mcp.buildSnapshot()
      };
      this.slowStateCache.set(slow);
    }
    const hasStoredApiKey = slow.hasStoredApiKey;
    // Cache the resolved key for the MCP pool's sync resolveAuthToken
    // callback (URL-based remote MCP servers like mcp.burtson.ai use
    // this).
    this.mcp.setBanditApiKey(slow.apiKeyTrimmed);
    const requiresApiKey = providerKind !== 'ollama';
    const hasApiKey = requiresApiKey ? hasStoredApiKey : true;
    const hasOllamaAuthToken = slow.hasOllamaAuthToken;
    const hasTavilyKey = slow.hasTavilyKey;

    const currentConversation = this.getCurrentConversation();
    const currentConversationName = currentConversation?.name
      ?? (this.conversation.length > 0
        ? deriveConversationNameFromEntries(this.conversation, 'Recents')
        : 'Recents');

    this.intent.syncFromConversation(this.conversation);

    const nonEmptyConversations = this.getSortedConversations(true).filter(
      (conversation) => conversation.messages.length > 0
    );
    const activeConversationIncluded = nonEmptyConversations.some((conversation) => conversation.id === this.currentConversationId);
    const shouldForceWorkspaceView = !hasApiKey || nonEmptyConversations.length === 0;
    if (shouldForceWorkspaceView && this.historyVisible) {
      this.historyVisible = false;
    }

    const isDeveloperMode = this.context.extensionMode === vscode.ExtensionMode.Development;
    const skipValidationInDev = configuration.get<boolean>('agent.skipValidationInDev', false) ?? false;

    const state: WebviewState = {
      messages: this.conversation,
      hasApiKey,
      hasStoredApiKey,
      requiresApiKey,
      isBusy: this.isBusy,
      presetPrompt: this.pendingPrompt,
      statusText: this.statusText,
      provider: providerKind,
      model: configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1',
      ollamaModel: configuration.get<string>('ollamaModel', 'gemma3:12b') ?? 'gemma3:12b',
      ollamaUrl:
        configuration.get<string>('ollamaBaseUrl', '') ||
        configuration.get<string>('ollamaUrl', 'http://localhost:11434') ||
        'http://localhost:11434',
      hasOllamaAuthToken,
      hasTavilyKey,
      extensionVersion: (this.context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown',
      currentConversationId: activeConversationIncluded ? this.currentConversationId : undefined,
      currentConversationName,
      history: this.getRecentConversationSummaries(nonEmptyConversations),
      hasArchivedConversations: this.hasArchivedConversations(),
      showHistory: this.historyVisible,
      allowImageUploads: this.isInlineImageEnabled(configuration),
      showIntentChips: false,
      feedbackEnabled: configuration.get<boolean>('feedback.enabled', true) ?? true,
      contextUsage: this.calculateContextUsage(configuration) ?? null,
      undoAvailable: this.undoSnapshotsAvailable,
      mode: 'agent' as ModeKind,
      intentInsight: this.intent.current ?? null,
      intentSuggestions: []
    };

    const planSnapshot = this.conversations.getPlanSnapshot();
    state.plan = planSnapshot.plan;
    state.planUpdates = planSnapshot.updates;
    state.planUnread = false;
    state.activePlanRunId = this.conversations.activePlanRunId ?? null;
    state.planHistory = this.conversations.serializePlanRuns(currentConversation?.planRuns ?? []);
    state.debugEmitPlanJson = configuration.get<boolean>('debug.emitPlanJson', true) ?? true;
    state.enableToolUse = configuration.get<boolean>('enableToolUse', true) ?? true;
    state.createBranchBeforeRun = configuration.get<boolean>('agent.createBranchBeforeRun', false) ?? false;
    state.autoApproveEdits = configuration.get<boolean>('agent.autoApproveEdits', false) ?? false;
    state.autoContextEnabled = configuration.get<boolean>('autoContextEnabled', false) ?? false;
    state.ollamaStatus = this.ollamaStatus;
    state.ollamaModelMissing = this.ollamaModelMissing;
    state.accountProfile = this.account.accountProfile ?? null;
    state.accountProfileStatus = this.account.accountProfileStatus;
    state.accountProfileError = this.account.accountProfileError;
    state.developerMode = isDeveloperMode;
    state.skipValidationInDev = skipValidationInDev;
    const voiceGates = readVoiceGates(configuration, hasStoredApiKey);
    state.voiceMicEnabled = voiceGates.micEnabled;
    state.voiceAutoSpeakPref = voiceGates.autoSpeakPref;
    state.voiceMicPref = voiceGates.micPref;
    state.voiceProviderSettings = readVoiceProviderSettings(configuration);
    state.mcpSnapshot = slow.mcpSnapshot;

    this.pendingPrompt = undefined;
    this.postMessage({ type: 'state', state });

    if (this.pendingOpenSettings) {
      this.postMessage({ type: 'openSettings' });
      this.pendingOpenSettings = false;
    }
  }

  /** Invalidation hook fired from the config-change listener in
   *  activate() and from any extracted module that mutates a value the
   *  slow-state slice depends on. The 8 in-class mutation sites still
   *  talk to `this.slowStateCache.invalidate()` directly; this method
   *  exists because it's part of the `ProviderContext` contract. */
  public invalidateSlowStateCache(): void {
    this.slowStateCache.invalidate();
  }

  public async syncState(): Promise<void> {
    if (this.syncScheduled) {
      return this.syncPromise ?? Promise.resolve();
    }
    this.syncScheduled = true;
    this.syncPromise = new Promise<void>((resolve) => {
      // Coalesce stream events on a 16ms tick (one frame at 60fps).
      // The original 60ms gate was ~16fps and made the extension feel
      // visibly laggier than the CLI even though both share the same
      // runtime — the CLI writes directly to stdout per chunk. 16ms
      // still batches multiple chunks that arrive within one paint
      // frame; the webview re-render budget is the real ceiling, not
      // the timer.
      setTimeout(() => {
        this.syncScheduled = false;
        void this.flushState()
          .catch((error) => {
            console.warn('State sync failed', error);
          })
          .finally(() => {
            resolve();
          });
      }, 16);
    });
    return this.syncPromise;
  }

  public postMessage(message: OutgoingMessage): void {
    this.view?.webview.postMessage(message);
  }

  private cancelActiveStream(): void {
    // Abort the tool-use-loop turn (chat with tools). Setting controller =
    // undefined first prevents finally-block races from re-clearing a
    // freshly-allocated controller when the user cancels and re-prompts
    // back-to-back.
    const controller = this.activeAbortController;
    if (controller) {
      this.activeAbortController = undefined;
      try {
        controller.abort();
      } catch {
        // ignore — abort() is a no-op once already-aborted, but defensive.
      }
    }
    const iterator = this.activeStream;
    if (!iterator) {
      return;
    }
    this.activeStream = undefined;
    if (typeof iterator.return === 'function') {
      void iterator.return().catch(() => {
        // ignore cancellation errors
      });
    }
  }

  private handleAgentEnvironmentMessage(message: unknown): void {
    this.agentActivityQueue = this.agentActivityQueue
      .then(async () => {
        await this.applyAgentEnvironmentMessage(message);
      })
      .catch((error) => {
        console.warn('Failed to update agent activity', error);
      });
  }

  private async applyAgentEnvironmentMessage(message: unknown): Promise<void> {
    await dispatchAgentEnvironmentMessage(this, this.agentEnvironmentBridgeDeps, message);
  }

  private async updateConversation(entries: ConversationEntry[], options?: { persist?: boolean }): Promise<void> {
    await this.conversations.updateMessages(entries, options);
    // After any message update, check whether we should kick off a name
    // upgrade. Fires once per conversation — the attempted-ids set
    // prevents repeated LLM calls on follow-up turns.
    if (options?.persist !== false) {
      void this.maybeUpgradeConversationName();
    }
  }

  /**
   * Upgrade a conversation's auto-derived name (first N chars of the
   * first user message) to a short, semantic summary the user is more
   * likely to remember. Runs ONCE per conversation, in the background,
   * after the first assistant response has been persisted. Silent
   * failures — if the LLM call errors or times out, we just keep the
   * original first-message name.
   */
  private conversationNameUpgradeAttempted = new Set<string>();
  private async maybeUpgradeConversationName(): Promise<void> {
    const conversation = this.getCurrentConversation();
    if (!conversation) {return;}
    if (this.conversationNameUpgradeAttempted.has(conversation.id)) {return;}

    const hasUser = conversation.messages.some(m => m.role === 'user' && m.content.trim().length > 0);
    const hasAssistant = conversation.messages.some(m => m.role === 'assistant' && m.content.trim().length > 0);
    if (!hasUser || !hasAssistant) {return;}

    // If the current name differs from the derived default, the user
    // already renamed it manually — respect that and don't overwrite.
    const derivedDefault = deriveConversationNameFromEntries(conversation.messages, 'New Conversation');
    if (conversation.name && conversation.name !== derivedDefault) {return;}

    this.conversationNameUpgradeAttempted.add(conversation.id);
    try {
      const summary = await this.summarizeConversationName(conversation.messages);
      if (!summary) {return;}
      // The conversation may have moved on while we were summarizing —
      // re-fetch and only apply if the name is still the derived default.
      const fresh = this.getCurrentConversation();
      if (!fresh || fresh.id !== conversation.id) {return;}
      const currentDefault = deriveConversationNameFromEntries(fresh.messages, 'New Conversation');
      if (fresh.name && fresh.name !== currentDefault) {return;}
      fresh.name = sanitizeConversationName(summary);
      this.conversation = fresh.messages;
      await this.persistConversationHistory();
      await this.syncState();
    } catch {
      // Summarization is best-effort; keep the derived name on failure.
    }
  }

  /**
   * Short non-streaming LLM call to distill a user+assistant exchange
   * into a 3–6 word title. Uses the currently-configured provider so
   * the cost/latency profile matches wherever the main chat is running.
   * Bounded at ~1–2 seconds typical latency.
   */
  private async summarizeConversationName(entries: ConversationEntry[]): Promise<string | null> {
    const firstUser = entries.find(e => e.role === 'user' && e.content.trim().length > 0);
    const firstAssistant = entries.find(e => e.role === 'assistant' && e.content.trim().length > 0);
    if (!firstUser || !firstAssistant) {return null;}
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = this.getProviderKind(configuration);
    const apiKey = await this.context.secrets.get(API_KEY_SECRET_KEY);
    if (providerKind === 'bandit' && !apiKey) {return null;}
    const ollamaAuth = await Promise.resolve(this.context.secrets.get(OLLAMA_AUTH_SECRET_KEY)).catch(() => undefined);
    const provider = await createProvider(this.buildProviderSettings(configuration, apiKey ?? '', ollamaAuth));
    const model = providerKind === 'ollama'
      ? this.resolveOllamaBaseModel(configuration)
      : configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1';
    // Keep the input tight — summaries from excerpts are fine, and we
    // want this to be fast. 600 chars from each message covers the gist
    // of typical turns without bloating the request.
    const userExcerpt = firstUser.content.slice(0, 600);
    const assistantExcerpt = firstAssistant.content.slice(0, 600);
    const request: AIChatRequest = {
      model,
      messages: [
        {
          role: 'system',
          content: 'You name chat threads. Reply with a concise 3-6 word title describing the conversation, suitable for a sidebar list. No quotes, no trailing punctuation, no emojis, no prefix like "Title:". Just the bare title.'
        },
        {
          role: 'user',
          content: `User asked:\n${userExcerpt}\n\nAssistant replied:\n${assistantExcerpt}\n\nTitle:`
        }
      ],
      stream: false,
      temperature: 0.3
    };
    let text = '';
    for await (const chunk of provider.chat(request)) {
      text += chunk.message?.content ?? '';
      if (chunk.done) {break;}
    }
    // Post-process aggressively: small models wrap the title in
    // `<think>…</think>` reasoning blocks, prefix with "Here's a good
    // title:", or return it as a markdown header. Walk the output,
    // peel off each layer, and return the last usable line.
    // 1. Strip <think>...</think> blocks (DeepSeek-R1, Qwen reasoning variants)
    // 2. Strip leading/trailing fenced code blocks
    // 3. Drop obvious preamble lines ("Here is a title:", etc.)
    // 4. Walk remaining non-empty lines; first viable one wins
    let cleaned = text
      .replace(/<think[^>]*>[\s\S]*?<\/think\s*>/gi, '')
      .replace(/^```[\s\S]*?```$/gm, '')
      .trim();
    const prefaceRe = /^(?:here(?:'?s|\s+is)|sure|okay|title|topic|subject|a\s+good\s+title)\b[^\n]*\n/i;
    while (prefaceRe.test(cleaned)) {
      cleaned = cleaned.replace(prefaceRe, '').trim();
    }
    const lines = cleaned.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const title = lines.find(line => {
      // Skip lines that are still obvious meta (numbered prefix, markdown
      // heading markers, bullet prefixes) — normalize them instead.
      const normalized = line
        .replace(/^[#*>\-+\s]+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^["'`*_]+|["'`*_]+$/g, '')
        .replace(/^(?:title|topic|subject)\s*:\s*/i, '')
        .trim();
      return normalized.length > 0 && normalized.length <= 80;
    });
    if (!title) {return null;}
    const final = title
      .replace(/^[#*>\-+\s]+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^["'`*_]+|["'`*_]+$/g, '')
      .replace(/^(?:title|topic|subject)\s*:\s*/i, '')
      .trim();
    return final || null;
  }

  private ensureActiveConversation(): ConversationRecord {
    return this.conversations.ensureActive();
  }

  private getCurrentConversation(): ConversationRecord | undefined {
    return this.conversations.getCurrent();
  }

  private getSortedConversations(includeArchived = true): ConversationRecord[] {
    return this.conversations.getSorted(includeArchived);
  }

  private normalizeConversationEntry(entry: Partial<ConversationEntry> | undefined): ConversationEntry {
    const role: ConversationRole = entry?.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof entry?.content === 'string' ? entry.content : '';
    const timestamp = typeof entry?.timestamp === 'number' ? entry.timestamp : Date.now();
    const fallbackId = `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const images = Array.isArray(entry?.images) && entry.images.length > 0 ? [...entry.images] : undefined;
    const intent = normalizeIntentInsight(entry?.intent);
    const feedback = normalizeConversationFeedback(entry?.feedback);

    return {
      id: typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : fallbackId,
      role,
      content,
      timestamp,
      images,
      intent,
      feedback
    };
  }

  private normalizeConversationRecord(record: Partial<ConversationRecord> | undefined): ConversationRecord {
    const normalizedMessages = Array.isArray(record?.messages)
      ? record.messages.map((entry) => this.normalizeConversationEntry(entry))
      : [];

    const baseName = record?.name ?? (normalizedMessages.length > 0
      ? deriveConversationNameFromEntries(normalizedMessages, 'New Conversation')
      : 'New Conversation');

    const timestamps = normalizedMessages.map((entry) => entry.timestamp);
    const fallbackCreated = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const fallbackUpdated = timestamps.length > 0 ? Math.max(...timestamps) : fallbackCreated;

    const createdAt = typeof record?.createdAt === 'number' ? record.createdAt : fallbackCreated;
    const updatedAt = typeof record?.updatedAt === 'number' ? record.updatedAt : fallbackUpdated;
    const sanitizedName = normalizedMessages.length > 0
      ? deriveConversationNameFromEntries(normalizedMessages, baseName)
      : sanitizeConversationName(baseName);

    const normalizedPlanRuns = Array.isArray(record?.planRuns)
      ? record.planRuns
          .map((run) => this.normalizePlanRun(run))
          .filter((run): run is ConversationPlanRun => Boolean(run))
      : [];
    const limitedPlanRuns = normalizedPlanRuns.slice(-10);

    return {
      id: typeof record?.id === 'string' && record.id.length > 0 ? record.id : createConversationId(),
      name: sanitizedName,
      messages: normalizedMessages,
      archived: Boolean(record?.archived),
      createdAt,
      updatedAt,
      planRuns: limitedPlanRuns
    };
  }

  private createConversationRecord(name: string, messages?: ConversationEntry[]): ConversationRecord {
    const now = Date.now();
    const normalizedMessages = Array.isArray(messages)
      ? messages.map((entry) => this.normalizeConversationEntry(entry))
      : [];

    const timestamps = normalizedMessages.map((entry) => entry.timestamp);
    const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : now;
    const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : now;

    const record: ConversationRecord = {
      id: createConversationId(),
      name: normalizedMessages.length > 0
        ? deriveConversationNameFromEntries(normalizedMessages, name)
        : sanitizeConversationName(name),
      messages: normalizedMessages,
      archived: false,
      createdAt,
      updatedAt,
      planRuns: []
    };

    return record;
  }

  private normalizePlanRun(raw: unknown): ConversationPlanRun | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const input = raw as Partial<ConversationPlanRun> & Record<string, unknown>;
    const plan = input.plan as Plan | undefined;
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return undefined;
    }
    const clonedPlan = clonePlan(plan);
    const updatesInput = typeof input.updates === 'object' && input.updates !== null
      ? (input.updates as Record<string, unknown>)
      : {};
    const updates: Record<string, ConversationPlanStepState> = {};
    for (const [stepId, value] of Object.entries(updatesInput)) {
      if (typeof stepId !== 'string' || !stepId) {
        continue;
      }
      if (!value || typeof value !== 'object') {
        continue;
      }
      const detail = value as Record<string, unknown>;
      updates[stepId] = {
        state: typeof detail.state === 'string' ? detail.state : undefined,
        summary: typeof detail.summary === 'string' ? detail.summary : undefined,
        durationMs: typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs) ? detail.durationMs : undefined,
        tokens: typeof detail.tokens === 'number' && Number.isFinite(detail.tokens) ? detail.tokens : undefined,
        updatedAt: typeof detail.updatedAt === 'number' && Number.isFinite(detail.updatedAt) ? detail.updatedAt : undefined
      };
    }
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
    const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : createdAt;
    const completedAt = typeof input.completedAt === 'number' && Number.isFinite(input.completedAt) ? input.completedAt : undefined;
    const evaluation = input.evaluation && typeof input.evaluation === 'object'
      ? {
          success: typeof input.evaluation.success === 'boolean' ? input.evaluation.success : undefined,
          confidence: typeof input.evaluation.confidence === 'number' && Number.isFinite(input.evaluation.confidence)
            ? input.evaluation.confidence
            : undefined,
          feedback: typeof input.evaluation.feedback === 'string' ? input.evaluation.feedback : undefined
        }
      : undefined;

    const artifactsPath = typeof input.artifactsPath === 'string' && input.artifactsPath.length > 0
      ? input.artifactsPath
      : undefined;

    return {
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id : createPlanRunId(),
      goal: typeof input.goal === 'string' && input.goal.length > 0 ? input.goal : clonedPlan.goal,
      plan: clonedPlan,
      createdAt,
      updatedAt,
      updates,
      completedAt,
      evaluation,
      artifactsPath
    };
  }

  private async persistConversationHistory(): Promise<void> {
    // Persistence is now handled by ConversationService internally.
    // This method is kept for compatibility with existing call sites.
  }

  private getRecentConversationSummaries(_conversations?: ConversationRecord[]): ConversationSummary[] {
    return this.conversations.getSummaries();
  }

  private hasArchivedConversations(): boolean {
    return this.conversations.hasArchived();
  }


  private getHtml(webview: vscode.Webview): string {
    const packageVersion = typeof this.context.extension?.packageJSON?.version === 'string'
      ? this.context.extension.packageJSON.version
      : 'dev';
    return buildWebviewHtml({
      webview,
      extensionUri: this.context.extensionUri,
      packageVersion
    });
  }

  public dispose(): void {
    this.cancelActiveStream();
    this.agentEnvironmentSubscription?.dispose();
    this._onDidChangeStatus.dispose();
    // Best-effort: close every MCP server child process so we don't
    // leak orphans on extension reload. McpService.dispose is a
    // no-op when the pool was never lazily constructed.
    this.mcp.dispose();
  }

  /** Provider-side delegate preserving the public reload-MCP entry
   *  point for the Connections "Reload" action and any external
   *  callers. The real lifecycle lives on `McpService`. */
  public async reloadMcpFromDisk(workspaceRoot: string): Promise<number> {
    return this.mcp.reloadFromDisk(workspaceRoot);
  }
}
