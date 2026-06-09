/**
 * Top-level type definitions extracted from extension.ts.
 *
 * These types describe the shape of data that flows between the
 * extension host and the webview (WebviewState), the user's account
 * (AccountProfile), the diff preview machinery (AgentDiffPreview /
 * DiffPreviewSession), and the supporting features (intent memory,
 * feedback). All are pure types — no runtime code, no class state —
 * so they're safe to import from anywhere.
 *
 * Why this file exists: extension.ts crossed 9k lines and bandit's
 * own self-evaluations flagged it as monolithic. The interface block
 * (~170 lines) sat at the top of the file but had no behavioral
 * coupling to the rest — easy isolated cut alongside the helper
 * extractions in / .
 */

import type * as vscode from 'vscode';
import type {
  ConversationEntry,
  ConversationPlanStepState,
  SerializedPlanRun,
  ConversationSummary,
  ModeKind,
  IntentInsight as ConvIntentInsight
} from './services/conversationTypes';
import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import type { Plan } from '@burtson-labs/stealth-core-runtime';

export interface AccountProfile {
  valid?: boolean;
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  plan?: string;
  credits?: number;
  gatewayToken?: string;
  keyId?: string;
  maskedKey?: string;
  isAdmin?: boolean;
  isArchived?: boolean;
  roles?: string[];
  expiresAt?: string;
  expiresIn?: number;
}

export type AccountProfileStatus = 'idle' | 'loading' | 'error';

// Re-export for backwards compatibility with extension.ts which was
// using `IntentInsight` as a local alias for the conversationTypes one.
export type IntentInsight = ConvIntentInsight;

export interface IntentMemoryEntry {
  action: string;
  target?: string;
  summary: string;
  confidence?: number;
  lastUsed: number;
}

export interface IntentSuggestion {
  label: string;
  summary: string;
  action: string;
  confidence?: number;
}

export interface AgentDiffPreview {
  path: string;
  diff: string;
  backupPath?: string;
  backupContent?: string;
}

export interface DiffPreviewSession {
  preview: AgentDiffPreview;
  inlineUri?: vscode.Uri;
  workspaceFolder: vscode.Uri;
  diffInput?: {
    original: vscode.Uri;
    modified: vscode.Uri;
  };
}

export interface FeedbackRequest {
  title: string;
  description: string;
  category: 'bug' | 'feature' | 'improvement';
  priority: 'low' | 'medium' | 'high' | 'critical';
  annoyanceLevel?: number;
  sessionInfo?: { conversationId?: string };
}

export interface WebviewState {
  messages: ConversationEntry[];
  hasApiKey: boolean;
  hasStoredApiKey: boolean;
  requiresApiKey: boolean;
  isBusy: boolean;
  presetPrompt?: string;
  statusText?: string;
  provider: ProviderKind;
  model: string;
  ollamaModel: string;
  ollamaUrl: string;
  /** True when a secrets-stored Ollama Bearer token is present. Never
   * send the token value itself — only the boolean state — so the
   * webview can render a "(token saved)" indicator without ever
   * exposing the token in devtools or the renderer process. */
  hasOllamaAuthToken: boolean;
  /** True when a Tavily web-search API key is stored in the global
   * settings under `banditStealth.webSearch.tavilyApiKey`. The key
   * value itself never crosses the postMessage boundary — only the
   * presence flag — so the Settings → Connections panel can render
   * a "Saved" badge without exposing the bytes to the renderer. */
  hasTavilyKey: boolean;
  /** Installed extension version. Surfaced in the settings footer so
   * users can confirm at a glance which build is active — critical
   * when the marketplace hasn't propagated a fresh release yet and
   * bug reports need the actual running version. */
  extensionVersion: string;
  currentConversationId?: string;
  currentConversationName?: string;
  history: ConversationSummary[];
  hasArchivedConversations: boolean;
  showHistory: boolean;
  allowImageUploads: boolean;
  showIntentChips: boolean;
  feedbackEnabled: boolean;
  contextUsage: { used: number; limit: number } | null;
  undoAvailable: boolean;
  mode: ModeKind;
  intentInsight: IntentInsight | null;
  intentSuggestions: IntentSuggestion[];
  plan?: Plan | null;
  planUpdates?: Record<string, ConversationPlanStepState>;
  planUnread?: boolean;
  activeView?: 'conversation' | 'plan';
  activePlanRunId?: string | null;
  planHistory?: SerializedPlanRun[];
  debugEmitPlanJson?: boolean;
  enableToolUse?: boolean;
  accountProfile?: AccountProfile | null;
  accountProfileStatus?: AccountProfileStatus;
  accountProfileError?: string | null;
  developerMode?: boolean;
  skipValidationInDev?: boolean;
  createBranchBeforeRun?: boolean;
  autoApproveEdits?: boolean;
  autoContextEnabled?: boolean;
  ollamaStatus?: 'ready' | 'offline' | 'no-model' | 'unknown';
  ollamaModelMissing?: string;
  /** Voice input (mic button in composer). Gated by provider=bandit +
   * API key present + banditStealth.voice.micEnabled=true. Webview
   * reads this flag to show/hide the mic button. */
  voiceMicEnabled?: boolean;
  /** Raw toggle values for the Voice card in Settings → Account. These
   * are the user's opt-in preferences, NOT the derived gates —
   * `voiceMicEnabled` above bakes in provider + API-key requirements;
   * these are just what the user ticked. Surfaced so the Voice card
   * can show the current state of each switch. */
  voiceAutoSpeakPref?: boolean;
  voiceMicPref?: boolean;
  /** Per-provider voice settings — surfaced in the Voice settings tab
   * so users can switch STT/TTS adapters and configure URLs/keys
   * without hand-editing settings.json. apiKey fields are still in
   * plain workspace settings (not Secrets) because they have to
   * travel with workspace files for self-hosted multi-machine
   * setups; sensitive cloud keys belong on the Bandit cloud
   * provider which uses VS Code Secrets. */
  voiceProviderSettings?: {
    sttProvider: 'bandit' | 'openai-whisper' | 'custom';
    sttUrl: string;
    sttApiKey: string;
    sttModel: string;
    ttsProvider: 'bandit' | 'openai' | 'elevenlabs' | 'piper' | 'custom';
    ttsUrl: string;
    ttsApiKey: string;
    ttsModel: string;
    ttsVoiceId: string;
  };
  /** MCP server snapshot for the Connections settings panel. Built
   * from the session-scoped pool's current state; `command` + `args`
   * are echoed for visibility but `env` values are NEVER pushed
   * through (tokens stay in the host process). */
  mcpSnapshot?: Array<{
    name: string;
    /** Stdio servers only. Empty/undefined when the entry is a URL-based
     *  remote server (v1.7.333+) — see `url` below. The Connections
     *  panel renders one shape or the other based on which is set. */
    command?: string;
    args?: string[];
    /** URL-based remote MCP server (Streamable HTTP). When set, the
     *  Connections card shows the URL + auth method instead of the
     *  spawn command. */
    url?: string;
    /** Short label for the auth strategy on URL servers ("bandit-api-key",
     *  "bearer", "header(X-Foo)", "none"). Undefined for stdio. */
    authKind?: string;
    state: 'idle' | 'connecting' | 'connected' | 'error' | 'disabled';
    toolCount?: number;
    errorMessage?: string;
    /** True when this server's fingerprint is in the persisted trust
     * file (~/.bandit/mcp-trust.json). Drives the Connections panel's
     * "Revoke trust" affordance — only shown for trusted servers. */
    trusted?: boolean;
    /** Activation mode mirrored from the server's config. */
    activation?: 'always' | 'on-mention';
    /** Inferred provider hint (slack / github / gmail / …) for the
     * Connections panel's brand-flavored icon. null when the server
     * name doesn't match any known provider. */
    providerHint?: string | null;
  }>;
}
