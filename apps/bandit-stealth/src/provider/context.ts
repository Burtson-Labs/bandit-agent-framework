/**
 * `ProviderContext` is the narrow contract that extracted services and
 * message handlers depend on, instead of the full
 * `BanditStealthViewProvider` class. The provider implements this
 * interface; every Phase B+ service takes a `ProviderContext` in its
 * constructor and never reaches into the provider directly.
 *
 * The whole point: stop the v1.7.349-era pattern where extracted code
 * either took `this` (recreating the coupling) or accepted 20+
 * parameters (unreadable). With this interface, the boundary is
 * checkable — a TS error appears the moment a service tries to touch
 * provider state that isn't part of the contract.
 *
 * The interface grows phase by phase. Each new service added in
 * `services/` extends this interface with one `readonly` slot for
 * itself. Phase A (this commit) captures only what already exists on
 * the class — no service stubs that don't ship yet, and no behavior
 * change. See `docs/provider-class-decomposition-plan.md` for the full
 * extraction roadmap and which services are expected to land in each
 * phase.
 *
 * Rules:
 * 1. Only readonly accessors for state — services own their own
 *    mutations.
 * 2. Never expose `this` (the whole provider); every method on this
 *    interface is small and well-typed.
 * 3. Extracted modules import this interface, not the provider class.
 * 4. If an extraction wants something not on this interface, that's a
 *    signal to expand the interface — but only if the state is truly
 *    cross-cutting. Otherwise the boundary is wrong.
 */
import type * as vscode from 'vscode';
import type { McpClientPool } from '@burtson-labs/agent-core';
import type { BackgroundTaskStore, SessionPermissionStore } from '@burtson-labs/host-kit';
import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import type { ConversationService } from '../services/conversationService';
import type { IUndoManager } from '../agent/agentRuntime';
import type { OutgoingMessage } from '../messages';
import type { DiffContentProvider } from '../diffContentProvider';
import type { SlowStateCache } from './slowStateCache';
import type { AccountService } from './services/accountService';
import type { BackgroundTaskCoordinator } from './services/backgroundTaskCoordinator';
import type { DiffPreviewService } from './services/diffPreviewService';
import type { IntentService } from './services/intentService';
import type { McpService } from './services/mcpService';
import type { PermissionGateService } from './services/permissionGateService';
import type { MultiQuestionGateService } from './services/multiQuestionGateService';
import type { ToolCallDetailService } from './services/toolCallDetailService';
import type { VoiceService } from './services/voiceService';

export interface ProviderContext {
  // ── VS Code surface ────────────────────────────────────────────────
  readonly extensionContext: vscode.ExtensionContext;
  readonly view: vscode.WebviewView | undefined;
  readonly diffContentProvider: DiffContentProvider;
  postMessage(message: OutgoingMessage): void;

  // ── State control ──────────────────────────────────────────────────
  syncState(): Promise<void>;
  setBusy(busy: boolean, message?: string): Promise<void>;
  setStatusMessage(message: string): Promise<void>;
  setPendingPrompt(prompt: string): Promise<void>;
  notifyUser(kind: 'approval' | 'complete' | 'error' | 'background', title: string, message: string, durationMs?: number): void;
  invalidateSlowStateCache(): void;

  // ── Composed services ──────────────────────────────────────────────
  readonly conversations: ConversationService;
  readonly permissions: SessionPermissionStore;
  readonly background: BackgroundTaskStore;
  readonly mcpPool: McpClientPool;
  readonly undo: IUndoManager;
  readonly slowStateCache: SlowStateCache;
  readonly toolCallDetails: ToolCallDetailService;
  readonly permissionGate: PermissionGateService;
  readonly multiQuestionGate: MultiQuestionGateService;
  readonly backgroundTasks: BackgroundTaskCoordinator;
  readonly account: AccountService;
  readonly intent: IntentService;
  readonly diffPreviews: DiffPreviewService;
  readonly voice: VoiceService;
  readonly mcp: McpService;

  // ── Read-only derived state ────────────────────────────────────────
  getProviderKind(configuration: vscode.WorkspaceConfiguration): ProviderKind;
  describeProvider(kind: ProviderKind): string;
}
