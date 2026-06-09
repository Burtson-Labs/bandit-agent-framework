import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  AgentEvent,
  AgentPlan,
  Goal as AgentGoal,
  Task as AgentTask
} from "@burtson-labs/agent-core";
import type { ComposerSkillOption } from "@burtson-labs/agent-ui";
import { AskUserForm } from "./AskUserForm";
import { type UsageSnapshot } from "./components/AccountUsageModal";
import { ApiKeyBanner } from "./components/ApiKeyBanner";
import { BackgroundTaskTile } from "./components/BackgroundTaskTile";
import { ChatFeedLanding } from "./components/ChatFeedLanding";
import { CompletedChangesPanel } from "./components/CompletedChangesPanel";
import { Composer } from "./components/Composer";
import { FilesChangedSummaryCard } from "./components/FilesChangedSummaryCard";
import { HistoryPanel } from "./components/HistoryPanel";
import { LiveStepMessage } from "./components/LiveStepMessage";
import { OverlayLayer } from "./components/OverlayLayer";
import { PlanEvaluationCard } from "./components/PlanEvaluationCard";
import {
  type McpServerEntry,
  type SettingsTab,
  type VoiceProviderSettings,
  SettingsPanel
} from "./components/SettingsPanel";
import { TaskSummaryCard } from "./components/TaskSummaryCard";
import { TopBar } from "./components/TopBar";
import { TraceLogPanel } from "./components/TraceLogPanel";
import { applyAccountSnapshot } from "./state/applyAccountSnapshot";
import { applyHistorySnapshot } from "./state/applyHistorySnapshot";
import { applyMcpSnapshot } from "./state/applyMcpSnapshot";
import { applyPreferencesSnapshot } from "./state/applyPreferencesSnapshot";
import { applyViewSnapshot } from "./state/applyViewSnapshot";
import { applyVoiceSnapshot } from "./state/applyVoiceSnapshot";
import { buildAgentSummaryEntries } from "./state/agentSummary";
import { readBootConfig } from "./state/bootConfig";
import { buildCandidatePriorities, sortEntriesByCandidates } from "./state/diffPriority";
import {
  type CompletedChangeEntry
} from "./state/diffStorage";
import {
  diffKeyFor,
  diffOpenState,
  reasoningOpenState,
  subagentKeyFor,
  subagentOpenState,
  subagentScrollState
} from "./state/keyHelpers";
import {
  type LiveUpdateEntry,
  LIVE_UPDATE_INTERVAL_MS,
  extractLiveUpdates
} from "./state/liveUpdates";
import {
  findActivePlanRun,
  mapPlanUpdateStateToTaskStatus,
  readTaskMetadataString
} from "./state/planSync";
import { buildTelemetryMetadata } from "./state/telemetry";
import { useApprovalQueue } from "./hooks/useApprovalQueue";
import { useAskUserRequest } from "./hooks/useAskUserRequest";
import { useAudioPlayback } from "./hooks/useAudioPlayback";
import { useBackgroundTaskPolling } from "./hooks/useBackgroundTaskPolling";
import { useConversationState } from "./hooks/useConversationState";
import { dispatchAccountMessage } from "./messageDispatch/accountMessages";
import { dispatchAudioMessage } from "./messageDispatch/audioMessages";
import { dispatchBackgroundTaskMessage } from "./messageDispatch/backgroundTaskMessages";
import { dispatchComposerAttachmentMessage } from "./messageDispatch/composerAttachmentMessages";
import { dispatchCoreLifecycleMessage } from "./messageDispatch/coreLifecycle";
import { dispatchDiffMessage } from "./messageDispatch/diffMessages";
import { dispatchPermissionMessage } from "./messageDispatch/permissionMessages";
import { dispatchPlanMessage } from "./messageDispatch/planMessages";
import { dispatchTraceMessage } from "./messageDispatch/traceMessages";
import { dispatchVoiceMessage } from "./messageDispatch/voiceMessages";
import { dispatchWorkspaceMessage } from "./messageDispatch/workspaceMessages";
import { useLiveDiffEntries } from "./hooks/useLiveDiffEntries";
import { useMentionPicker } from "./hooks/useMentionPicker";
import { useMicrophoneRecording } from "./hooks/useMicrophoneRecording";
import { buildPlan, usePlanStateSync } from "./hooks/usePlanStateSync";
import { useProviderSettings } from "./hooks/useProviderSettings";
import { useToast } from "./hooks/useToast";
import { useTracePanel } from "./hooks/useTracePanel";
import { stripTurnTokens } from "./util/stripTurnTokens";
import type { WebviewMessage } from "./types/webviewMessage";
import {
  AgentConsole,
  ChatConversation,
  PermissionCard,
  TaskList,
  PlanActivity,
  PlanTree,
  TelemetryPanel,
  useTelemetry,
  useBanditTheme,
  type ThemePreference
} from "@burtson-labs/agent-ui";
import clsx from "clsx";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import type {
  AccountProfile,
  AccountProfileStatus,
  ConversationSummary,
  WebviewState
} from "./types/webview";


interface ContextFileAttachment {
  path: string;
  preview?: string;
}

const CONTEXT_FILE_LIMIT = 5;
const MAX_IMAGE_ATTACHMENTS = 4;
const CHAT_RENDER_WINDOW_SIZE = 80;

const createTelemetryEvent = (
  telemetry: { stepId?: string; durationMs?: number; tokens?: number; ok?: boolean },
  context?: { provider?: string; model?: string },
  metadata?: Record<string, unknown>
): AgentEvent => ({
  type: "telemetry",
  timestamp: Date.now(),
  payload: {
    tokens: {
      total: telemetry.tokens ?? 0,
      input: telemetry.tokens ?? 0,
      output: 0
    },
    latencyMs: telemetry.durationMs,
    provider: context?.provider,
    model: context?.model,
    metadata
  }
});

const createDiffSnapshotEvent = (
  snapshot: {
    path?: string;
    diff?: string;
    summary?: { added: number; removed: number };
    confidence?: number;
    stepId?: string;
  },
  runId?: string | null
): AgentEvent => ({
  type: "diff:snapshot",
  timestamp: Date.now(),
  payload: {
    ...snapshot,
    runId
  }
});

const fallbackLogoSrc = new URL("../../media/logo.png", import.meta.url).href;

const requestAccountProfile = (): void => {
  vscode.postMessage({ type: "requestAccountProfile" });
};

const requestAccountUsage = (): void => {
  vscode.postMessage({ type: "requestAccountUsage" });
};

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read file."));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file."));
    reader.readAsDataURL(file);
  });

/**
 * Slash commands surfaced in the composer's autocomplete popover. The list is
 * purely UI — when the user submits a line starting with `/`, the extension's
 * message handler routes it to the matching action. Keep this in sync with
 * any command routing added server-side.
 */
const EXTENSION_SLASH_COMMANDS = [
  { name: "help", description: "Show available slash commands" },
  { name: "clear", description: "Clear the current conversation" },
  { name: "compact", description: "Compact older tool results to fit the model context window" },
  { name: "rewind", description: "List checkpoints or restore a file edit (/rewind last)" },
  { name: "skills", description: "List active skills" },
  { name: "memory", description: "Show loaded BANDIT.md / CLAUDE.md" },
  { name: "plan", description: "Ask the agent to produce a plan before acting" },
  { name: "trace", description: "Open the trace log browser" },
  { name: "insights", description: "Regenerate ~/.bandit/insights.html and open it in your browser" }
];

export function App(): JSX.Element {
  const {
    theme: banditTheme,
    appearance: themeAppearance,
    preference: themePreference,
    setPreference: setThemePreference,
    options: themeOptions,
    ideTheme,
    manualTheme
  } = useBanditTheme();
  const {
    conversationEntries,
    messages,
    showFullConversation,
    composerValue,
    mode,
    busy,
    currentConversationId,
    setComposerValue,
    appendToComposer,
    setShowFullConversation,
    applyConversationStateSnapshot
  } = useConversationState();
  const [requireKey, setRequireKey] = useState(false);
  // useProviderSettings owns providerKind, providerLabel, model names,
  // Ollama base-url/auth drafts, ollamaStatus, ollamaModelMissing +
  // all of their handlers + an applyStateSnapshot for the boot/state
  // message. Destructured below.
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const eventsRef = useRef<AgentEvent[]>([]);
  const planEventCountRef = useRef(0);
  // appendEvents is declared early so usePlanStateSync (which owns the
  // plan + ref shadows referenced by liveUpdates below) can be wired
  // before the consumer useMemos run.
  const appendEvents = useCallback((incoming: AgentEvent | AgentEvent[]) => {
    const nextBatch = Array.isArray(incoming) ? incoming : [incoming];
    eventsRef.current = [...eventsRef.current, ...nextBatch].slice(-500);
    setEvents(eventsRef.current);
  }, []);
  const {
    plan,
    rawPlan,
    planUpdates,
    planHistory,
    activePlanRunId,
    selectedStepId,
    setSelectedStepId,
    planRef,
    activePlanRunIdRef,
    applyStateSnapshot,
    handleAgentPlan,
    handleAgentPlanUpdate,
    handleAgentPlanHistory
  } = usePlanStateSync({ appendEvents });
  const [historicalExpanded, setHistoricalExpanded] = useState(false);
  const codeCopyResetTimers = useRef<Map<HTMLButtonElement, number>>(new Map());
  const lastBusyRef = useRef<boolean>(false);
  const providerContextRef = useRef<{ provider: string; model: string }>({
    provider: "Ollama",
    model: "gemma4:12b"
  });
  const {
    toast,
    updateToast,
    cancelToastDismiss,
    scheduleToastDismiss,
    dismissToast
  } = useToast();
  const bootConfig = useMemo(readBootConfig, []);
  const heroLogoSrc = bootConfig.logoSrc ?? fallbackLogoSrc;
  const [contextFiles, setContextFiles] = useState<ContextFileAttachment[]>([]);
  // File suggestions for @-mention autocomplete in the composer. Populated
  // by the extension's workspaceFileSuggestions message in response to
  // each onFileMentionQuery fired from the composer.
  const {
    mentionSuggestions,
    handleFileMentionQuery,
    handleWorkspaceFileSuggestions
  } = useMentionPicker();
  const {
    speakingEntryId,
    audioPaused,
    handlePlayAudio,
    handleAudioError,
    pauseSpeak,
    resumeSpeak,
    stopSpeak,
    startSpeak
  } = useAudioPlayback({ onToast: updateToast });
  // Approval queue. Permission requests arrive as push notifications from
  // the extension; we stack them here and render ONLY the head above the
  // composer. Rather than inline-in-transcript cards (which flood the
  // chat history and cause screen jitter as cards resolve and vanish),
  // one card shows in a fixed position. User clicks → we dequeue and
  // the next request slides into the exact same spot — same mouse
  // position, no scroll movement. that a multi-
  // edit turn stacks 5 cards in the transcript and shoves the assistant
  // reply off-screen.
  const { approvalQueue, enqueueApproval, resolveApproval, handleApprovalChoice } = useApprovalQueue();
  const { askUserRequest, requestAskUser, handleAskUserSubmit } = useAskUserRequest();
  // Webview→workbench keybinding bridge. VS Code's keybinding system
  // does NOT deliver workbench keybindings to a focused webview, so
  // Alt+Shift+B (and the rest of the Bandit chord set) silently no-op
  // when the chat composer has focus. We listen for those chords at
  // the document level and post them back to the extension as a
  // `runVscodeCommand` message; the extension allowlists banditStealth.*
  // and runs the command. preventDefault stops the event from bubbling
  // up to VS Code's default chord handlers (which would otherwise
  // clobber the composer's focus by routing to the workbench).
  useEffect(() => {
    const chord: Record<string, string> = {
      b: "banditStealth.askBandit",
      m: "banditStealth.switchModel",
      t: "banditStealth.toggleMode",
      g: "banditStealth.agent.startGoal",
      c: "banditStealth.agent.cancel"
    };
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey) {return;}
      if (event.ctrlKey || event.metaKey) {return;}
      const key = event.key.toLowerCase();
      const cmd = chord[key];
      if (!cmd) {return;}
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: "runVscodeCommand", command: cmd });
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  const {
    micRecording,
    handleVoiceTranscription,
    handleExtensionMicAvailability,
    handleExtensionMicError,
    handleMicStart,
    handleMicStop
  } = useMicrophoneRecording({
    onToast: updateToast,
    onTranscript: appendToComposer
  });
  const {
    tasks: backgroundTasks,
    panelOpen: backgroundPanelOpen,
    togglePanelOpen: toggleBackgroundPanel,
    cancelTask: cancelBackgroundTask,
    dismissTask: dismissBackgroundTask,
    setBackgroundTasksList,
    applyBackgroundTaskUpdate
  } = useBackgroundTaskPolling();
  const [imageAttachments, setImageAttachments] = useState<string[]>([]);
  const [autoContextEnabled, setAutoContextEnabled] = useState(false);
  const [autoApproveEdits, setAutoApproveEdits] = useState(false);
  const [voiceMicEnabled, setVoiceMicEnabled] = useState(false);
  const [voiceAutoSpeakPref, setVoiceAutoSpeakPref] = useState(false);
  const [voiceMicPref, setVoiceMicPref] = useState(false);
  const [voiceProviderSettings, setVoiceProviderSettings] = useState<VoiceProviderSettings>({
    sttProvider: "bandit",
    sttUrl: "",
    sttApiKey: "",
    sttModel: "whisper-1",
    ttsProvider: "bandit",
    ttsUrl: "",
    ttsApiKey: "",
    ttsModel: "tts-1",
    ttsVoiceId: "en_US-brian-premium"
  });
  // Snapshot of every configured MCP server pushed by the extension
  // on each syncState. Drives the Settings → Connections panel; empty
  // until the user creates a mcp-servers.json file.
  const [mcpSnapshot, setMcpSnapshot] = useState<McpServerEntry[]>([]);
  // Gate the per-message Listen button on whether the user actually has
  // a Bandit cloud API key configured. Without one the speak request
  // would 401 and we'd surface a useless error toast — better to hide
  // the button. Provider doesn't matter (cloud TTS works for users on
  // any inference backend as long as they have the cloud key).
  const [hasApiKey, setHasApiKey] = useState(false);
  const skillListPromiseRef = useRef<{
    promise: Promise<ComposerSkillOption[]>;
    resolve: (value: ComposerSkillOption[]) => void;
  } | null>(null);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const {
    tracePanelOpen,
    traceViewMode,
    traceList,
    traceDetail,
    traceLoading,
    traceError,
    setTracePanelOpen,
    setTraceViewMode,
    setTraceList,
    setTraceLoading,
    setTraceError,
    setTraceDetail,
    requestTraceList,
    requestTraceDetail,
    handleOpenTracePanel,
    handleTraceModeChange,
    handleTraceRefresh
  } = useTracePanel({
    // Closing the history drawer + flipping activePage to "workspace"
    // is App-owned because those two state slots live elsewhere in
    // the orchestrator. The hook fires this when the user opens the
    // trace panel from the toolbar.
    onOpen: () => {
      setShowHistory(false);
      setActivePage("workspace");
      vscode.postMessage({ type: "showHistory", value: false });
    }
  });
  const [currentConversationName, setCurrentConversationName] = useState("New Conversation");
  const [hasArchivedConversations, setHasArchivedConversations] = useState(false);
  const [activePage, setActivePage] = useState<"workspace" | "settings">("workspace");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("account");
  const {
    providerKind,
    banditModelName,
    ollamaModelName,
    modelLabel,
    ollamaBaseUrlDraft,
    ollamaAuthDraft,
    hasOllamaAuthToken,
    ollamaStatus,
    ollamaModelMissing,
    setOllamaBaseUrlDraft,
    setOllamaAuthDraft,
    handleSelectProvider,
    handleEditModel,
    handleEditOllamaUrl,
    handleSaveOllamaBaseUrl,
    handleResetOllamaBaseUrl,
    handleSaveOllamaAuth,
    handleClearOllamaAuth,
    applyStateSnapshot: applyProviderStateSnapshot
  } = useProviderSettings();
  // If the provider flips to ollama while we're on the (now-hidden)
  // Account tab, snap to Providers so the user isn't staring at an
  // empty area. Fires only when the mismatch actually occurs; doesn't
  // fight the user's tab selection otherwise.
  useEffect(() => {
    if (activeSettingsTab === "account" && providerKind !== "bandit") {
      setActiveSettingsTab("providers");
    }
  }, [activeSettingsTab, providerKind]);
  const [activeView, setActiveView] = useState<"conversation" | "plan">("conversation");
  const [planUnread, setPlanUnread] = useState(false);
  const [planArtifactsEnabled, setPlanArtifactsEnabled] = useState(true);
  // Feedback prompt (thumbs up/down after each response) defaults OFF —
  // the toggle was removed from Settings in Apr 2026 as unused noise.
  // State is retained so the extension can still hydrate a user-set
  // value from persisted preferences, but the UI no longer exposes a
  // way to flip it back on from inside the webview.
  const [feedbackPromptEnabled, setFeedbackPromptEnabled] = useState(false);
  const [toolUseEnabled, setToolUseEnabled] = useState(true);
  const [createBranchBeforeRun, setCreateBranchBeforeRun] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [skipValidationInDev, setSkipValidationInDev] = useState(false);
  const [canUndoAgentChange, setCanUndoAgentChange] = useState(false);
  const {
    liveDiffEntries,
    persistedDiffEntries,
    handleDiffSnapshot,
    handleDiffPreviewCard,
    handleDiffPreviewResult,
    handleDiffPreviewClear,
    handleDiffPreviewAction,
    handleUndoAgentChanges: handleUndoAgentChangesBase,
    clearLiveDiffEntries
  } = useLiveDiffEntries({ conversationId: currentConversationId, canUndoAgentChange });
  const [taskPanelExpanded, setTaskPanelExpanded] = useState(false);
  const [changesExpanded, setChangesExpanded] = useState(false);
  // Wraps the hook's undo with App-owned collapse of the changes panel
  // (the panel-expanded state lives on App, not on the diff hook).
  const handleUndoAgentChanges = useCallback(() => {
    handleUndoAgentChangesBase();
    setChangesExpanded(false);
  }, [handleUndoAgentChangesBase]);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const chatFeedRef = useRef<HTMLDivElement>(null);
  // Flag set immediately before we programmatically jump to bottom so the
  // scroll handler below knows to ignore the resulting scroll event. Without
  // this, a user who scrolls up during streaming sees the view yank back
  // down because the auto-scroll's own scroll event re-sets isAutoScroll.
  const programmaticScrollRef = useRef(false);
  // Last observed scrollTop. Used for direction-aware auto-scroll: any
  // upward user scroll disables auto-stick to bottom regardless of how
  // close the user is to the bottom edge. The previous "within 10px of
  // bottom" check would re-enable auto-scroll on its own during streaming
  // because long markdown answers keep growing scrollHeight under the
  // user's cursor; the new code only re-enables when the user themselves
  // scrolls back into the bottom band.
  const lastScrollTopRef = useRef(0);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  // Ollama endpoint + auth state. The token itself is never sent to the
  // webview — only the presence boolean — so we store just a draft for
  // the input field and a "token saved?" flag from the extension state.
  // Tavily web-search BYOK. Same shape as the Ollama auth token: the
  // key itself never leaves the extension host, only a "is one stored?"
  // flag rides on the webview state. The draft holds whatever the user
  // is currently typing into the Settings → Connections card.
  const [hasTavilyKey, setHasTavilyKey] = useState(false);
  const [tavilyKeyDraft, setTavilyKeyDraft] = useState("");
  // Extension version from WebviewState. Surfaced in settings footer so
  // users can confirm which build is running when marketplace propagation
  // is slow and the "you're on " question comes up.
  const [extensionVersion, setExtensionVersion] = useState("");
  const [maskStoredKey, setMaskStoredKey] = useState(false);
  const [accountProfile, setAccountProfile] = useState<AccountProfile | null>(null);
  const [accountProfileStatus, setAccountProfileStatus] = useState<AccountProfileStatus>("idle");
  const [accountProfileError, setAccountProfileError] = useState<string | null>(null);
  // Account & Usage modal state — session (5hr) + weekly (7d) rolling
  // counters from GET /api/stealth/account/usage. Modal is opt-in: we
  // only fetch when the user opens it or hits a 429, so idle sessions
  // don't hammer the gateway.
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
  const [usageStatus, setUsageStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const [rateLimitToast, setRateLimitToast] = useState<{
    window: string;
    resetsAtUnix?: number;
    message: string;
  } | null>(null);
  const [goalFileHints, setGoalFileHints] = useState<{ files: string[]; intent?: string } | null>(null);
  const [diffStreamStatus, setDiffStreamStatus] = useState<{ path: string; chars: number } | null>(null);

  const themeStatusLabel = useMemo(() => {
    if (themePreference === "auto") {
      if (ideTheme) {
        return `Syncing with VS Code (${ideTheme.label}).`;
      }
      const fallback =
        themeOptions.find((option) => option.id === manualTheme)?.label ?? banditTheme.label;
      return `Waiting for VS Code theme. Showing ${fallback}.`;
    }
    return `Using ${banditTheme.label}.`;
  }, [banditTheme.label, ideTheme, manualTheme, themeOptions, themePreference]);
  const isVscodeTheme = banditTheme.id.startsWith("vscode-");

  useEffect(() => {
    requestAccountProfile();
  }, [requestAccountProfile]);

  const telemetry = useTelemetry(events);
  const goalFileCandidates =
    goalFileHints?.files && goalFileHints.files.length > 0
      ? goalFileHints.files
      : telemetry.goalInsight?.files ?? [];
  const candidatePriorities = useMemo(
    () => buildCandidatePriorities(goalFileCandidates),
    [goalFileCandidates]
  );
  const liveUpdates = useMemo(() => extractLiveUpdates(events, plan), [events, plan]);
  const [displayedLiveUpdates, setDisplayedLiveUpdates] = useState<LiveUpdateEntry[]>([]);
  const [liveQueue, setLiveQueue] = useState<LiveUpdateEntry[]>([]);
  const markdown = useMemo(() => {
    const instance = new MarkdownIt({
      linkify: true,
      breaks: true
    });
    const { escapeHtml } = instance.utils;
    // Custom fence renderer:
    // - Diffs become a Claude-style <details> card with +N/−N summary,
    // hljs-tokenized body (so our `.hljs-addition` / `.hljs-deletion`
    // CSS actually gets applied), and open-by-default when short.
    // - Other languages get hljs-highlighted inside the standard
    // code-block wrapper so keywords / strings / comments have color
    // instead of plain escaped text.
    instance.renderer.rules.fence = (tokens, index) => {
      const token = tokens[index];
      const fullInfo = (token.info || "").trim();
      const info = fullInfo.split(/\s+/)[0] ?? "";
      const normalized = info.toLowerCase();
      const raw = token.content || "";
      // Subagent card — the extension emits `bandit-subagent` when a
      // task tool completes. Shows the goal, the subagent's tool trace
      // (collapsible), and the final synopsis. One card per
      // subagent; nested runs are not allowed by design.
      if (normalized === "bandit-subagent") {
        try {
          const data = JSON.parse(raw) as {
            goal?: string;
            result?: string;
            iterations?: number;
            hitLimit?: boolean;
            tools?: Array<{ name: string; primary: string; isError?: boolean }>;
            isError?: boolean;
          };
          const rawGoal = data.goal ?? "";
          const goal = escapeHtml(rawGoal);
          const result = escapeHtml(data.result ?? "");
          const tools = data.tools ?? [];
          const toolsHtml = tools
            .map((t) => {
              const name = escapeHtml(t.name);
              const primary = escapeHtml(t.primary);
              const cls = t.isError ? "bandit-subagent-card__tool--error" : "";
              return `<li class="bandit-subagent-card__tool ${cls}"><span class="bandit-subagent-card__tool-name">${name}</span>${primary ? ` <span class="bandit-subagent-card__tool-primary">${primary}</span>` : ""}</li>`;
            })
            .join("");
          const limitNote = data.hitLimit
            ? `<span class="bandit-subagent-card__warn">hit iteration limit</span>`
            : "";
          const statusCls = data.isError ? "bandit-subagent-card--error" : "";
          // Restore prior user-toggled state if any. See `subagentOpenState`
          // comment near the top of the file: dangerouslySetInnerHTML wipes
          // the DOM on each chunk, so an opened card collapses on re-render
          // without this lookup.
          const subagentKey = subagentKeyFor(rawGoal);
          const isOpen = subagentOpenState.get(subagentKey) === true;
          return (
            `<details class="bandit-subagent-card ${statusCls}" data-subagent-key="${subagentKey}"${isOpen ? " open" : ""}>` +
              `<summary class="bandit-subagent-card__summary">` +
                `<span class="bandit-subagent-card__icon">◉</span>` +
                `<span class="bandit-subagent-card__label">Subagent</span>` +
                `<span class="bandit-subagent-card__goal">${goal}</span>` +
                `<span class="bandit-subagent-card__stats">${data.iterations ?? 0} iter · ${tools.length} tool${tools.length === 1 ? "" : "s"}${limitNote ? " · " + limitNote : ""}</span>` +
              `</summary>` +
              (tools.length > 0
                ? `<ol class="bandit-subagent-card__trace">${toolsHtml}</ol>`
                : "") +
              (result
                ? `<div class="bandit-subagent-card__result"><div class="bandit-subagent-card__result-label">Synopsis</div><pre><code>${result}</code></pre></div>`
                : "") +
            `</details>`
          );
        } catch {
          // Malformed — fall through to default rendering.
        }
      }
      // Chain-of-thought reasoning block — extension emits one
      // `bandit-reasoning` fence per chunk from models with thinking
      // mode on (Qwen 3.x, DeepSeek R1). Rendered as <details open>
      // so the reasoning is visible by default — the user asked to
      // be able to read it while the agent is still working
      // (2026-04-30). Previously rendered as <details> (closed) and
      // any user expand was lost on the next stream chunk because
      // React re-renders the dangerouslySetInnerHTML each time, which
      // wipes the user's toggle state. Defaulting to `open` so the
      // user sees reasoning stream live; they can still click the
      // disclosure triangle to collapse, and once streaming stops
      // re-rendering the DOM stays put.
      if (normalized === "bandit-reasoning") {
        // Strip host-formatted log fences that small models hallucinate
        // INTO their reasoning channel. The existing fake-tool-log
        // detector covers the response text, but Gemma / Qwen also
        // emit `bandit-tl` / `bandit-run` / `bandit-subagent` JSON
        // cards inside <think> output (they've seen them in training
        // conversations and treat them as part of the assistant
        // voice). Those cards are host artifacts — the model has no
        // business emitting them — so rendering them inside the
        // reasoning disclosure just confuses the user with raw JSON.
        //
        // Trace 2026-05-26: reasoning block showed `Let m` then a
        // literal ```bandit-tl {"id":"check_task-mplyk9vc-...","glyph":"→",...}```
        // ahead of the properly-rendered check_task tool row, so
        // the same action appeared twice.
        const text = raw
          .replace(/```bandit-(?:tl|run|subagent)\b[\s\S]*?```/gi, '')
          .replace(/```bandit-(?:tl|run|subagent)\b[\s\S]*$/i, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!text) {return '';}
        // Suppress obviously-mid-stream reasoning chunks. When the model is
        // streaming a fenced reasoning block, the markdown renderer re-runs
        // on every chunk; if the chunk arrives mid-word and the parser
        // auto-closes the unfinished ```bandit-reasoning fence, the user
        // sees a "(1 line)" disclosure with "I need to r" body before
        // "ead the file" arrives in the next chunk. Captured 2026-06-03
        // (captured in a real IDE session). Treat single-line content
        // under 40 chars that doesn't end with punctuation or whitespace
        // as a streaming artifact and wait for the next render pass.
        const looksMidStream =
          !text.includes('\n') &&
          text.length < 40 &&
          !/[.!?,;:\s…]$/.test(text);
        if (looksMidStream) {return '';}
        const lineCount = text.split("\n").filter(l => l.trim().length > 0).length;
        const summary = `reasoning (${lineCount} line${lineCount === 1 ? "" : "s"})`;
        // Stable key + persisted toggle. Default open so the user sees
        // chain-of-thought live; once they collapse it, subsequent
        // chunks of the SAME fence don't pop it back open.
        const reasoningKeyBody = text.slice(0, 256);
        let rh = 5381;
        for (let i = 0; i < reasoningKeyBody.length; i++) {
          rh = ((rh << 5) + rh + reasoningKeyBody.charCodeAt(i)) | 0;
        }
        const reasoningKey = `r-${reasoningKeyBody.length}-${(rh >>> 0).toString(36)}`;
        const userToggle = reasoningOpenState.get(reasoningKey);
        const isOpen = userToggle === undefined ? true : userToggle;
        return (
          `<details class="bandit-reasoning" data-reasoning-key="${escapeHtml(reasoningKey)}"${isOpen ? " open" : ""}>` +
            `<summary>${escapeHtml(summary)}</summary>` +
            `<pre class="bandit-reasoning__body">${escapeHtml(text)}</pre>` +
          `</details>`
        );
      }

      // Tool-call timeline row — extension emits one `bandit-tl` fence per
      // tool_execute with { glyph, name, primary, status, skill }. CSS on
      // consecutive rows paints a continuous vertical rail with a dot per
      // row (running = accent, repeat = dashed ghost, done/error swap the
      // dot color via data-status). Replaces the old italic `_→ tool path_`
      // lines that rendered as a flat wall with no visual hierarchy.
      if (normalized === "bandit-tl") {
        try {
          const data = JSON.parse(raw) as {
            id?: string;
            glyph?: string;
            name?: string;
            primary?: string | null;
            status?: "running" | "repeat" | "done" | "error";
            skill?: string | null;
            durationMs?: number;
          };
          const status = data.status ?? "running";
          const name = escapeHtml(data.name ?? "");
          const primary = data.primary ? escapeHtml(data.primary) : "";
          const durationLabel = typeof data.durationMs === "number" && data.durationMs > 0
            ? (data.durationMs >= 1000
              ? `${(data.durationMs / 1000).toFixed(1)}s`
              : `${data.durationMs}ms`)
            : "";
          const tlRunId = typeof data.id === "string" ? escapeHtml(data.id) : "";
          const tlClickable = tlRunId && (status === "done" || status === "error");
          return (
            `<div class="bandit-tl-row${tlClickable ? " bandit-tl-row--clickable" : ""}" data-status="${status}"${tlClickable ? ` data-run-id="${tlRunId}" role="button" tabindex="0" title="Open full input/output in editor"` : ""}>` +
              `<span class="bandit-tl-name">${name}</span>` +
              (primary ? `<span class="bandit-tl-arg">${primary}</span>` : "") +
              (status === "repeat" ? `<span class="bandit-tl-tag">already run</span>` : "") +
              (durationLabel ? `<span class="bandit-tl-dur">${durationLabel}</span>` : "") +
              (tlClickable ? `<span class="bandit-tl-open" aria-hidden="true">↗</span>` : "") +
            `</div>`
          );
        } catch {
          // Malformed — fall through to default rendering.
        }
      }
      // Bash IN/OUT card — extension emits `bandit-run` fences with a JSON
      // payload { cmd, out, isError, truncated, totalLen } on every
      // run_command completion. Renders as a compact card with an IN
      // row (highlighted as bash) and an OUT row (plain text, scrollable
      // when long). Claude-Code-style — dramatically more readable than
      // the old italic `→ run_command ...` line that left users
      // guessing whether anything actually ran.
      if (normalized === "bandit-run") {
        try {
          const data = JSON.parse(raw) as {
            runId?: string | null;
            cmd?: string;
            out?: string;
            isError?: boolean;
            truncated?: boolean;
            totalLen?: number;
          };
          const cmd = escapeHtml(data.cmd ?? "");
          let outBody: string;
          try {
            outBody = hljs.getLanguage("bash")
              ? hljs.highlight(data.out ?? "", { language: "bash" }).value
              : escapeHtml(data.out ?? "");
          } catch {
            outBody = escapeHtml(data.out ?? "");
          }
          const tail = data.truncated
            ? `\n<span class="bandit-run-card__truncated">… (${(data.totalLen ?? 0) - (data.out ?? "").length} more chars)</span>`
            : "";
          const statusClass = data.isError ? "bandit-run-card--error" : "bandit-run-card--ok";
          const runId = typeof data.runId === "string" ? escapeHtml(data.runId) : "";
          const clickableAttrs = runId
            ? ` data-run-id="${runId}" role="button" tabindex="0" title="Open full input/output in editor"`
            : "";
          const clickableClass = runId ? " bandit-run-card--clickable" : "";
          return (
            `<div class="bandit-run-card ${statusClass}${clickableClass}"${clickableAttrs}>` +
              `<div class="bandit-run-card__header">` +
                `<span class="bandit-run-card__icon">${data.isError ? "✕" : "❯"}</span>` +
                `<span class="bandit-run-card__label">Bash</span>` +
                (runId ? `<span class="bandit-run-card__open" aria-hidden="true">↗</span>` : "") +
              `</div>` +
              `<div class="bandit-run-card__row bandit-run-card__row--in">` +
                `<span class="bandit-run-card__tag">IN</span>` +
                `<code class="bandit-run-card__cmd">${cmd}</code>` +
              `</div>` +
              (data.out
                ? `<div class="bandit-run-card__row bandit-run-card__row--out">` +
                    `<span class="bandit-run-card__tag">OUT</span>` +
                    `<pre class="bandit-run-card__out"><code class="hljs language-bash">${outBody}${tail}</code></pre>` +
                  `</div>`
                : ``) +
            `</div>`
          );
        } catch {
          // Malformed payload — fall through to default rendering so the
          // user still sees SOMETHING rather than a blank card.
        }
      }
      // Diff card
      if (normalized === "diff") {
        let body: string;
        try {
          body = hljs.getLanguage("diff")
            ? hljs.highlight(raw, { language: "diff" }).value
            : escapeHtml(raw);
        } catch {
          body = escapeHtml(raw);
        }
        const rawLines = raw.split("\n").filter((l) => l.length > 0);
        // Prefer counts encoded in the fence info (extension knows the true
        // `+N −N` from the full-file diff); fall back to counting the lines
        // shown here, which only reflects what's in the compact preview.
        const pathMatch = /(?:^|\s)path=([^\s]+)/.exec(fullInfo);
        const plusMatch = /(?:^|\s)plus=(\d+)/.exec(fullInfo);
        const minusMatch = /(?:^|\s)minus=(\d+)/.exec(fullInfo);
        const relPath = pathMatch ? decodeURIComponent(pathMatch[1]) : "";
        const added = plusMatch
          ? Number(plusMatch[1])
          : rawLines.filter((l) => l.startsWith("+")).length;
        const removed = minusMatch
          ? Number(minusMatch[1])
          : rawLines.filter((l) => l.startsWith("-")).length;
        const openByDefault = rawLines.length <= 50;
        const title = relPath
          ? `<code class="bandit-diff-card__path">${escapeHtml(relPath)}</code>`
          : `<span class="bandit-diff-card__title">diff</span>`;
        // Stable cross-chunk key so the user's expand/collapse toggle
        // survives stream re-renders. See `diffOpenState` comment.
        const diffBodyForKey = raw.slice(0, 256);
        let bodyHash = 5381;
        for (let i = 0; i < diffBodyForKey.length; i++) {
          bodyHash = ((bodyHash << 5) + bodyHash + diffBodyForKey.charCodeAt(i)) | 0;
        }
        const diffKey = diffKeyFor(relPath, added, removed, (bodyHash >>> 0).toString(36));
        const userToggle = diffOpenState.get(diffKey);
        const isOpen = userToggle === undefined ? openByDefault : userToggle;
        return (
          `<details class="bandit-diff-card" data-diff-key="${escapeHtml(diffKey)}"${isOpen ? " open" : ""}>` +
          `<summary class="bandit-diff-card__summary">` +
            `<span class="bandit-diff-card__icon">⎔</span>` +
            title +
            `<span class="bandit-diff-card__stats">` +
              `<span class="bandit-diff-card__plus">+${added}</span>` +
              ` ` +
              `<span class="bandit-diff-card__minus">−${removed}</span>` +
            `</span>` +
          `</summary>` +
          `<pre><code class="hljs language-diff">${body}</code></pre>` +
          `</details>`
        );
      }
      // Non-diff fenced block — keep the existing toolbar + hljs body.
      // Skip if the body is empty/whitespace-only. Models occasionally emit
      // an opening fence with no content (e.g. they meant to embed code in
      // a table cell where fences don't work, leaving ` ```ts ` as orphan
      // markup elsewhere) — rendering it produces an empty card with a
      // language label and a Copy button, which looks broken. Suppressing
      // empty bodies removes the visual noise.
      if (!raw.trim()) {
        return "";
      }
      // Drop any `bandit-*` fence that fell through the structured
      // handlers above (bandit-subagent / bandit-reasoning / bandit-tl).
      // The host emits exactly those three; the structured renderers
      // own them. Anything else with a `bandit-` prefix landing in
      // the fallback is either:
      //   - a Gemma 4 / Qwen 3.6 hallucination of a host envelope
      //     (model saw `bandit-tl` in training transcripts and is
      //     parroting the shape — most common), or
      //   - a typo'd / mangled host fence (`bandit-reasoni`, etc.)
      // Either way it's never legitimate model output. Rendering it
      // as a labeled COPY-button panel makes the hallucination look
      // authoritative, which we just watched happen in a 5-subagent
      // run where each spawn produced a fake `bandit-tl` envelope
      // between the real subagent announcements. Drop silently.
      if (normalized && normalized.startsWith('bandit-')) {
        return "";
      }
      const label = normalized || "text";
      const display = escapeHtml(label.toUpperCase());
      let body: string;
      if (normalized && hljs.getLanguage(normalized)) {
        try {
          body = hljs.highlight(raw, { language: normalized }).value;
        } catch {
          body = escapeHtml(raw);
        }
      } else {
        body = escapeHtml(raw);
      }
      const langClass = normalized ? `hljs language-${escapeHtml(label)}` : "hljs language-text";
      return `<div class="message-code-block" data-lang="${display}"><div class="message-code-toolbar"><span class="message-code-label">${display}</span><button type="button" class="message-code-copy" aria-label="Copy code">Copy</button></div><pre><code class="${langClass}">${body}</code></pre></div>`;
    };
    return instance;
  }, []);
  /**
   * Close any unbalanced markdown code fences before rendering. Small
   * local models stream partial ``` blocks as part of their thinking
   * preamble — if the iteration ends before the closing fence lands,
   * every activity marker that follows in the accumulated transcript
   * renders as escaped text inside the orphan <pre>. Appending a
   * synthetic closing fence lets the rest of the transcript render
   * as normal markdown again.
   */
  const balanceFences = useCallback((content: string): string => {
    if (!content) {return content;}
    const matches = content.match(/^```/gm);
    if (!matches) {return content;}
    if (matches.length % 2 === 0) {return content;}
    return content + (content.endsWith("\n") ? "" : "\n") + "```\n";
  }, []);
  const renderMarkdown = useCallback(
    (content: string) => {
      const html = markdown.render(balanceFences(content));
      // Upgrade `<code>⟳ some status…</code>` spans into an animated status
      // pill. Extension emits a single `` `⟳ pondering…` `` (backticked
      // inline code) at the tail of an in-flight assistant entry. We
      // went emphasis → code-span because markdown-it's flanking logic
      // refused to italicize `*⟳ ... 23s*` ( );
      // backticks have no flanking rules and always render as <code>.
      // CLI renders this as plain inline code, which is fine.
      // Spark is empty — the `.bandit-status-spark` class draws a CSS ring
      // spinner. We tried rotating the `⟳` glyph itself, but U+27F3 is not
      // radially symmetric (the arrowhead and gap shift the visual center
      // off the bounding-box center) and different fonts render the glyph
      // differently — the rotation looked wobbly. A CSS ring is drawn
      // programmatically and is perfectly symmetric on every machine.
      const withSpinner = html.replace(
        /<code>⟳\s*([^<]+)<\/code>/g,
        (_m: string, phrase: string) => {
          // Wrap each character in a span so the accent "wave" (color warm +
          // slight grow + glow) travels across the phrase left-to-right. The
          // per-character stagger lives in CSS via `:nth-child` rules — we do
          // NOT set an inline `animation-delay` here because DOMPurify (below)
          // strips inline `style`, which would collapse every letter onto the
          // same delay and make the whole phrase pulse at once. Skip the
          // per-char split if the phrase carries an HTML entity (`&amp;` etc.)
          // so we never shatter it mid-entity — that phrase renders flat.
          const inner = /[&<>]/.test(phrase)
            ? phrase
            : Array.from(phrase, (ch) =>
                ch === ' ' ? ' ' : `<span class="bandit-status-char">${ch}</span>`
              ).join('');
          return `<span class="bandit-status-line"><span class="bandit-status-spark" aria-hidden="true"></span><span class="bandit-status-text">${inner}</span></span>`;
        }
      );
      // Clean up orphan markdown fence markers inside table cells. Models
      // (notably gpt-oss:120b 2026-04-26) sometimes try to embed code in a
      // table cell using ``` fences — but markdown-it doesn't process
      // fences inside `<td>`, so the literal ` ```ts ` and trailing ``` `
      // markers leak into the rendered HTML as plain text. Strip them
      // inside cells only; fences elsewhere are rendered by the
      // highlighter and must be left alone.
      const withoutOrphanFences = withSpinner.replace(
        /(<t[dh][^>]*>)([\s\S]*?)(<\/t[dh]>)/g,
        (_match, open: string, inner: string, close: string) => {
          const cleaned = inner
            // Opening fence with optional language: ```ts, ```js, ```...
            .replace(/```[a-zA-Z0-9_-]*\s*(?:<br\s*\/?\s*>|\n)?/g, '')
            // Stray closing fence
            .replace(/```/g, '');
          return open + cleaned + close;
        }
      );
      // tag workspace-relative anchor links so the click
      // handler can route them through the extension's openContextFile
      // bridge instead of letting the webview default to env.openExternal
      // (which opens BANDIT.md / src/foo.ts in the system browser as
      // if it were a URL — ). A link counts as
      // workspace-relative when: no protocol scheme, no leading `#`
      // (in-page anchor), not mailto, doesn't already have a `data-
      // workspace-link` attribute. We add the attribute carrying the
      // raw href so the click handler can resolve it against the
      // workspace root on the extension side.
      const withLocalLinks = withoutOrphanFences.replace(
        /<a\s+([^>]*?)href="([^"]+)"([^>]*)>/gi,
        (match, before: string, href: string, after: string) => {
          const trimmed = href.trim();
          if (!trimmed) {return match;}
          if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {return match;}  // any scheme (http, mailto, file, etc.)
          if (trimmed.startsWith('#')) {return match;}  // in-page anchor
          if (trimmed.startsWith('//')) {return match;} // protocol-relative
          if (/data-workspace-link\s*=/.test(`${before}${after}`)) {return match;}
          // Strip leading ./ and trailing line-anchor (#L42 etc.) to
          // get the bare workspace path for the bridge.
          const cleaned = trimmed.replace(/^\.\//, '').replace(/#L\d+(-L?\d+)?$/, '');
          return `<a ${before}href="${href}" data-workspace-link="${cleaned}"${after}>`;
        }
      );
      return DOMPurify.sanitize(withLocalLinks, { ADD_ATTR: ['aria-hidden', 'data-workspace-link'] });
    },
    [markdown, balanceFences]
  );
  const agentSummaryEntries = useMemo(
    () => buildAgentSummaryEntries(conversationEntries),
    [conversationEntries]
  );
  const latestSummaryEntry = agentSummaryEntries.length
    ? agentSummaryEntries[agentSummaryEntries.length - 1]
    : null;
  const isAgentRunActive = mode === "agent" && busy;
  const liveStepEntries = isAgentRunActive ? displayedLiveUpdates : [];
  const isChatStreaming = busy;
  // While streaming, the active assistant message is the LAST one in
  // the conversation. Hide its speaker pill until the stream closes —
  // listening to a half-baked response is jarring, and the button
  // reappears the moment `busy` flips false.
  const streamingAssistantMessageId = (() => {
    if (!isChatStreaming) {return null;}
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.id) {return m.id;}
    }
    return null;
  })();
  // Preserve ids regardless of feedback-prompt state — we used to
  // wipe assistant ids when feedbackPromptEnabled was false thinking
  // that suppressed the thumbs-up/down buttons. It did, but it also
  // killed the Listen button (which gates on `onSpeak && message.id`)
  // AND broke auto-speak playback routing (the `playAudio` message
  // correlates audio to a message by id). ChatMessage already gates
  // feedback UI on its own `showFeedbackButtons` prop (default false),
  // so this id strip was redundant double-protection with real costs.
  const conversationWindow = useMemo(() => {
    if (showFullConversation || messages.length <= CHAT_RENDER_WINDOW_SIZE) {
      return { messages, hiddenCount: 0 };
    }
    return {
      messages: messages.slice(-CHAT_RENDER_WINDOW_SIZE),
      hiddenCount: messages.length - CHAT_RENDER_WINDOW_SIZE
    };
  }, [messages, showFullConversation]);
  const conversationMessages = conversationWindow.messages;

  const activeTaskGoal = useMemo<AgentGoal | null>(() => {
    if (!rawPlan) {
      return null;
    }

    const timestamp = Date.now();
    const baseGoal = rawPlan.goals?.length ? rawPlan.goals[0] : undefined;
    const fallbackTitle = stripTurnTokens(rawPlan.goal) || "Agent goal";
    const fallbackGoalId = baseGoal?.id ?? "plan-goal";
    const sourceTasks: AgentTask[] =
      baseGoal?.tasks?.length
        ? baseGoal.tasks
        : rawPlan.tasks?.length
          ? rawPlan.tasks
          : rawPlan.steps.map((step, index) => ({
              id: step.id ?? `step-${index + 1}`,
              title: stripTurnTokens(step.title) || step.command || `Task ${index + 1}`,
              description: stripTurnTokens(step.details ?? ""),
              status: "pending",
              goalId: fallbackGoalId,
              files: step.targetFile ? [step.targetFile] : undefined,
              metadata: {
                stepId: step.id,
                command: step.command,
                targetFile: step.targetFile
              }
            }));

    if (!sourceTasks.length) {
      return {
        id: fallbackGoalId,
        title: baseGoal?.title ?? fallbackTitle,
        summary: baseGoal?.summary ?? fallbackTitle,
        tasks: [],
        createdAt: baseGoal?.createdAt ?? timestamp,
        updatedAt: timestamp
      };
    }

    const enhancedTasks = sourceTasks.map((task, index) => {
      const fallbackStepId = rawPlan.steps[index]?.id;
      const stepId = readTaskMetadataString(task, "stepId") ?? fallbackStepId;
      const update = stepId ? planUpdates[stepId] : undefined;
      const status = mapPlanUpdateStateToTaskStatus(update?.state, task.status ?? "pending");
      const description = stripTurnTokens(update?.summary ?? task.description ?? "");
      const metadataFile = readTaskMetadataString(task, "targetFile");
      const files =
        task.files?.length && task.files.some(Boolean)
          ? task.files
          : metadataFile
            ? [metadataFile]
            : undefined;
      return {
        ...task,
        goalId: task.goalId ?? fallbackGoalId,
        status,
        description: description || undefined,
        files
      };
    });

    return {
      id: fallbackGoalId,
      title: baseGoal?.title ?? fallbackTitle,
      summary: baseGoal?.summary ?? fallbackTitle,
      tasks: enhancedTasks,
      createdAt: baseGoal?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  }, [rawPlan, planUpdates]);

  const storedDiffEntryList = useMemo(
    () => Object.values(persistedDiffEntries),
    [persistedDiffEntries]
  );

  const liveDiffEntryList = useMemo(() => Object.values(liveDiffEntries), [liveDiffEntries]);

  const prioritizedLiveDiffEntries = useMemo(
    () => sortEntriesByCandidates(liveDiffEntryList, candidatePriorities),
    [candidatePriorities, liveDiffEntryList]
  );

  const taskStats = useMemo(() => {
    if (!activeTaskGoal?.tasks.length) {
      return null;
    }
    const total = activeTaskGoal.tasks.length;
    const completed = activeTaskGoal.tasks.filter((task) => task.status === "completed").length;
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
    return { total, completed, percent };
  }, [activeTaskGoal]);

  const activePlanRun = useMemo(
    () => findActivePlanRun(planHistory, activePlanRunId),
    [planHistory, activePlanRunId]
  );

  const summaryFiles = latestSummaryEntry?.data?.files ?? [];
  const summaryChangeEntries = useMemo<CompletedChangeEntry[]>(() => {
    if (!summaryFiles.length) {
      return [];
    }
    return summaryFiles.map((file) => ({
      path: file.path,
      diffText: file.diff ?? "",
      added: file.summary?.added,
      removed: file.summary?.removed
    }));
  }, [summaryFiles]);

  const archivedChangeEntries = useMemo<CompletedChangeEntry[]>(() => {
    if (summaryChangeEntries.length > 0) {
      return summaryChangeEntries;
    }
    return storedDiffEntryList;
  }, [storedDiffEntryList, summaryChangeEntries]);

  const prioritizedArchivedEntries = useMemo(
    () => sortEntriesByCandidates(archivedChangeEntries, candidatePriorities),
    [archivedChangeEntries, candidatePriorities]
  );

  const changeFileEntries = useMemo<CompletedChangeEntry[]>(() => {
    if (prioritizedLiveDiffEntries.length > 0) {
      return prioritizedLiveDiffEntries;
    }
    return prioritizedArchivedEntries;
  }, [prioritizedArchivedEntries, prioritizedLiveDiffEntries]);

  const liveDiffCount = liveDiffEntryList.length;
  const allowPinnedChanges = liveDiffCount > 0 && canUndoAgentChange;
  const showPinnedTasks = Boolean(taskStats && activeTaskGoal?.tasks.length && !taskPanelExpanded);
  const showPinnedWidgets = showPinnedTasks;
  const showHistoricalPanel = archivedChangeEntries.length > 0 && !allowPinnedChanges;

  const calculateTotals = useCallback((entries: CompletedChangeEntry[]) => {
    return entries.reduce(
      (acc, entry) => {
        if (typeof entry.added === "number") {
          acc.added += entry.added;
        }
        if (typeof entry.removed === "number") {
          acc.removed += entry.removed;
        }
        return acc;
      },
      { added: 0, removed: 0 }
    );
  }, []);

  const liveTotals = useMemo(() => calculateTotals(liveDiffEntryList), [calculateTotals, liveDiffEntryList]);
  const historicalTotals = useMemo(
    () => calculateTotals(archivedChangeEntries),
    [calculateTotals, archivedChangeEntries]
  );

  const liveDiffCountRef = useRef(0);
  useEffect(() => {
    if (!allowPinnedChanges) {
      setChangesExpanded(false);
    } else if (liveDiffCountRef.current !== liveDiffCount) {
      setChangesExpanded(false);
    }
    liveDiffCountRef.current = liveDiffCount;
  }, [allowPinnedChanges, liveDiffCount]);

  useEffect(() => {
    if (!showHistoricalPanel) {
      setHistoricalExpanded(false);
    }
  }, [showHistoricalPanel]);

  useEffect(() => {
    if (!isAgentRunActive) {
      setTaskPanelExpanded(false);
      setChangesExpanded(false);
    }
  }, [isAgentRunActive]);

  const composerDisabled = requireKey;

  useEffect(() => {
    providerContextRef.current = {
      provider: providerKind === "ollama" ? "Ollama" : "Bandit AI",
      model: providerKind === "ollama" ? ollamaModelName : banditModelName
    };
  }, [providerKind, banditModelName, ollamaModelName]);

  useEffect(() => {
    if (conversationIdRef.current !== currentConversationId) {
      conversationIdRef.current = currentConversationId;
      setContextFiles([]);
      setImageAttachments([]);
      setIsAutoScroll(true);
      setShowFullConversation(false);
      // Live-diff clear on conversation change is handled by
      // useLiveDiffEntries' own effect (re-seeds from storage iff
      // the new conversation's undo window is still open).
    }
  }, [currentConversationId]);
  useEffect(() => {
    const handleCopyClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".message-code-copy");
      if (!button) {
        return;
      }
      const codeElement = button.closest(".message-code-block")?.querySelector("code");
      const text = codeElement?.textContent ?? "";
      if (!text) {
        return;
      }
      const resetTimers = codeCopyResetTimers.current;
      const clearExistingTimer = (): void => {
        const timerId = resetTimers.get(button);
        if (timerId) {
          window.clearTimeout(timerId);
          resetTimers.delete(button);
        }
      };
      const resetLabel = (): void => {
        clearExistingTimer();
        button.classList.remove("is-copied");
        button.textContent = button.dataset.label ?? "Copy";
      };
      const writeToClipboard = async (): Promise<void> => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          try {
            document.execCommand("copy");
          } catch {
            // ignore clipboard failure
          }
          document.body.removeChild(textarea);
        }
      };
      writeToClipboard().then(() => {
        if (!button.dataset.label) {
          button.dataset.label = button.textContent ?? "Copy";
        }
        button.classList.add("is-copied");
        button.textContent = "Copied";
        clearExistingTimer();
        const timeoutId = window.setTimeout(resetLabel, 1500);
        resetTimers.set(button, timeoutId);
      });
    };
    document.addEventListener("click", handleCopyClick);

    // Tool-card click-through. Chat renders bandit-run and bandit-tl
    // rows with `data-run-id` when a runId is available — clicking one
    // (or hitting Enter/Space when focused) asks the extension host to
    // pop the full IN/OUT into a new editor tab. Uses delegated
    // listeners on document so the handler survives every re-render
    // of the dangerouslySetInnerHTML markdown output.
    const handleToolCardActivate = (event: MouseEvent | KeyboardEvent) => {
      if (event.type === "keydown") {
        const keyEvent = event as KeyboardEvent;
        if (keyEvent.key !== "Enter" && keyEvent.key !== " ") {return;}
      }
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      const card = target.closest<HTMLElement>("[data-run-id]");
      if (!card) {return;}
      const runId = card.dataset.runId;
      if (!runId) {return;}
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: "openToolDetail", runId });
    };
    document.addEventListener("click", handleToolCardActivate);
    document.addEventListener("keydown", handleToolCardActivate);

    // Subagent card open-state persistence. The intent — the
    // renderMarkdown code reads `subagentOpenState` to decide whether
    // to add the `open` attribute to a freshly-rendered `<details>`,
    // so a card the user expanded mid-run stays expanded across the
    // dangerouslySetInnerHTML re-renders that fire on every stream
    // chunk.
    //
    // fix: previously listened for the `toggle` event, which
    // is dispatched ASYNC (next tick) by the browser. With markdown
    // re-rendering on every chunk, the `<details>` element was being
    // replaced between the user's click and the toggle event firing —
    // so `subagentOpenState` never saw the new value and the next
    // render restored the wrong (collapsed) state. Listening for
    // `click` on `<summary>` is synchronous: we capture the user's
    // intent before any DOM swap happens, save the FUTURE state
    // (`!details.open`), and the next render correctly restores it.
    const handleSubagentSummaryClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      const summary = target.closest<HTMLElement>("summary");
      if (!summary) {return;}
      const details = summary.closest<HTMLDetailsElement>("details.bandit-subagent-card[data-subagent-key]");
      if (!details) {return;}
      const key = details.dataset.subagentKey;
      if (!key) {return;}
      // The browser will toggle `open` AFTER this click handler returns;
      // we record the post-click state so the map is correct before any
      // re-render rebuilds the DOM.
      subagentOpenState.set(key, !details.open);
    };
    document.addEventListener("click", handleSubagentSummaryClick);

    // Diff card open-state persistence — same pattern. Without this,
    // every stream chunk re-renders the markdown and the user's
    // expand/collapse toggle on a diff card resets to the
    // `openByDefault` value (true for <=50-line diffs, false otherwise).
    const handleDiffSummaryClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      const summary = target.closest<HTMLElement>("summary");
      if (!summary) {return;}
      const details = summary.closest<HTMLDetailsElement>("details.bandit-diff-card[data-diff-key]");
      if (!details) {return;}
      const key = details.dataset.diffKey;
      if (!key) {return;}
      diffOpenState.set(key, !details.open);
    };
    document.addEventListener("click", handleDiffSummaryClick);

    // Reasoning fence open-state persistence — same pattern. The
    // `bandit-reasoning` <details> is rendered <details open> by
    // default so the user sees chain-of-thought live; once they
    // collapse it, this handler records the choice so the next
    // stream chunk doesn't pop it back open.
    const handleReasoningSummaryClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      const summary = target.closest<HTMLElement>("summary");
      if (!summary) {return;}
      const details = summary.closest<HTMLDetailsElement>("details.bandit-reasoning[data-reasoning-key]");
      if (!details) {return;}
      const key = details.dataset.reasoningKey;
      if (!key) {return;}
      reasoningOpenState.set(key, !details.open);
    };
    document.addEventListener("click", handleReasoningSummaryClick);

    // workspace-relative link click handler. The markdown
    // renderer tags local-looking anchors with `data-workspace-link`
    // (see renderMarkdown). Without this interceptor those links go
    // through the webview's default open-link policy which routes to
    // env.openExternal — so clicking `BANDIT.md` in chat opens it in
    // the system browser. Intercept here and forward the path to the
    // extension's openContextFile bridge so VS Code opens it in a
    // tab. Same delegation pattern as the other handlers in this
    // effect — survives every dangerouslySetInnerHTML re-render.
    const handleWorkspaceLinkClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      const anchor = target.closest<HTMLAnchorElement>("a[data-workspace-link]");
      if (!anchor) {return;}
      const path = anchor.dataset.workspaceLink;
      if (!path) {return;}
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: "openContextFile", path });
    };
    document.addEventListener("click", handleWorkspaceLinkClick);

    // capture scrollTop on the card's synopsis `<pre>`. Same
    // pattern as the open-state listener above: capture-phase scroll on
    // document so the handler reaches descendants without waiting for
    // bubbling (`scroll` does NOT bubble), and so it survives every
    // markdown re-render. Saves into `subagentScrollState` keyed by the
    // closest card's `data-subagent-key` so the restore step (in a
    // companion useLayoutEffect below) can find it.
    const handleSubagentSynopsisScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      // Only care about scrolls inside a subagent synopsis.
      const pre = target.closest?.<HTMLElement>(".bandit-subagent-card__result pre");
      if (!pre) {return;}
      const card = pre.closest<HTMLElement>(".bandit-subagent-card[data-subagent-key]");
      if (!card) {return;}
      const key = card.dataset.subagentKey;
      if (!key) {return;}
      subagentScrollState.set(key, pre.scrollTop);
    };
    document.addEventListener("scroll", handleSubagentSynopsisScroll, true);

    return () => {
      document.removeEventListener("click", handleCopyClick);
      document.removeEventListener("click", handleToolCardActivate);
      document.removeEventListener("keydown", handleToolCardActivate);
      document.removeEventListener("click", handleSubagentSummaryClick);
      document.removeEventListener("click", handleDiffSummaryClick);
      document.removeEventListener("click", handleReasoningSummaryClick);
      document.removeEventListener("click", handleWorkspaceLinkClick);
      document.removeEventListener("scroll", handleSubagentSynopsisScroll, true);
      codeCopyResetTimers.current.forEach((timerId) => window.clearTimeout(timerId));
      codeCopyResetTimers.current.clear();
    };
  }, []);

  // restore subagent synopsis scrollTop after every chat
  // re-render. The chat content (driven by `conversationEntries`) is
  // committed via `dangerouslySetInnerHTML`, so any scrollTop on the
  // card's inner `<pre>` is reset to 0 on each chunk. useLayoutEffect
  // runs synchronously after the DOM commit but before the browser
  // paints — restoring scrollTop here means the user never sees the
  // jump-to-top flash.
  useLayoutEffect(() => {
    if (subagentScrollState.size === 0) {return;}
    document.querySelectorAll<HTMLElement>(".bandit-subagent-card[data-subagent-key]").forEach((card) => {
      const key = card.dataset.subagentKey;
      if (!key) {return;}
      const saved = subagentScrollState.get(key);
      if (saved == null) {return;}
      const pre = card.querySelector<HTMLElement>(".bandit-subagent-card__result pre");
      if (!pre) {return;}
      // Only restore if the user had actually scrolled away from the
      // top — otherwise leave it alone so newly-rendered cards open at
      // their natural position.
      if (saved > 0) {pre.scrollTop = saved;}
    });
  }, [conversationEntries]);

  useEffect(() => {
    const node = chatFeedRef.current;
    if (!node) {
      return;
    }
    // Direction-aware auto-scroll. Rules:
    // 1. Programmatic scrolls (the effect below) update our tracking
    //    position but never change isAutoScroll.
    // 2. ANY user scroll UP (current scrollTop < last tracked scrollTop)
    //    disables auto-scroll — the user wants to read history, don't
    //    fight them mid-answer.
    // 3. A user scroll INTO the bottom band (within 200px of the
    //    scroll bottom) re-enables auto-scroll. 200px is roughly a
    //    couple of visible lines + the input bar — enough room that
    //    you don't have to land pixel-perfect at the absolute bottom
    //    to re-stick, but not so wide that an unfinished scroll up
    //    accidentally re-enables it.
    // 4. Programmatic scrolls (auto-scroll-to-bottom) re-prime
    //    lastScrollTopRef so the next user scroll has the correct
    //    baseline for the direction check.
    const handleScroll = () => {
      const node2 = chatFeedRef.current;
      if (!node2) {return;}
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        lastScrollTopRef.current = node2.scrollTop;
        return;
      }
      const prev = lastScrollTopRef.current;
      const curr = node2.scrollTop;
      const nearBottom = curr + node2.clientHeight >= node2.scrollHeight - 200;
      if (curr < prev && !nearBottom) {
        // User scrolled up; disengage.
        setIsAutoScroll(false);
      } else if (nearBottom) {
        // User scrolled back into the bottom band; re-stick.
        setIsAutoScroll(true);
      }
      lastScrollTopRef.current = curr;
    };
    node.addEventListener("scroll", handleScroll);
    lastScrollTopRef.current = node.scrollTop;
    return () => node.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const node = chatFeedRef.current;
    if (!node || !isAutoScroll) {
      return;
    }
    programmaticScrollRef.current = true;
    node.scrollTop = node.scrollHeight;
  }, [messages, displayedLiveUpdates, isAutoScroll]);

  useEffect(() => {
    if (hasStoredApiKey && !requireKey && apiKeyDraft === "") {
      setMaskStoredKey(true);
    } else if ((!hasStoredApiKey || requireKey) && maskStoredKey) {
      setMaskStoredKey(false);
    }
  }, [hasStoredApiKey, requireKey, apiKeyDraft, maskStoredKey]);

  useEffect(() => {
    if (mode !== "agent") {
      setDisplayedLiveUpdates([]);
      setLiveQueue([]);
      return;
    }
    if (liveQueue.length > 0) {
      return;
    }
    const nextEntry = liveUpdates[displayedLiveUpdates.length];
    if (nextEntry) {
      setLiveQueue([nextEntry]);
    }
  }, [liveUpdates, mode, displayedLiveUpdates.length, liveQueue.length]);

  useEffect(() => {
    if (mode !== "agent" || !liveQueue.length) {
      return;
    }
    const [nextEntry] = liveQueue;
    if (!nextEntry) {
      return;
    }
    const timer = window.setTimeout(() => {
      setDisplayedLiveUpdates((prev) => [...prev, nextEntry]);
      setLiveQueue((prev) => prev.slice(1));
    }, LIVE_UPDATE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [liveQueue, mode]);

  useEffect(() => {
    if (mode !== "agent" || displayedLiveUpdates.length === 0) {
      return;
    }
    setDisplayedLiveUpdates((previous) => {
      if (previous.length === 0) {
        return previous;
      }
      const latestEntries = new Map(liveUpdates.map((entry) => [entry.id, entry]));
      let changed = false;
      const merged = previous.map((entry) => {
        const replacement = latestEntries.get(entry.id);
        if (replacement && replacement !== entry) {
          changed = true;
          return replacement;
        }
        return entry;
      });
      return changed ? merged : previous;
    });
  }, [liveUpdates, mode, displayedLiveUpdates.length]);

  useEffect(() => {
    const wasBusy = lastBusyRef.current;
    if (!wasBusy && busy && mode === "agent") {
      setDisplayedLiveUpdates([]);
      setLiveQueue([]);
      clearLiveDiffEntries();
    }
    if (wasBusy && !busy) {
      setLiveQueue([]);
      if (mode === "agent") {
        window.setTimeout(() => setDisplayedLiveUpdates([]), 600);
      }
    }
    lastBusyRef.current = busy;
  }, [busy, mode, clearLiveDiffEntries]);

  const handleStateMessage = useCallback((state: WebviewState) => {
    applyConversationStateSnapshot(state);
    if (state.presetPrompt && state.presetPrompt !== composerValue && !state.isBusy) {
      setComposerValue(state.presetPrompt);
    }
    applyAccountSnapshot(state, {
      setRequireKey,
      setHasApiKey,
      setAccountProfile,
      setAccountProfileStatus,
      setAccountProfileError,
      setHasStoredApiKey,
      setHasTavilyKey,
      setExtensionVersion
    });
    applyHistorySnapshot(state, {
      setHistory,
      setShowHistory,
      setHasArchivedConversations,
      setCurrentConversationName,
      setCanUndoAgentChange
    });
    applyProviderStateSnapshot(state);
    applyViewSnapshot(state, { setActiveView, setPlanUnread });
    applyPreferencesSnapshot(state, {
      setPlanArtifactsEnabled,
      setFeedbackPromptEnabled,
      setToolUseEnabled,
      setCreateBranchBeforeRun,
      setAutoApproveEdits,
      setAutoContextEnabled,
      setDeveloperMode,
      setSkipValidationInDev
    });
    applyVoiceSnapshot(state, {
      setVoiceMicEnabled,
      setVoiceAutoSpeakPref,
      setVoiceMicPref,
      setVoiceProviderSettings
    });
    applyMcpSnapshot(state, { setMcpSnapshot });
    applyStateSnapshot(state);
  }, [
    composerValue,
    applyConversationStateSnapshot,
    setComposerValue,
    applyProviderStateSnapshot,
    applyStateSnapshot
  ]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<WebviewMessage>) => {
      const message = event.data;
      // ─── Arc W4 topic dispatchers (return-true-when-handled) ───
      // Routed by topic; the residual inline switch below handles the
      // cases Arc W4-S2 hasn't extracted yet (plan, diff, permission,
      // audio, attachments).
      if (
        dispatchCoreLifecycleMessage(message, {
          handleStateMessage,
          updateToast,
          setRequireKey,
          resolveSkillListPromise: (skills) => {
            const pending = skillListPromiseRef.current;
            if (pending) {
              pending.resolve(skills);
              skillListPromiseRef.current = null;
            }
          }
        })
      ) {return;}
      if (
        dispatchAccountMessage(message, {
          setUsageSnapshot,
          setUsageStatus,
          setUsageError,
          setRateLimitToast,
          requestAccountUsage,
          appendContextInjectionSkippedEvent: (reason, prompt) =>
            createTelemetryEvent(
              { tokens: 0, durationMs: 0, ok: true },
              providerContextRef.current,
              {
                reason: reason ?? "context-skipped",
                prompt: typeof prompt === "string" ? prompt : undefined
              }
            ),
          appendEvents
        })
      ) {return;}
      if (
        dispatchVoiceMessage(message, {
          handleVoiceTranscription,
          handleExtensionMicAvailability,
          handleExtensionMicError
        })
      ) {return;}
      if (dispatchWorkspaceMessage(message, { handleWorkspaceFileSuggestions })) {return;}
      if (
        dispatchBackgroundTaskMessage(message, {
          setBackgroundTasksList,
          applyBackgroundTaskUpdate
        })
      ) {return;}
      if (
        dispatchTraceMessage(message, {
          setTracePanelOpen,
          setTraceViewMode,
          setTraceList,
          setTraceLoading,
          setTraceError,
          setTraceDetail,
          requestTraceDetail
        })
      ) {return;}
      if (
        dispatchPlanMessage(message, {
          handleAgentPlan,
          handleAgentPlanUpdate,
          handleAgentPlanHistory,
          resetForFreshPlan: () => {
            setDisplayedLiveUpdates([]);
            setLiveQueue([]);
            eventsRef.current = [];
            setEvents([]);
            setGoalFileHints(null);
          },
          setGoalFileHints,
          buildAndAppendTelemetryEvent: (telemetry) =>
            createTelemetryEvent(
              telemetry,
              providerContextRef.current,
              buildTelemetryMetadata(telemetry)
            ),
          appendEvents
        })
      ) {return;}
      if (
        dispatchDiffMessage(message, {
          handleDiffSnapshot,
          handleDiffPreviewCard,
          handleDiffPreviewResult,
          handleDiffPreviewClear,
          buildDiffSnapshotEvent: (snapshot) =>
            createDiffSnapshotEvent(
              snapshot,
              activePlanRunIdRef.current ?? planRef.current?.id ?? null
            ),
          appendEvents,
          setDiffStreamStatus
        })
      ) {return;}
      if (
        dispatchPermissionMessage(message, {
          enqueueApproval,
          resolveApproval,
          requestAskUser
        })
      ) {return;}
      if (dispatchAudioMessage(message, { handlePlayAudio, handleAudioError })) {return;}
      if (
        dispatchComposerAttachmentMessage(message, {
          setContextFiles,
          setImageAttachments,
          updateToast,
          contextFileLimit: CONTEXT_FILE_LIMIT,
          maxImageAttachments: MAX_IMAGE_ATTACHMENTS
        })
      ) {return;}
    };

    window.addEventListener("message", handleMessage);
    vscode.postMessage({ type: "requestState" });
    return () => window.removeEventListener("message", handleMessage);
  }, [
    appendEvents,
    handleAgentPlan,
    handleAgentPlanUpdate,
    handleAgentPlanHistory,
    handleStateMessage,
    updateToast,
    handleDiffPreviewCard,
    handleDiffPreviewResult,
    handleDiffPreviewClear
  ]);

  // Local queue of prompts the user typed while the agent was already
  // running. Drained one-at-a-time as the agent goes idle (busy → false).
  // The extension never sees these until they're dispatched — the
  // host-side cancel path can drop them by clearing this array, which
  // is what the cancel handler does so a stopped turn doesn't auto-fire
  // the queued prompts.
  //
  // Queue carries the full submission shape (text + images + files +
  // autoContext): when the user attaches images and then submits while
  // streaming, the images now travel with the queued message and the
  // composer clears them as if the message had sent immediately. Each
  // entry also has a stable `id` so the user can cancel ONE queued
  // message via the ✕ on its pill without dropping the rest.
  type QueuedPrompt = {
    id: string;
    text: string;
    images: string[];
    files: string[];
    autoContext: boolean;
  };
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const handleSendPrompt = useCallback(
    (value: string) => {
      const nextValue = value.trim();
      if (!nextValue || showHistory) {
        return;
      }
      // Local-only slash commands intercepted before the prompt is sent
      // to the agent loop. Same shape as Claude Code's "/" suite —
      // these don't burn LLM turns; they fire a vscode command directly
      // and clear the composer. Add new entries here when the command's
      // entire output is "do a side-effect, no model needed."
      if (nextValue === "/insights") {
        vscode.postMessage({ type: "runVscodeCommand", command: "banditStealth.insights" });
        setComposerValue("");
        return;
      }
      const lowerSlash = nextValue.toLowerCase();
      if (lowerSlash === "/trace" || lowerSlash === "/traces" || lowerSlash === "/trace list" || lowerSlash === "/trace last") {
        setTracePanelOpen(true);
        setShowHistory(false);
        setActivePage("workspace");
        vscode.postMessage({ type: "showHistory", value: false });
        setTraceViewMode("all");
        requestTraceList("all");
        setComposerValue("");
        return;
      }
      if (lowerSlash === "/trace failed" || lowerSlash === "/trace failures") {
        setTracePanelOpen(true);
        setShowHistory(false);
        setActivePage("workspace");
        vscode.postMessage({ type: "showHistory", value: false });
        setTraceViewMode("failed");
        requestTraceList("failed");
        setComposerValue("");
        return;
      }
      const traceIdMatch = /^\/trace\s+(.+)$/i.exec(nextValue);
      if (traceIdMatch) {
        const traceId = traceIdMatch[1]?.trim();
        if (traceId) {
          setTracePanelOpen(true);
          setShowHistory(false);
          setActivePage("workspace");
          vscode.postMessage({ type: "showHistory", value: false });
          requestTraceDetail(traceId);
          setComposerValue("");
          return;
        }
      }
      // !-prefix shell escape — same shape as the CLI. Routes to the
      // VS Code integrated terminal so interactive scaffolders
      // (create-vite, ng new, etc) actually have a TTY to read from.
      // The agent doesn't see the output; this is purely a
      // user-invoked command. Catastrophic patterns are blocked
      // host-side mirroring the CLI's BLOCKED_PATTERNS.
      if (nextValue.startsWith("!") && nextValue.length > 1) {
        const bashCmd = nextValue.slice(1).trim();
        if (bashCmd) {
          vscode.postMessage({ type: "runShellCommand", command: bashCmd });
        }
        setComposerValue("");
        return;
      }
      // Agent is mid-turn → queue the prompt locally. The host drains
      // the queue when busy flips to false (see effect below).
      // Attachments / images / context-files / autoContext travel WITH
      // the queued message and the composer clears them just like the
      // immediate-send branch below — without this, attached images
      // stayed in the composer and never reached the queued send, so
      // the user had to manually re-attach or send each in isolation.
      if (busy) {
        const queuedFiles = contextFiles.map((file) => file.path).filter(Boolean);
        const queuedImages = imageAttachments.filter((image) => image.length > 0);
        const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        setQueuedPrompts((q) => [...q, {
          id,
          text: nextValue,
          images: queuedImages,
          files: queuedFiles,
          autoContext: autoContextEnabled,
        }]);
        setComposerValue("");
        setContextFiles([]);
        setImageAttachments([]);
        return;
      }
      const files = contextFiles.map((file) => file.path).filter(Boolean);
      const images = imageAttachments.filter((image) => image.length > 0);
      vscode.postMessage({
        type: "sendPrompt",
        text: nextValue,
        mode: "agent",
        files: files.length ? files : undefined,
        images: images.length ? images : undefined,
        autoContext: autoContextEnabled
      });
      setComposerValue("");
      setContextFiles([]);
      setImageAttachments([]);
    },
    [busy, contextFiles, imageAttachments, showHistory, autoContextEnabled, requestTraceList, requestTraceDetail]
  );

  const handleNewConversation = useCallback(() => {
    setTracePanelOpen(false);
    vscode.postMessage({ type: "startNewConversation" });
  }, []);

  const handleToggleHistory = useCallback(() => {
    setTracePanelOpen(false);
    vscode.postMessage({ type: "showHistory", value: !showHistory });
  }, [showHistory]);

  const handleSelectConversation = useCallback((id: string) => {
    vscode.postMessage({ type: "selectConversation", id });
  }, []);

  const handleClearHistory = useCallback(() => {
    vscode.postMessage({ type: "clearAllConversations" });
  }, []);

  const handleArchiveConversation = useCallback((id: string, archived: boolean) => {
    vscode.postMessage({ type: "archiveConversation", id, archived });
  }, []);

  const handleDeleteConversation = useCallback((id: string) => {
    vscode.postMessage({ type: "deleteConversation", id });
  }, []);

  const handleRefreshAccountProfile = useCallback(() => {
    requestAccountProfile();
  }, []);

  const handleOpenUsage = useCallback(() => {
    setUsageModalOpen(true);
    setUsageStatus("loading");
    setUsageError(null);
    requestAccountUsage();
  }, []);

  const handleCloseUsage = useCallback(() => {
    setUsageModalOpen(false);
  }, []);

  const handleRefreshUsage = useCallback(() => {
    setUsageStatus("loading");
    setUsageError(null);
    requestAccountUsage();
  }, []);

  const handleDismissRateLimitToast = useCallback(() => {
    setRateLimitToast(null);
  }, []);

  const handleViewUsageFromToast = useCallback(() => {
    setRateLimitToast(null);
    setUsageModalOpen(true);
    setUsageStatus(usageSnapshot ? "ready" : "loading");
    if (!usageSnapshot) {
      requestAccountUsage();
    }
  }, [usageSnapshot]);

  const handleOpenSettings = useCallback(() => {
    setTracePanelOpen(false);
    setActivePage("settings");
    setActiveSettingsTab("account");
  }, []);

  const handleOpenAccountSettings = useCallback(() => {
    setTracePanelOpen(false);
    setActivePage("settings");
    setActiveSettingsTab("account");
  }, []);

  const handleHideSettings = useCallback(() => {
    setActivePage("workspace");
    setApiKeyDraft("");
  }, []);

  const handleSaveApiKey = useCallback(() => {
    if (maskStoredKey || !apiKeyDraft.trim()) {
      return;
    }
    vscode.postMessage({ type: "setApiKey", value: apiKeyDraft.trim() });
    setApiKeyDraft("");
    setMaskStoredKey(false);
  }, [apiKeyDraft, maskStoredKey]);

  const handleClearApiKey = useCallback(() => {
    vscode.postMessage({ type: "clearApiKey" });
    setApiKeyDraft("");
    setMaskStoredKey(false);
  }, []);

  const handleSignInWithBurtson = useCallback(() => {
    vscode.postMessage({ type: "signInWithBurtson" });
  }, []);


  const handleSaveTavilyKey = useCallback(() => {
    const trimmed = tavilyKeyDraft.trim();
    if (!trimmed) {return;}
    vscode.postMessage({ type: "setTavilyKey", value: trimmed });
    setTavilyKeyDraft("");
  }, [tavilyKeyDraft]);

  const handleClearTavilyKey = useCallback(() => {
    vscode.postMessage({ type: "clearTavilyKey" });
    setTavilyKeyDraft("");
  }, []);

  const handleAttachContext = useCallback(() => {
    if (busy || showHistory) {
      return;
    }
    if (requireKey) {
      setActivePage("settings");
      setActiveSettingsTab("account");
      return;
    }
    vscode.postMessage({ type: "requestContextFiles" });
  }, [busy, requireKey, showHistory]);

  const handleToggleAutoContext = useCallback(() => {
    setAutoContextEnabled((previous) => {
      const next = !previous;
      // Persist globally so the choice survives webview reloads and
      // new VS Code windows. Extension writes to
      // banditStealth.autoContextEnabled and echoes via WebviewState.
      vscode.postMessage({
        type: "setConfig",
        key: "autoContextEnabled",
        value: next
      });
      return next;
    });
  }, []);


  const handleRemoveContextFile = useCallback((path: string) => {
    setContextFiles((prev) => prev.filter((file) => file.path !== path));
  }, []);

  const handleRemoveImageAttachment = useCallback((index: number) => {
    setImageAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const handleCancelResponse = useCallback(() => {
    // Drop anything the user lined up behind the cancelled turn —
    // they're stopping the active flow because the direction is wrong,
    // queued follow-ups based on that flow are almost certainly stale
    // too. Mirrors the CLI's Esc-clears-queue behavior.
    setQueuedPrompts([]);
    vscode.postMessage({ type: "cancelResponse" });
  }, []);

  // Drain the local queue when the agent goes idle. Pulls one prompt
  // at a time so each lands as a real "send a new prompt" round-trip
  // (no protocol changes needed in the extension). Wired off `busy`
  // because the extension toggles that flag at end-of-turn — same
  // signal the composer's Stop button watches.
  //
  // Each entry carries its own attachments + autoContext snapshot so
  // the queued send matches what the user composed when they hit
  // Enter, not the composer's current state at drain time.
  useEffect(() => {
    if (busy || queuedPrompts.length === 0) {return;}
    const [next, ...rest] = queuedPrompts;
    setQueuedPrompts(rest);
    vscode.postMessage({
      type: "sendPrompt",
      text: next.text,
      mode: "agent",
      files: next.files.length ? next.files : undefined,
      images: next.images.length ? next.images : undefined,
      autoContext: next.autoContext,
    });
  }, [busy, queuedPrompts]);

  const handleCancelQueuedPrompt = useCallback((id: string) => {
    setQueuedPrompts((q) => q.filter((p) => p.id !== id));
  }, []);

  const handlePasteImages = useCallback(
    (files: File[]) => {
      if (!files.length) {
        return;
      }
      const remaining = MAX_IMAGE_ATTACHMENTS - imageAttachments.length;
      if (remaining <= 0) {
        updateToast(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
        return;
      }
      const selected = files.slice(0, remaining);
      Promise.all(selected.map(readFileAsDataUrl))
        .then((images) => {
          if (!images.length) {
            return;
          }
          setImageAttachments((prev) => [...prev, ...images]);
        })
        .catch(() => {
          updateToast("Unable to attach image. Try again.");
        });
    },
    [imageAttachments.length, updateToast]
  );

  const handleOpenContextFile = useCallback((path?: string) => {
    const target = typeof path === "string" ? path.trim() : "";
    if (!target) {
      return;
    }
    vscode.postMessage({ type: "openContextFile", path: target });
  }, []);

  // Composer skill-list request: returns the pending promise if one is
  // already in flight, otherwise opens a fresh one + posts requestSkillList
  // + arms a 4 s guardrail so the popover never hangs forever if the
  // extension doesn't reply.
  const handleRequestSkills = useCallback((): Promise<ComposerSkillOption[]> => {
    if (skillListPromiseRef.current) {
      return skillListPromiseRef.current.promise;
    }
    let resolver: (value: ComposerSkillOption[]) => void = () => {};
    const promise = new Promise<ComposerSkillOption[]>((resolve) => {
      resolver = resolve;
    });
    skillListPromiseRef.current = { promise, resolve: resolver };
    vscode.postMessage({ type: "requestSkillList" });
    window.setTimeout(() => {
      if (skillListPromiseRef.current) {
        skillListPromiseRef.current.resolve([]);
        skillListPromiseRef.current = null;
      }
    }, 4000);
    return promise;
  }, []);

  const handleToggleAutoApproveEdits = useCallback(() => {
    const next = !autoApproveEdits;
    setAutoApproveEdits(next);
    vscode.postMessage({
      type: "setConfig",
      key: "agent.autoApproveEdits",
      value: next
    });
  }, [autoApproveEdits]);

  const handleSelectTheme = useCallback(
    (preference: ThemePreference) => {
      setThemePreference(preference);
    },
    [setThemePreference]
  );

  const handleApiKeyFocus = useCallback(() => {
    if (maskStoredKey) {
      setMaskStoredKey(false);
      setApiKeyDraft("");
    }
  }, [maskStoredKey]);

  const handleTogglePlanArtifacts = useCallback(() => {
    const next = !planArtifactsEnabled;
    setPlanArtifactsEnabled(next);
    vscode.postMessage({ type: "updatePreference", key: "debug.emitPlanJson", value: next });
  }, [planArtifactsEnabled]);

  const handleToggleFeedback = useCallback(() => {
    const next = !feedbackPromptEnabled;
    setFeedbackPromptEnabled(next);
    vscode.postMessage({ type: "updatePreference", key: "feedback.enabled", value: next });
  }, [feedbackPromptEnabled]);

  const handleToggleSkipValidationInDev = useCallback(() => {
    const next = !skipValidationInDev;
    setSkipValidationInDev(next);
    vscode.postMessage({ type: "updatePreference", key: "agent.skipValidationInDev", value: next });
  }, [skipValidationInDev]);

  const handleToggleToolUse = useCallback(() => {
    const next = !toolUseEnabled;
    setToolUseEnabled(next);
    vscode.postMessage({ type: "updatePreference", key: "enableToolUse", value: next });
  }, [toolUseEnabled]);

  const handleToggleCreateBranchBeforeRun = useCallback(() => {
    const next = !createBranchBeforeRun;
    setCreateBranchBeforeRun(next);
    vscode.postMessage({ type: "updatePreference", key: "agent.createBranchBeforeRun", value: next });
  }, [createBranchBeforeRun]);

  const handleDismissFeedback = useCallback(
    (_messageId: string) => {
      if (!feedbackPromptEnabled) {
        return;
      }
      setFeedbackPromptEnabled(false);
      vscode.postMessage({ type: "updatePreference", key: "feedback.enabled", value: false });
    },
    [feedbackPromptEnabled]
  );

  const latestHistoricalPlanRun = useMemo(() => {
    if (!planHistory.length) {
      return null;
    }
    return planHistory.reduce((latest, run) =>
      run.updatedAt > latest.updatedAt ? run : latest
    );
  }, [planHistory]);

  // Active-plan AgentPlan takes priority; historical runs project their
  // Plan shape via buildPlan so PlanTree's AgentPlan prop type is happy.
  const inspectorPlan: AgentPlan | null =
    plan ??
    (activePlanRun?.plan ? buildPlan(activePlanRun.plan, planUpdates, activePlanRun.id) : null) ??
    (latestHistoricalPlanRun?.plan
      ? buildPlan(latestHistoricalPlanRun.plan, planUpdates, latestHistoricalPlanRun.id)
      : null);
  const inspectorRunForEvaluation = activePlanRun ?? latestHistoricalPlanRun;

  const inspectorEmpty = !inspectorPlan && events.length === 0;
  const isSettingsPage = activePage === "settings";
  const planHasSteps = Boolean(plan?.steps?.length);
  // Only surface the Plan tab when an actual plan exists. Previously
  // we also showed it whenever ANY tool/activity event had streamed,
  // which meant the tab appeared every time the agent ran — creating
  // a second navigation node for the same information that's already
  // visible inline in the chat transcript. Users flagged this as
  // clutter during active agent work; gating on `planHasSteps` keeps
  // the tab for explicit plans (e.g. `/plan` flow) only.
  const planTabsVisible = !tracePanelOpen && !showHistory && !isSettingsPage && planHasSteps;
  const showConversationPanel = !tracePanelOpen && !isSettingsPage && !showHistory && (!planTabsVisible || activeView === "conversation");
  const showPlanPanel = !tracePanelOpen && !isSettingsPage && !showHistory && planTabsVisible && activeView === "plan";
  const layoutClassNames = clsx(
    "stealth-layout",
    (!showConversationPanel || !showPlanPanel) && "stealth-layout--single"
  );
  const showConversationTitle = !tracePanelOpen && !isSettingsPage && !showHistory && activeView === "conversation";
  const fallbackToolbarTitle = isSettingsPage
    ? "Settings"
    : tracePanelOpen
      ? "Trace Logs"
      : showHistory
      ? "Conversation History"
      : activeView === "plan"
        ? "Plan Execution"
        : "Bandit Stealth";
  const toolbarTitle = showConversationTitle
    ? (currentConversationName ?? "New Conversation").toUpperCase()
    : fallbackToolbarTitle.toUpperCase();
  const settingsButtonTooltip = activePage === "settings" ? "Close settings" : "Settings";
  const maskedApiKeyDisplay = accountProfile?.maskedKey ?? "bai_••••••••••";
  const apiKeyInputValue = maskStoredKey ? maskedApiKeyDisplay : apiKeyDraft;
  const apiKeyInputType = maskStoredKey ? "text" : "password";

  useEffect(() => {
    if (!planTabsVisible) {
      setPlanUnread(false);
      planEventCountRef.current = events.length;
      if (activeView !== "conversation") {
        setActiveView("conversation");
      }
    }
  }, [planTabsVisible, activeView, events.length]);

  useEffect(() => {
    if (showHistory && activeView !== "conversation") {
      setActiveView("conversation");
      setPlanUnread(false);
    }
  }, [showHistory, activeView]);

  useEffect(() => {
    if (!planTabsVisible) {
      return;
    }
    if (activeView === "plan") {
      setPlanUnread(false);
      planEventCountRef.current = events.length;
      return;
    }
    if (events.length > planEventCountRef.current) {
      setPlanUnread(true);
      planEventCountRef.current = events.length;
    }
  }, [events, activeView, planTabsVisible]);

  const handleSelectView = useCallback(
    (view: "conversation" | "plan") => {
      if (view === "plan" && !planTabsVisible) {
        return;
      }
      setActiveView(view);
      if (view === "plan") {
        setPlanUnread(false);
      }
    },
    [planTabsVisible]
  );

  return (
    <div
      className={clsx(
        "stealth-shell",
        `bandit-theme-${banditTheme.id}`,
        isVscodeTheme && "agent-ui-theme-vscode",
        themeAppearance === "light"
          ? ["theme-light", "agent-ui-theme-light"]
          : ["theme-dark", "agent-ui-theme-dark"]
      )}
    >
      <TopBar
        toolbarTitle={toolbarTitle}
        settingsButtonTooltip={settingsButtonTooltip}
        activePage={activePage}
        showHistory={showHistory}
        isSettingsPage={isSettingsPage}
        tracePanelOpen={tracePanelOpen}
        onToggleHistory={handleToggleHistory}
        onOpenTracePanel={handleOpenTracePanel}
        onNewConversation={handleNewConversation}
        onOpenSettings={handleOpenSettings}
        onHideSettings={handleHideSettings}
      />

      {!isSettingsPage && planTabsVisible && (
        <div className="stealth-view-tabs" role="tablist" aria-label="Conversation views">
          <button
            type="button"
            className={clsx("stealth-view-tab", showConversationPanel && "is-active")}
            role="tab"
            aria-selected={showConversationPanel}
            aria-controls="stealth-conversation-panel"
            onClick={() => handleSelectView("conversation")}
          >
            Conversation
          </button>
          <button
            type="button"
            className={clsx("stealth-view-tab", showPlanPanel && "is-active")}
            role="tab"
            aria-selected={showPlanPanel}
            aria-controls="stealth-plan-panel"
            onClick={() => handleSelectView("plan")}
          >
            Plan Execution
            {planUnread && <span className="stealth-view-tab__badge" aria-label="New plan activity" />}
          </button>
        </div>
      )}

      {tracePanelOpen ? (
        <TraceLogPanel
          traces={traceList}
          detail={traceDetail}
          mode={traceViewMode}
          loading={traceLoading}
          error={traceError}
          onModeChange={handleTraceModeChange}
          onRefresh={handleTraceRefresh}
          onSelectTrace={requestTraceDetail}
          onOpenRaw={(filePath) => vscode.postMessage({ type: "openTraceFile", path: filePath })}
          onClose={() => setTracePanelOpen(false)}
        />
      ) : isSettingsPage ? (
        <SettingsPanel
          activeTab={activeSettingsTab}
          onSelectTab={setActiveSettingsTab}
          onClose={handleHideSettings}
          disableClose={false}
          accountProfile={accountProfile}
          accountProfileStatus={accountProfileStatus}
          accountProfileError={accountProfileError}
          onRefreshAccountProfile={handleRefreshAccountProfile}
          onOpenUsage={handleOpenUsage}
          apiKeyDraft={apiKeyDraft}
          apiKeyInputType={apiKeyInputType}
          apiKeyInputValue={apiKeyInputValue}
          onApiKeyChange={setApiKeyDraft}
          onApiKeyFocus={handleApiKeyFocus}
          onSaveApiKey={handleSaveApiKey}
          onClearApiKey={handleClearApiKey}
          onSignInWithBurtson={handleSignInWithBurtson}
          hasStoredApiKey={hasStoredApiKey}
          maskStoredKey={maskStoredKey}
          setMaskStoredKey={setMaskStoredKey}
          ollamaBaseUrlDraft={ollamaBaseUrlDraft}
          onOllamaBaseUrlChange={setOllamaBaseUrlDraft}
          onSaveOllamaBaseUrl={handleSaveOllamaBaseUrl}
          onResetOllamaBaseUrl={handleResetOllamaBaseUrl}
          ollamaAuthDraft={ollamaAuthDraft}
          onOllamaAuthChange={setOllamaAuthDraft}
          onSaveOllamaAuth={handleSaveOllamaAuth}
          onClearOllamaAuth={handleClearOllamaAuth}
          hasOllamaAuthToken={hasOllamaAuthToken}
          tavilyKeyDraft={tavilyKeyDraft}
          onTavilyKeyChange={setTavilyKeyDraft}
          onSaveTavilyKey={handleSaveTavilyKey}
          onClearTavilyKey={handleClearTavilyKey}
          hasTavilyKey={hasTavilyKey}
          extensionVersion={extensionVersion}
          providerKind={providerKind}
          onSelectProvider={handleSelectProvider}
          onOpenSettings={(query) => vscode.postMessage({ type: "openSettings", query })}
          themePreference={themePreference}
          themeOptions={themeOptions}
          onSelectTheme={handleSelectTheme}
          themeStatusLabel={themeStatusLabel}
          planArtifactsEnabled={planArtifactsEnabled}
          onTogglePlanArtifacts={handleTogglePlanArtifacts}
          feedbackPromptEnabled={feedbackPromptEnabled}
          onToggleFeedback={handleToggleFeedback}
          developerMode={developerMode}
          skipValidationInDev={skipValidationInDev}
          onToggleSkipValidationInDev={handleToggleSkipValidationInDev}
          toolUseEnabled={toolUseEnabled}
          onToggleToolUse={handleToggleToolUse}
          createBranchBeforeRun={createBranchBeforeRun}
          onToggleCreateBranchBeforeRun={handleToggleCreateBranchBeforeRun}
          voiceAutoSpeakPref={voiceAutoSpeakPref}
          voiceMicPref={voiceMicPref}
          onToggleVoiceAutoSpeak={() => {
            const next = !voiceAutoSpeakPref;
            setVoiceAutoSpeakPref(next);
            vscode.postMessage({ type: "setConfig", key: "voice.autoSpeak", value: next });
          }}
          onToggleVoiceMic={() => {
            const next = !voiceMicPref;
            setVoiceMicPref(next);
            vscode.postMessage({ type: "setConfig", key: "voice.micEnabled", value: next });
          }}
          voiceProviderSettings={voiceProviderSettings}
          onUpdateVoiceProviderSetting={(key, value) => {
            // Optimistic local update so the form is responsive even
            // before the extension echoes the new value back through
            // the state-sync channel.
            setVoiceProviderSettings((prev) => ({ ...prev, [key]: value }));
            // Map the panel's flat key onto the workspace setting path.
            const SETTING_KEY: Record<keyof VoiceProviderSettings, string> = {
              sttProvider: "voice.stt.provider",
              sttUrl: "voice.stt.url",
              sttApiKey: "voice.stt.apiKey",
              sttModel: "voice.stt.model",
              ttsProvider: "voice.tts.provider",
              ttsUrl: "voice.tts.url",
              ttsApiKey: "voice.tts.apiKey",
              ttsModel: "voice.tts.model",
              ttsVoiceId: "voice.voiceId"
            };
            vscode.postMessage({ type: "setConfig", key: SETTING_KEY[key], value });
          }}
          requireKey={requireKey}
          brandLogoSrc={heroLogoSrc}
          mcpSnapshot={mcpSnapshot}
          onMcpReload={() => vscode.postMessage({ type: "mcpReload" })}
          onMcpReconnect={(name) => vscode.postMessage({ type: "mcpReconnect", name })}
          onMcpDisconnect={(name) => vscode.postMessage({ type: "mcpDisconnect", name })}
          onMcpRevokeTrust={(name) => vscode.postMessage({ type: "mcpRevokeTrust", name })}
          onMcpToggleActivation={(name, next) => vscode.postMessage({ type: "mcpSetActivation", name, activation: next })}
          onMcpAddGitHub={() => vscode.postMessage({ type: "mcpAddGitHub" })}
          onMcpAddSlack={() => vscode.postMessage({ type: "mcpAddSlack" })}
          onMcpAddGitLab={() => vscode.postMessage({ type: "mcpAddGitLab" })}
          onMcpAddCustom={() => vscode.postMessage({ type: "mcpAddCustom" })}
        />
      ) : (
        <div className={layoutClassNames}>
          {showHistory ? (
            <section className="stealth-history-panel" aria-label="Conversation history">
              <HistoryPanel
                history={history}
                currentConversationId={currentConversationId}
                hasArchived={hasArchivedConversations}
                onSelect={handleSelectConversation}
                onClear={handleClearHistory}
                onDismiss={handleToggleHistory}
                onArchive={handleArchiveConversation}
                onDelete={handleDeleteConversation}
              />
            </section>
          ) : (
            showConversationPanel && (
              <section
                id="stealth-conversation-panel"
                className="stealth-chat-panel"
                role={planTabsVisible ? "tabpanel" : undefined}
                aria-hidden={!showConversationPanel}
              >
                {requireKey && <ApiKeyBanner onSetup={handleOpenAccountSettings} />}
                <div className="stealth-chat-feed" ref={chatFeedRef}>
                  {messages.length === 0 ? (
                    <ChatFeedLanding
                      heroLogoSrc={heroLogoSrc}
                      ollamaStatus={ollamaStatus}
                      providerKind={providerKind}
                      ollamaModelMissing={ollamaModelMissing}
                    />
                  ) : (
                    <>
                      {conversationWindow.hiddenCount > 0 && (
                        <div className="chat-window-control">
                          <button
                            type="button"
                            className="chat-window-control__button"
                            onClick={() => setShowFullConversation(true)}
                          >
                            Show {conversationWindow.hiddenCount} earlier messages
                          </button>
                        </div>
                      )}
                      <ChatConversation
                        messages={conversationMessages}
                        renderMarkdown={renderMarkdown}
                        onFeedback={
                          feedbackPromptEnabled
                            ? (id, rating) =>
                                vscode.postMessage({ type: "submitFeedback", messageId: id, rating })
                            : undefined
                        }
                        onDismissFeedback={feedbackPromptEnabled ? handleDismissFeedback : undefined}
                        onContextFileClick={(file) => handleOpenContextFile(file.path)}
                        onPermissionChoice={(id, choice, notes) =>
                          vscode.postMessage({ type: "permissionResponse", id, choice, notes })
                        }
                        onSpeak={!hasApiKey ? undefined : (id, text, action = "start") => {
                          if (action === "pause") {pauseSpeak(id);}
                          else if (action === "resume") {resumeSpeak(id);}
                          else if (action === "stop") {stopSpeak();}
                          else {startSpeak(id, text);}
                        }}
                        speakingMessageId={speakingEntryId}
                        speakPaused={audioPaused}
                        streamingMessageId={streamingAssistantMessageId}
                      />
                    </>
                  )}
                  {isAgentRunActive &&
                    liveStepEntries.map((entry) => (
                      <LiveStepMessage key={entry.id} entry={entry} />
                    ))}
                  {diffStreamStatus && (
                    <div className="agent-diff-stream-indicator">
                      <span className="agent-diff-stream-label">
                        Writing {diffStreamStatus.path.split("/").pop()} ({diffStreamStatus.chars} chars)…
                      </span>
                    </div>
                  )}
                  {taskPanelExpanded && activeTaskGoal && (activeTaskGoal.tasks?.length ?? 0) > 0 && (
                    <div className="subgoal-inline">
                      <TaskList goal={activeTaskGoal} onCollapse={() => setTaskPanelExpanded(false)} />
                    </div>
                  )}
                  {allowPinnedChanges && changeFileEntries.length > 0 && (
                    <div className="completed-changes-inline">
                      {changesExpanded ? (
                        <CompletedChangesPanel
                          entries={changeFileEntries}
                          totals={liveTotals}
                          onAction={handleDiffPreviewAction}
                          onUndo={handleUndoAgentChanges}
                          undoDisabled={!canUndoAgentChange}
                          onCollapse={() => setChangesExpanded(false)}
                          defaultExpanded
                          compactActions={allowPinnedChanges}
                        />
                      ) : (
                        <FilesChangedSummaryCard
                          fileCount={changeFileEntries.length}
                          totals={liveTotals}
                          onExpand={() => setChangesExpanded(true)}
                          onUndo={handleUndoAgentChanges}
                          undoDisabled={!canUndoAgentChange}
                        />
                      )}
                    </div>
                  )}
                  {showHistoricalPanel && (
                    <div className="completed-changes-inline">
                      {historicalExpanded ? (
                        <CompletedChangesPanel
                          entries={archivedChangeEntries}
                          totals={historicalTotals}
                          onAction={handleDiffPreviewAction}
                          onUndo={undefined}
                          undoDisabled
                          onCollapse={() => setHistoricalExpanded(false)}
                          defaultExpanded
                          compactActions={false}
                        />
                      ) : (
                        <FilesChangedSummaryCard
                          fileCount={archivedChangeEntries.length}
                          totals={historicalTotals}
                          onExpand={() => setHistoricalExpanded(true)}
                          onUndo={() => undefined}
                          undoDisabled
                          showUndo={false}
                        />
                      )}
                    </div>
                  )}
                </div>
                <div className="chat-input-container">
                  {showPinnedWidgets && (
                    <div className="pinned-widgets">
                      {showPinnedTasks && taskStats && (
                        <TaskSummaryCard stats={taskStats} onExpand={() => setTaskPanelExpanded(true)} />
                      )}
                    </div>
                  )}
                  {approvalQueue.length > 0 && (
                    <div
                      className="approval-queue-container"
                      role="region"
                      aria-label={`${approvalQueue.length} pending approval${approvalQueue.length === 1 ? "" : "s"}`}
                    >
                      {approvalQueue.length > 1 && (
                        <div className="approval-queue-count">
                          {approvalQueue.length - 1} more pending after this
                        </div>
                      )}
                      <PermissionCard
                        key={approvalQueue[0].id}
                        payload={approvalQueue[0]}
                        onChoice={handleApprovalChoice}
                      />
                    </div>
                  )}
                  {askUserRequest && (
                    <AskUserForm
                      key={askUserRequest.id}
                      id={askUserRequest.id}
                      questions={askUserRequest.questions}
                      onSubmit={handleAskUserSubmit}
                    />
                  )}
                  <BackgroundTaskTile
                    tasks={backgroundTasks}
                    expanded={backgroundPanelOpen}
                    onToggleExpanded={toggleBackgroundPanel}
                    onCancel={cancelBackgroundTask}
                    onDismiss={dismissBackgroundTask}
                  />
                  {/* When a permission card is showing, hide the composer
                      so the card has the panel's full attention — same
                      pattern Claude Code uses. The card itself owns a
                      "Tell Bandit what to do instead" textarea for denial
                      notes, so users don't lose the ability to type a
                      reason. The composer's draft (`composerValue`) lives
                      in React state so unmounting the input doesn't drop
                      what the user was typing — it comes back on resolve. */}
                  {approvalQueue.length === 0 && !askUserRequest && (
                  <Composer
                    composerValue={composerValue}
                    setComposerValue={setComposerValue}
                    composerDisabled={composerDisabled}
                    isChatStreaming={isChatStreaming}
                    onSubmit={handleSendPrompt}
                    onCancel={handleCancelResponse}
                    contextFiles={contextFiles}
                    onAttachContext={handleAttachContext}
                    onRemoveContextFile={handleRemoveContextFile}
                    images={imageAttachments}
                    onPasteImages={handlePasteImages}
                    onRemoveImage={handleRemoveImageAttachment}
                    autoContextEnabled={autoContextEnabled}
                    onToggleAutoContext={handleToggleAutoContext}
                    queuedPrompts={queuedPrompts}
                    onCancelQueuedPrompt={handleCancelQueuedPrompt}
                    slashCommands={EXTENSION_SLASH_COMMANDS}
                    mentionSuggestions={mentionSuggestions}
                    onFileMentionQuery={handleFileMentionQuery}
                    onRequestSkills={handleRequestSkills}
                    voiceMicEnabled={voiceMicEnabled}
                    onMicStart={handleMicStart}
                    onMicStop={handleMicStop}
                    micState={micRecording}
                    autoApproveEdits={autoApproveEdits}
                    onToggleEditAutoApprove={handleToggleAutoApproveEdits}
                    modelLabel={modelLabel}
                    providerKind={providerKind}
                    onSelectProvider={handleSelectProvider}
                    onEditModel={handleEditModel}
                    onEditOllamaUrl={handleEditOllamaUrl}
                  />
                  )}
                </div>
              </section>
            )
          )}
          {showPlanPanel && (
            <section
              id="stealth-plan-panel"
              className="stealth-inspector"
              role={planTabsVisible ? "tabpanel" : undefined}
              aria-hidden={!showPlanPanel}
            >
              {inspectorEmpty ? (
                <div className="agent-ui-panel agent-ui-empty-state">
                  <p>No plan details yet. Start a run to populate this section.</p>
                </div>
              ) : (
                <>
                  <PlanTree
                    events={events}
                    plan={inspectorPlan ?? undefined}
                    selectedStepId={selectedStepId}
                    onSelectStep={(step) => setSelectedStepId(step.id)}
                  />
                  <PlanActivity events={events} showEmptyState={false} />
                  <PlanEvaluationCard run={inspectorRunForEvaluation} />
                  <TelemetryPanel telemetry={telemetry} />
                  <AgentConsole events={events} />
                </>
              )}
            </section>
          )}
        </div>
      )}

      <OverlayLayer
        toast={toast}
        cancelToastDismiss={cancelToastDismiss}
        scheduleToastDismiss={scheduleToastDismiss}
        dismissToast={dismissToast}
        rateLimitToast={rateLimitToast}
        onViewUsageFromToast={handleViewUsageFromToast}
        onDismissRateLimitToast={handleDismissRateLimitToast}
        usageModalOpen={usageModalOpen}
        usageSnapshot={usageSnapshot}
        usageStatus={usageStatus}
        usageError={usageError}
        onCloseUsageModal={handleCloseUsage}
        onRefreshUsage={handleRefreshUsage}
      />
    </div>
  );
}

