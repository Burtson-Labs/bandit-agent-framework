/**
 * Wire-format type definitions for messages exchanged between the
 * extension and the webview.
 *
 * The webview (`media/webview/webview.js`) parses these by `type` discriminant.
 * Adding a new variant requires a matching handler in the message dispatcher
 * and, for OutgoingMessage variants, a render path in the webview.
 *
 * Don't rename existing variants — the webview side ships pre-built and is
 * keyed on these `type` string literals. Add new variants instead.
 */

import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import type { BackgroundTaskRecord, TurnTraceSummary } from '@burtson-labs/host-kit';
import type { ModeKind, FeedbackRating, Plan, SerializedPlanRun } from './services/conversationTypes';
import type { WebviewState } from './agentTypes';

/** One question rendered by the webview ask-user card. Mirrors agent-core's
 *  UserInputQuestion; duplicated here so the webview doesn't import the
 *  agent-core package. */
export interface AskUserQuestionPayload {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  allowFreeform?: boolean;
}

export type IncomingMessage =
  | { type: 'requestState' }
  | { type: 'sendPrompt'; text: string; images?: string[]; files?: string[]; mode?: ModeKind; autoContext?: boolean }
  | { type: 'setApiKey'; value: string }
  | { type: 'signInWithBurtson' }
  | { type: 'mcpReload' }
  | { type: 'mcpReconnect'; name: string }
  | { type: 'mcpDisconnect'; name: string }
  | { type: 'mcpRevokeTrust'; name: string }
  | { type: 'mcpSetActivation'; name: string; activation: 'always' | 'on-mention' }
  | { type: 'mcpAddGitHub' }
  | { type: 'mcpAddSlack' }
  | { type: 'mcpAddGitLab' }
  | { type: 'mcpAddGmail' }
  | { type: 'mcpAddCustom' }
  | { type: 'setOllamaAuthToken'; value: string }
  | { type: 'clearOllamaAuthToken' }
  | { type: 'setTavilyKey'; value: string }
  | { type: 'clearTavilyKey' }
  | { type: 'setOllamaBaseUrl'; value: string }
  | { type: 'clearApiKey' }
  | { type: 'clearConversation' }
  | { type: 'cancelResponse' }
  | { type: 'setProvider'; value: ProviderKind }
  | { type: 'openSettings'; query?: string }
  | { type: 'editModel' }
  | { type: 'editOllamaUrl' }
  | { type: 'startNewConversation' }
  | { type: 'selectConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'archiveConversation'; id: string; archived: boolean }
  | { type: 'showHistory'; value: boolean }
  | { type: 'setMode'; value: ModeKind }
  | { type: 'clearAllConversations' }
  | { type: 'requestClearAll' }
  | { type: 'submitFeedback'; messageId: string; rating: FeedbackRating }
  | { type: 'dismissIntent' }
  | { type: 'dismissIntentSuggestions' }
  | { type: 'updatePreference'; key: string; value: unknown }
  | { type: 'requestContextFiles' }
  | { type: 'searchWorkspaceFiles'; query: string }
  | { type: 'replayPlanStep'; id: string }
  | { type: 'refinePlanStep'; id: string }
  | { type: 'openFileFromDiff'; path: string }
  | { type: 'openContextFile'; path: string }
  | { type: 'diffPreviewAction'; path: string; action: 'apply' | 'explain' | 'discard' }
  | { type: 'undoAgentChange' }
  | { type: 'requestAccountProfile' }
  | { type: 'permissionResponse'; id: string; choice: 'once' | 'session' | 'save' | 'deny'; notes?: string }
  // ask_user: the webview returns the user's answers (question id → answer)
  // or a cancellation when the form is dismissed.
  | { type: 'userInputResponse'; id: string; answers: Record<string, string>; cancelled?: boolean }
  | { type: 'requestSkillList' }
  // Voice: user clicked the speaker icon on an assistant entry to play
  // its response aloud, OR submitted a mic recording for transcription.
  | { type: 'speakMessage'; entryId: string; text: string }
  | { type: 'transcribeAudio'; audioBase64: string; mimeType: string }
  // Extension-side mic capture. Bypasses the webview's getUserMedia
  // entirely so we don't fight Chromium's per-origin permission cache.
  // The recorder lives in the extension process and uses ffmpeg / sox
  // to capture audio directly.
  | { type: 'extensionMicProbe' }
  | { type: 'extensionMicStart' }
  | { type: 'extensionMicStop' }
  | { type: 'extensionMicCancel' }
  // Webview asks the extension to run the platform install command
  // for the missing recorder (e.g. `brew install ffmpeg`). The extension
  // opens an integrated terminal so the user watches it run.
  | { type: 'extensionMicInstallOffer' }
  // Live-tile cancel button. Webview asks the extension to cooperatively
  // stop a running background subagent. The store flips status to
  // 'cancelled' and broadcasts via backgroundTaskUpdate.
  | { type: 'cancelBackgroundTask'; taskId: string }
  | { type: 'dismissBackgroundTask'; taskId: string }
  // Usage modal: webview asks the extension to fetch the latest
  // account/usage snapshot from the gateway. Extension replies with
  // `accountUsage`. Called on modal open and on a 30s poll while the
  // modal is visible.
  | { type: 'requestAccountUsage' }
  // Tool-card click-through: user clicked an IN/OUT run card or a
  // timeline row in the chat and wants to see the full input + full
  // output as a readable document in the main editor pane. The
  // runId maps into `toolCallDetails` on the extension side.
  | { type: 'openToolDetail'; runId: string }
  | { type: 'requestTraceList'; mode?: 'all' | 'failed' }
  | { type: 'requestTraceDetail'; id: string }
  | { type: 'openTraceFile'; path: string }
  // Webview-to-extension keybinding bridge. VS Code's keybinding system
  // does not deliver workbench keybindings to a focused webview, so the
  // composer forwards Alt+Shift chord presses here. Allowlisted to
  // banditStealth.* commands in the handler so the webview can't run
  // arbitrary VS Code commands.
  | { type: 'runVscodeCommand'; command: string }
  | { type: 'runShellCommand'; command: string }
  | { type: 'setConfig'; key: string; value: unknown };

export type OutgoingMessage =
  | { type: 'state'; state: WebviewState }
  | { type: 'error'; message: string }
  | { type: 'requireApiKey' }
  | { type: 'notification'; message: string }
  | { type: 'openSettings' }
  | { type: 'contextFilesAdded'; files: Array<{ path: string; preview?: string }> }
  | { type: 'imageAttachmentsAdded'; images: string[] }
  | { type: 'workspaceFileSuggestions'; entries: Array<{ path: string; isDir: boolean }> }
  | { type: 'agentPlan'; plan?: Plan; history?: SerializedPlanRun[]; activeRunId?: string | null }
  | { type: 'agentPlanUpdate'; stepId: string; status?: string; meta?: { summary?: string; durationMs?: number; tokens?: number }; history?: SerializedPlanRun[]; activeRunId?: string | null }
  | { type: 'agentPlanHistory'; history: SerializedPlanRun[]; activeRunId?: string | null }
  | { type: 'agentTelemetry'; telemetry: { stepId?: string; durationMs?: number; tokens?: number; ok?: boolean } }
  | { type: 'agentDiffStream'; stream: { path?: string; kind?: string; content?: string } }
  | { type: 'agentDiffSnapshot'; snapshot: { path?: string; diff?: string; summary?: { added: number; removed: number }; confidence?: number } }
  | { type: 'diffPreviewCard'; preview: { path: string; hasBackup: boolean } }
  | { type: 'diffPreviewClear' }
  | { type: 'diffPreviewResult'; path: string; status: 'apply' | 'explain' | 'discard' | 'error'; message?: string }
  | {
      type: 'permissionRequest';
      id: string;
      tool: string;
      primary: string;
      description: string;
      bodyPreview?: string;
      risk?: string;
      warning?: string;
      diffStats?: { added: number; removed: number };
      command?: string;
      paramsPreview?: string;
    }
  | { type: 'permissionResolved'; id: string; choice: 'once' | 'session' | 'save' | 'deny'; notes?: string }
  // ask_user: render the interactive question card in the webview.
  | { type: 'userInputRequest'; id: string; questions: AskUserQuestionPayload[] }
  | { type: 'contextInjectionSkipped'; reason?: string; prompt?: string }
  | { type: 'skillList'; skills: Array<{ id: string; name: string; description?: string; source: 'builtin' | 'workspace' }> }
  // Voice playback. Extension fetches audio from the gateway's
  // /api/stealth/tts endpoint and pushes it to the webview as a base64
  // mp3 along with the entry id it belongs to so the UI can highlight
  // the speaker button for that message.
  | { type: 'playAudio'; entryId: string; mimeType: string; audioBase64: string }
  | { type: 'audioError'; entryId: string; message: string }
  // Push transcription from the STT endpoint into the composer when
  // the user records a voice prompt.
  | { type: 'voiceTranscription'; text: string }
  // Extension-side mic capability + status. The webview asks once at
  // mount via extensionMicProbe and sets its mic UI accordingly. If
  // unavailable, the webview falls back to in-browser getUserMedia.
  | { type: 'extensionMicAvailability'; available: boolean; kind?: 'bundled' | 'ffmpeg' | 'sox' | 'arecord'; message: string; canAutoInstall?: boolean; installerName?: string }
  | { type: 'extensionMicError'; message: string }
  // Background subagent live-tile push channel. `backgroundTaskList` is
  // the initial snapshot sent on view-resolve; `backgroundTaskUpdate`
  // fires for every state transition (start, progress, complete,
  // failed, cancelled). The webview reduces both into a single Map
  // keyed by task id.
  | { type: 'backgroundTaskList'; tasks: BackgroundTaskRecord[] }
  | { type: 'backgroundTaskUpdate'; task: BackgroundTaskRecord }
  // Account & Usage response. Emitted when the webview (or /usage CLI
  // command) requests the current usage snapshot. Used to render the
  // Account & Usage modal with session/weekly progress bars.
  | {
      type: 'accountUsage';
      data: {
        authMethod: string;
        email?: string;
        userId?: string;
        plan: string;
        isAdmin: boolean;
        session: { used: number; limit: number; resetsAtUnix: number };
        weekly: { used: number; limit: number; resetsAtUnix: number };
      } | null;
      error?: string;
    }
  // Rate-limit hit. Sent when the cloud completion endpoint returns
  // 429 so the UI can show a friendly "you hit your limit, come back
  // in X" toast with a link to the usage card.
  | {
      type: 'rateLimited';
      window: 'session' | 'weekly' | string;
      resetsAtUnix?: number;
      message: string;
    }
  | TraceOutgoingMessage;

export type TraceListMode = 'all' | 'failed';
export type TraceStatus = TurnTraceSummary['status'];

export interface TraceSummaryPayload {
  id: string;
  filePath: string;
  scope: 'workspace' | 'global' | 'external';
  workspace: string;
  startedAt?: string;
  prompt?: string;
  finalPreview?: string;
  iterations: number;
  hitLimit: boolean;
  toolCalls: number;
  tools: string[];
  blockedTools: number;
  errors: number;
  retries: number;
  nativeFallbacks: number;
  permissionRequests: number;
  permissionDecisions: number;
  permissionDenials: number;
  compactions: number;
  checkpoints: number;
  status: TraceStatus;
}

export interface TraceEventPayload {
  t?: string;
  type: string;
  iteration?: number;
  name?: string;
  detail?: string;
  isError?: boolean;
}

export interface TraceDetailPayload {
  summary: TraceSummaryPayload;
  events: TraceEventPayload[];
  markdown: string;
}

export type TraceOutgoingMessage =
  | { type: 'traceList'; traces: TraceSummaryPayload[]; mode: TraceListMode; selectedId?: string | null }
  | { type: 'traceDetail'; trace: TraceDetailPayload }
  | { type: 'traceError'; message: string };
