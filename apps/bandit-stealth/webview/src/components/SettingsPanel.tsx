import { useRef, type JSX, type KeyboardEvent } from "react";
import clsx from "clsx";
import type {
  Cog6ToothIcon} from "@heroicons/react/24/outline";
import {
  ArrowLeftIcon,
  BriefcaseIcon,
  CheckBadgeIcon,
  PuzzlePieceIcon,
  ServerStackIcon,
  SpeakerWaveIcon,
  SwatchIcon,
  UserCircleIcon
} from "@heroicons/react/24/outline";
import { type ThemePreference } from "@burtson-labs/agent-ui";
import { AccountProfileCard } from "./AccountProfileCard";
import { McpProviderIcon } from "./McpProviderIcon";
import type { AccountProfile, AccountProfileStatus } from "../types/webview";

export type SettingsTab = "account" | "providers" | "connections" | "voice" | "preferences" | "appearance";

type SttProvider = "bandit" | "openai-whisper" | "custom";
type TtsProvider = "bandit" | "openai" | "elevenlabs" | "piper" | "custom";

export interface VoiceProviderSettings {
  sttProvider: SttProvider;
  sttUrl: string;
  sttApiKey: string;
  sttModel: string;
  ttsProvider: TtsProvider;
  ttsUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoiceId: string;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  state: "idle" | "connecting" | "connected" | "error" | "disabled";
  toolCount?: number;
  errorMessage?: string;
  /** Server's fingerprint is in ~/.bandit/mcp-trust.json — when true,
   * the panel exposes a "Revoke trust" link. */
  trusted?: boolean;
  /** Activation mode pushed by the host so the UI can render a badge
   * + a toggle. Mirrors McpServerConfig.activation. */
  activation?: "always" | "on-mention";
  /** Provider hint inferred from the server name — drives the icon
   * rendered on the Connections card. */
  providerHint?: string | null;
}

interface SettingsPanelProps {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  onClose: () => void;
  disableClose?: boolean;
  accountProfile: AccountProfile | null;
  accountProfileStatus: AccountProfileStatus;
  accountProfileError: string | null;
  onRefreshAccountProfile: () => void;
  onOpenUsage: () => void;
  apiKeyDraft: string;
  apiKeyInputType: string;
  apiKeyInputValue: string;
  onApiKeyChange: (value: string) => void;
  onApiKeyFocus: () => void;
  onSaveApiKey: () => void;
  onClearApiKey: () => void;
  onSignInWithBurtson: () => void;
  hasStoredApiKey: boolean;
  maskStoredKey: boolean;
  setMaskStoredKey: (value: boolean) => void;
  ollamaBaseUrlDraft: string;
  onOllamaBaseUrlChange: (value: string) => void;
  onSaveOllamaBaseUrl: () => void;
  onResetOllamaBaseUrl: () => void;
  ollamaAuthDraft: string;
  onOllamaAuthChange: (value: string) => void;
  onSaveOllamaAuth: () => void;
  onClearOllamaAuth: () => void;
  hasOllamaAuthToken: boolean;
  extensionVersion: string;
  providerKind: "bandit" | "ollama" | "openai-compatible";
  onSelectProvider: (value: "bandit" | "ollama" | "openai-compatible") => void;
  onOpenSettings: (query: string) => void;
  themePreference: ThemePreference;
  themeOptions: ReadonlyArray<{ id: string; label: string }>;
  onSelectTheme: (preference: ThemePreference) => void;
  themeStatusLabel: string;
  planArtifactsEnabled: boolean;
  onTogglePlanArtifacts: () => void;
  feedbackPromptEnabled: boolean;
  onToggleFeedback: () => void;
  developerMode: boolean;
  skipValidationInDev: boolean;
  onToggleSkipValidationInDev: () => void;
  toolUseEnabled: boolean;
  onToggleToolUse: () => void;
  createBranchBeforeRun: boolean;
  onToggleCreateBranchBeforeRun: () => void;
  voiceAutoSpeakPref: boolean;
  voiceMicPref: boolean;
  onToggleVoiceAutoSpeak: () => void;
  onToggleVoiceMic: () => void;
  voiceProviderSettings: VoiceProviderSettings;
  onUpdateVoiceProviderSetting: (key: keyof VoiceProviderSettings, value: string) => void;
  requireKey: boolean;
  brandLogoSrc?: string;
  mcpSnapshot: McpServerEntry[];
  onMcpReload: () => void;
  onMcpReconnect: (name: string) => void;
  onMcpDisconnect: (name: string) => void;
  onMcpRevokeTrust: (name: string) => void;
  onMcpToggleActivation: (name: string, next: "always" | "on-mention") => void;
  onMcpAddGitHub: () => void;
  onMcpAddSlack: () => void;
  onMcpAddGitLab: () => void;
  onMcpAddCustom: () => void;
  // Tavily web-search BYOK. Stored as a global VS Code setting; the
  // extension's chat engine reads it at registry-build time so a save
  // is picked up by the next turn without restarting the host.
  tavilyKeyDraft: string;
  onTavilyKeyChange: (value: string) => void;
  onSaveTavilyKey: () => void;
  onClearTavilyKey: () => void;
  hasTavilyKey: boolean;
}

interface SettingsTabDef {
  id: SettingsTab;
  label: string;
  Icon: typeof Cog6ToothIcon;
}

// Tabs render as icon + label and wrap onto a second row in a narrow
// side bar, the way the desktop IDE's settings rail does. (They were
// icon-only, which made users hover each one to find a section.) The
// Account tab is filtered at render time when the provider isn't Bandit.
export const SETTINGS_TABS: SettingsTabDef[] = [
  { id: "account", label: "Account", Icon: UserCircleIcon },
  { id: "providers", label: "Providers", Icon: ServerStackIcon },
  { id: "connections", label: "Connections", Icon: PuzzlePieceIcon },
  { id: "voice", label: "Voice", Icon: SpeakerWaveIcon },
  { id: "preferences", label: "Workspace", Icon: BriefcaseIcon },
  { id: "appearance", label: "Appearance", Icon: SwatchIcon }
];

export function SettingsPanel({
  activeTab,
  onSelectTab,
  onClose,
  disableClose,
  accountProfile,
  accountProfileStatus,
  accountProfileError,
  onRefreshAccountProfile,
  onOpenUsage,
  apiKeyDraft,
  apiKeyInputType,
  apiKeyInputValue,
  onApiKeyChange,
  onApiKeyFocus,
  onSaveApiKey,
  onClearApiKey,
  onSignInWithBurtson,
  hasStoredApiKey,
  maskStoredKey,
  setMaskStoredKey: _setMaskStoredKey,
  ollamaBaseUrlDraft,
  onOllamaBaseUrlChange,
  onSaveOllamaBaseUrl,
  onResetOllamaBaseUrl,
  ollamaAuthDraft,
  onOllamaAuthChange,
  onSaveOllamaAuth,
  onClearOllamaAuth,
  hasOllamaAuthToken,
  extensionVersion,
  providerKind,
  onSelectProvider,
  onOpenSettings,
  themePreference,
  themeOptions,
  onSelectTheme,
  themeStatusLabel,
  planArtifactsEnabled,
  onTogglePlanArtifacts,
  feedbackPromptEnabled: _feedbackPromptEnabled,
  onToggleFeedback: _onToggleFeedback,
  developerMode,
  skipValidationInDev,
  onToggleSkipValidationInDev,
  toolUseEnabled: _toolUseEnabled,
  onToggleToolUse: _onToggleToolUse,
  createBranchBeforeRun: _createBranchBeforeRun,
  onToggleCreateBranchBeforeRun: _onToggleCreateBranchBeforeRun,
  voiceAutoSpeakPref,
  voiceMicPref,
  voiceProviderSettings,
  onUpdateVoiceProviderSetting,
  onToggleVoiceAutoSpeak,
  onToggleVoiceMic,
  requireKey,
  brandLogoSrc,
  mcpSnapshot,
  onMcpReload,
  onMcpReconnect,
  onMcpDisconnect,
  onMcpRevokeTrust,
  onMcpToggleActivation,
  onMcpAddGitHub,
  onMcpAddSlack,
  onMcpAddGitLab,
  onMcpAddCustom,
  tavilyKeyDraft,
  onTavilyKeyChange,
  onSaveTavilyKey,
  onClearTavilyKey,
  hasTavilyKey
}: SettingsPanelProps): JSX.Element {
  const canSaveKey = !maskStoredKey && apiKeyDraft.trim().length > 0;
  // Hide the Account tab when the active provider isn't Bandit — that tab
  // is purely Bandit-cloud state (profile, credits, API key).
  const visibleTabs = SETTINGS_TABS.filter((tab) => tab.id !== "account" || providerKind === "bandit");
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());

  // WAI-ARIA tabs keyboard model: arrows move between tabs (wrapping),
  // Home/End jump to the ends. Selection follows focus.
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = visibleTabs.findIndex((tab) => tab.id === activeTab);
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {next = (index + 1) % visibleTabs.length;}
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {next = (index - 1 + visibleTabs.length) % visibleTabs.length;}
    else if (event.key === "Home") {next = 0;}
    else if (event.key === "End") {next = visibleTabs.length - 1;}
    if (next < 0) {return;}
    event.preventDefault();
    const target = visibleTabs[next];
    onSelectTab(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  const renderAppearance = (): JSX.Element => (
    <div className="settings-card">
      <h3>Appearance</h3>
      <p className="settings-note">Mirror VS Code automatically or force a specific Bandit theme.</p>
      <div className="theme-options">
        {themeOptions.map((option) => (
          <button
            type="button"
            key={option.id}
            className={clsx("theme-chip", themePreference === option.id && "is-active")}
            onClick={() => onSelectTheme(option.id as ThemePreference)}
          >
            <span>{option.label}</span>
            {option.id === "auto" && <span className="theme-chip__badge">Auto</span>}
          </button>
        ))}
      </div>
      <p className="settings-note theme-note">{themeStatusLabel}</p>
    </div>
  );

  const renderVoice = (): JSX.Element => {
    const v = voiceProviderSettings;
    const sttUsesUrl = v.sttProvider === "openai-whisper" || v.sttProvider === "custom";
    const ttsUsesUrl = v.ttsProvider !== "bandit";
    const ttsUsesModel = v.ttsProvider === "openai" || v.ttsProvider === "elevenlabs";
    return (
      <>
      <div className="settings-card">
        <h3>Voice toggles</h3>
        <p className="settings-note">
          Mic button in the composer + automatic read-aloud of assistant replies. Provider for both is configured below.
        </p>
        <div className="settings-preference">
          <div>
            <p>Auto-speak responses</p>
            <p className="settings-note">
              Read short (≤120 word) responses aloud automatically. The speaker icon on each message plays longer ones on demand.
            </p>
          </div>
          <button
            type="button"
            className={voiceAutoSpeakPref ? "stealth-button" : "stealth-button stealth-button--ghost"}
            onClick={onToggleVoiceAutoSpeak}
          >
            {voiceAutoSpeakPref ? "Disable" : "Enable"}
          </button>
        </div>
        <div className="settings-preference">
          <div>
            <p>Microphone input</p>
            <p className="settings-note">
              Show the mic button in the composer for voice prompts. Routed through the STT provider below.
            </p>
          </div>
          <button
            type="button"
            className={voiceMicPref ? "stealth-button" : "stealth-button stealth-button--ghost"}
            onClick={onToggleVoiceMic}
          >
            {voiceMicPref ? "Disable" : "Enable"}
          </button>
        </div>
      </div>
      <div className="settings-card">
        <h3>Speech-to-text</h3>
        <p className="settings-note">
          The microphone in the composer transcribes through this provider. "Follow chat
          provider" uses Bandit Cloud only while chat is on Bandit Cloud; with Ollama or an
          OpenAI-compatible server, audio is never sent to Bandit Cloud.
        </p>
        <div className="settings-field">
          <label htmlFor="voice-stt-provider">Provider</label>
          <select
            id="voice-stt-provider"
            value={v.sttProvider}
            onChange={(e) => onUpdateVoiceProviderSetting("sttProvider", e.target.value)}
          >
            <option value="auto">Follow chat provider</option>
            <option value="bandit">Bandit cloud (only with Bandit Cloud chat)</option>
            <option value="openai-whisper">OpenAI-compatible Whisper</option>
            <option value="custom">Custom URL</option>
          </select>
          <p className="settings-note" style={{ marginTop: "0.35rem" }}>
            {v.sttProvider === "auto"
              ? "Bandit Cloud while chat uses Bandit Cloud; otherwise off until you pick a local Whisper server."
              : v.sttProvider === "bandit"
              ? "Routes through the Bandit gateway, and only while chat uses Bandit Cloud. Needs a Bandit API key (Account tab)."
              : v.sttProvider === "openai-whisper"
                ? "Works with OpenAI, LiteLLM, faster-whisper-server, whisper.cpp HTTP, vLLM-Whisper, etc."
                : "Multipart audio in, JSON { text } out. Bring any URL."}
          </p>
        </div>
        {sttUsesUrl && (
          <>
            <div className="settings-field">
              <label htmlFor="voice-stt-url">Endpoint URL</label>
              <input
                id="voice-stt-url"
                type="text"
                value={v.sttUrl}
                placeholder="https://api.openai.com/v1/audio/transcriptions"
                onChange={(e) => onUpdateVoiceProviderSetting("sttUrl", e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="voice-stt-key">API key (optional)</label>
              <input
                id="voice-stt-key"
                type="password"
                value={v.sttApiKey}
                placeholder="Bearer token sent as Authorization header"
                onChange={(e) => onUpdateVoiceProviderSetting("sttApiKey", e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="voice-stt-model">Model name</label>
              <input
                id="voice-stt-model"
                type="text"
                value={v.sttModel}
                placeholder="whisper-1"
                onChange={(e) => onUpdateVoiceProviderSetting("sttModel", e.target.value)}
              />
            </div>
          </>
        )}

        <h3 style={{ marginTop: "1.5rem" }}>Text-to-speech</h3>
        <p className="settings-note">
          Used by auto-speak and the speaker button on each assistant message.
        </p>
        <div className="settings-field">
          <label htmlFor="voice-tts-provider">Provider</label>
          <select
            id="voice-tts-provider"
            value={v.ttsProvider}
            onChange={(e) => onUpdateVoiceProviderSetting("ttsProvider", e.target.value)}
          >
            <option value="auto">Follow chat provider</option>
            <option value="bandit">Bandit cloud (only with Bandit Cloud chat)</option>
            <option value="openai">OpenAI</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="piper">Piper (local)</option>
            <option value="custom">Custom URL</option>
          </select>
          <p className="settings-note" style={{ marginTop: "0.35rem" }}>
            {v.ttsProvider === "auto"
              ? "Bandit Cloud while chat uses Bandit Cloud; otherwise off until you pick Piper or another local server."
              : v.ttsProvider === "bandit"
              ? "Routes through the Bandit gateway, and only while chat uses Bandit Cloud. Needs a Bandit API key (Account tab)."
              : v.ttsProvider === "openai"
                ? "Hits /v1/audio/speech. Works with OpenAI, LiteLLM, any compatible proxy."
                : v.ttsProvider === "elevenlabs"
                  ? "ElevenLabs API. Needs an API key + voice id."
                  : v.ttsProvider === "piper"
                    ? "Local Piper HTTP server (POST text/plain or JSON)."
                    : "{ text, voice } in, audio bytes (or JSON { audio }) out. Bring any URL."}
          </p>
        </div>
        {ttsUsesUrl && (
          <div className="settings-field">
            <label htmlFor="voice-tts-url">{v.ttsProvider === "elevenlabs" ? "API base URL" : "Endpoint URL"}</label>
            <input
              id="voice-tts-url"
              type="text"
              value={v.ttsUrl}
              placeholder={
                v.ttsProvider === "openai"
                  ? "https://api.openai.com/v1/audio/speech"
                  : v.ttsProvider === "elevenlabs"
                    ? "https://api.elevenlabs.io"
                    : v.ttsProvider === "piper"
                      ? "http://localhost:5000/api/tts"
                      : "https://your-tts.example.com/synthesize"
              }
              onChange={(e) => onUpdateVoiceProviderSetting("ttsUrl", e.target.value)}
            />
          </div>
        )}
        {(v.ttsProvider === "openai" || v.ttsProvider === "elevenlabs" || v.ttsProvider === "custom") && (
          <div className="settings-field">
            <label htmlFor="voice-tts-key">API key</label>
            <input
              id="voice-tts-key"
              type="password"
              value={v.ttsApiKey}
              placeholder={v.ttsProvider === "elevenlabs" ? "Sent as xi-api-key header" : "Bearer token"}
              onChange={(e) => onUpdateVoiceProviderSetting("ttsApiKey", e.target.value)}
            />
          </div>
        )}
        {ttsUsesModel && (
          <div className="settings-field">
            <label htmlFor="voice-tts-model">Model</label>
            <input
              id="voice-tts-model"
              type="text"
              value={v.ttsModel}
              placeholder={v.ttsProvider === "elevenlabs" ? "eleven_monolingual_v1" : "tts-1"}
              onChange={(e) => onUpdateVoiceProviderSetting("ttsModel", e.target.value)}
            />
          </div>
        )}
        <div className="settings-field">
          <label htmlFor="voice-tts-voice">Voice</label>
          <input
            id="voice-tts-voice"
            type="text"
            value={v.ttsVoiceId}
            placeholder={
              v.ttsProvider === "openai"
                ? "alloy / echo / fable / onyx / nova / shimmer"
                : v.ttsProvider === "elevenlabs"
                  ? "ElevenLabs voice id (e.g. 21m00Tcm4TlvDq8ikWAM)"
                  : "en_US-brian-premium"
            }
            onChange={(e) => onUpdateVoiceProviderSetting("ttsVoiceId", e.target.value)}
          />
        </div>
      </div>
      </>
    );
  };

  const renderPreferences = (): JSX.Element => (
    <div className="settings-card">
      <h3>Workspace preferences</h3>
      <div className="settings-preference">
        <div>
          <p>Plan artifacts</p>
          <p className="settings-note">
            Save per-run plan JSON and reports to <code>.bandit/plans</code>. Disable to keep the
            workspace clean.
          </p>
        </div>
        <button type="button" className="stealth-button stealth-button--ghost" onClick={onTogglePlanArtifacts}>
          {planArtifactsEnabled ? "Disable" : "Enable"}
        </button>
      </div>
      {/* "Tool use loop" toggle removed in v1.7.64 — disabling it dropped
         the agent into a one-shot text completion with NO tool access
         (no read/write/search), which made the agent functionally
         broken while looking like a perf knob. The setting still exists
         in package.json so power users with a banditStealth.enableToolUse
         override in settings.json keep their behaviour, but we no
         longer surface a UI button labeled "Disable" next to "the
         agent's reason for existing." */}
      {developerMode && (
        <div className="settings-preference">
          <div>
            <p>Skip validations in dev</p>
            <p className="settings-note">
              Bypass TypeScript and package validation while running the extension from source.
            </p>
          </div>
          <button
            type="button"
            className="stealth-button stealth-button--ghost"
            onClick={onToggleSkipValidationInDev}
          >
            {skipValidationInDev ? "Disable" : "Enable"}
          </button>
        </div>
      )}
    </div>
  );

  const renderAccount = (): JSX.Element => (
    <div className="settings-card-grid">
      <AccountProfileCard
        profile={accountProfile}
        status={accountProfileStatus}
        error={accountProfileError}
        onRefresh={onRefreshAccountProfile}
      />
      <div className="settings-card">
        <div className="settings-preference">
          <div>
            <h3>Usage</h3>
            <p className="settings-note">
              Session (5-hour) and weekly (7-day) limits for Bandit cloud.
            </p>
          </div>
          <button type="button" className="stealth-button stealth-button--ghost" onClick={onOpenUsage}>
            View usage
          </button>
        </div>
      </div>
      <div className="settings-card">
        <h3>Bandit Cloud sign-in</h3>
        <p className="settings-note">
          {hasStoredApiKey
            ? "Signed in. The device key is in VS Code secret storage; revoke it from your Burtson Labs account page."
            : "Sign in with your Burtson Labs account. A device key is issued and kept in VS Code secret storage."}
        </p>
        {!hasStoredApiKey && (
          <div className="settings-actions">
            <button type="button" className="stealth-button" onClick={onSignInWithBurtson}>
              Sign in with Burtson Labs
            </button>
          </div>
        )}
        <details className="settings-details">
          <summary>Paste an API key instead</summary>
          <div className="settings-details__body">
            <p className="settings-note">For users who already have a Bandit Cloud key — keys are stored in VS Code secret storage on this device.</p>
            <div className="settings-input-row">
              <input
                type={apiKeyInputType}
                value={apiKeyInputValue}
                onChange={(event) => onApiKeyChange(event.target.value)}
                onFocus={onApiKeyFocus}
                placeholder="bai_..."
                autoComplete="off"
              />
              {hasStoredApiKey && !requireKey && (
                <span className="api-key-status" data-has-tooltip="true" data-tooltip="Key saved in VS Code secret storage">
                  <CheckBadgeIcon aria-hidden="true" />
                  Saved
                </span>
              )}
              {hasStoredApiKey && (
                <button
                  type="button"
                  className="stealth-button stealth-button--ghost stealth-button--danger"
                  onClick={onClearApiKey}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="stealth-button stealth-button--ghost"
                onClick={onSaveApiKey}
                disabled={!canSaveKey}
              >
                Save
              </button>
            </div>
          </div>
        </details>
      </div>

    </div>
  );

  const renderProviders = (): JSX.Element => (
    <div className="settings-card-grid">
      <div className="settings-card">
        <h3>Active Provider</h3>
        <p className="settings-note">Switch between the Bandit cloud API and a local / remote Ollama endpoint. Provider-specific settings live below.</p>
        <div className="provider-switcher" role="radiogroup" aria-label="Active provider">
          <button
            type="button"
            role="radio"
            aria-checked={providerKind === "bandit"}
            className={clsx("provider-switcher__option", providerKind === "bandit" && "is-active")}
            onClick={() => providerKind !== "bandit" && onSelectProvider("bandit")}
          >
            <span className="provider-switcher__label">Bandit AI</span>
            <span className="provider-switcher__sub">Cloud · api.burtson.ai</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={providerKind === "ollama"}
            className={clsx("provider-switcher__option", providerKind === "ollama" && "is-active")}
            onClick={() => providerKind !== "ollama" && onSelectProvider("ollama")}
          >
            <span className="provider-switcher__label">Ollama</span>
            <span className="provider-switcher__sub">Local or remote</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={providerKind === "openai-compatible"}
            className={clsx("provider-switcher__option", providerKind === "openai-compatible" && "is-active")}
            onClick={() => providerKind !== "openai-compatible" && onSelectProvider("openai-compatible")}
          >
            <span className="provider-switcher__label">OpenAI-compatible</span>
            <span className="provider-switcher__sub">LM Studio, OpenRouter, Together, Groq…</span>
          </button>
        </div>
      </div>

      {providerKind === "bandit" && (
        <div className="settings-card settings-card--muted">
          <h3>Bandit Cloud</h3>
          <p className="settings-note">Your API key and account info live on the Account tab.</p>
        </div>
      )}

      {providerKind === "ollama" && (
        <div className="settings-card">
          <h3>Ollama Endpoint</h3>
          <p className="settings-note">Base URL + optional Bearer token for authenticated reverse proxies. Tokens are stored in VS Code secret storage.</p>
          <label className="settings-inline-label" htmlFor="ollama-base-url">Base URL</label>
          <div className="settings-input-row">
            <input
              id="ollama-base-url"
              type="text"
              value={ollamaBaseUrlDraft}
              onChange={(event) => onOllamaBaseUrlChange(event.target.value)}
              placeholder="http://localhost:11434"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onSaveOllamaBaseUrl}
            >
              Save
            </button>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onResetOllamaBaseUrl}
              title="Reset to http://localhost:11434"
            >
              Use default
            </button>
          </div>
          <label className="settings-inline-label" htmlFor="ollama-auth-token">Auth Token (Bearer)</label>
          <div className="settings-input-row">
            <input
              id="ollama-auth-token"
              type="password"
              value={ollamaAuthDraft}
              onChange={(event) => onOllamaAuthChange(event.target.value)}
              placeholder={hasOllamaAuthToken ? "•••••••• (stored)" : "Paste token — stored securely"}
              autoComplete="off"
            />
            {hasOllamaAuthToken && (
              <span className="api-key-status" data-has-tooltip="true" data-tooltip="Token saved in VS Code secret storage">
                <CheckBadgeIcon aria-hidden="true" />
                Saved
              </span>
            )}
            {hasOllamaAuthToken && (
              <button
                type="button"
                className="stealth-button stealth-button--ghost stealth-button--danger"
                onClick={onClearOllamaAuth}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onSaveOllamaAuth}
              disabled={ollamaAuthDraft.trim().length === 0}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {providerKind === "openai-compatible" && (
        <div className="settings-card">
          <h3>OpenAI-compatible upstream</h3>
          <p className="settings-note">
            Talk to any OpenAI-compatible endpoint — LM Studio, llama.cpp, vLLM, OpenRouter, Together, Groq, DeepSeek, xAI, OpenAI itself, or your own server.
            Configuration lives in workspace settings under <code>banditStealth.openai*</code>:
          </p>
          <ul className="settings-note" style={{ marginTop: "0.25rem", marginBottom: "0.75rem", paddingLeft: "1.25rem", lineHeight: 1.7 }}>
            <li><code>openaiBaseUrl</code> — e.g. <code>http://localhost:1234/v1</code> (LM Studio), <code>https://api.together.xyz/v1</code></li>
            <li><code>openaiModel</code> — provider-specific id (e.g. <code>meta-llama/Llama-3.3-70B-Instruct-Turbo</code>)</li>
            <li><code>openaiApiKey</code> — bearer token (local servers usually skip this)</li>
            <li><code>openaiHeaders</code> — optional extra headers (OpenRouter attribution, custom org IDs, etc.)</li>
          </ul>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="stealth-button"
              onClick={() => onOpenSettings("banditStealth.openai")}
            >
              Open settings
            </button>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={() => onOpenSettings("banditStealth.provider")}
              title="Switch back to Ollama or Bandit Cloud"
            >
              Change provider
            </button>
          </div>
          <p className="settings-note" style={{ marginTop: "0.75rem", fontSize: "0.85em" }}>
            Tip: the CLI ships a guided <code>/connect</code> wizard with one-click presets for the major upstreams. Run it from a terminal: <code>bandit /connect</code>.
          </p>
        </div>
      )}
    </div>
  );

  const renderConnections = (): JSX.Element => (
    <div className="settings-section">
      <div className="settings-card">
        <h3>MCP servers</h3>
        <p className="settings-note">
          Bandit speaks MCP (Model Context Protocol) as a client. Configure servers in <code>~/.bandit/mcp-servers.json</code> or <code>.bandit/mcp-servers.json</code> (workspace, takes precedence). Each server's tools surface as <code>{"<server>.<tool>"}</code> alongside the built-in <code>read_file</code> / <code>apply_edit</code>.
        </p>
        <div style={{ marginBottom: "0.75rem" }}>
          <p className="settings-note" style={{ marginBottom: "0.5rem" }}>Add a connector — guided setup, no JSON editing:</p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onMcpAddGitHub}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
            >
              <McpProviderIcon provider="github" />
              <span>+ GitHub</span>
            </button>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onMcpAddGitLab}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
              title="GitLab.com or self-hosted — paste a personal access token"
            >
              <McpProviderIcon provider="gitlab" />
              <span>+ GitLab</span>
            </button>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onMcpAddSlack}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
              title="Slack — paste a Bot User OAuth Token + workspace ID"
            >
              <McpProviderIcon provider="slack" />
              <span>+ Slack</span>
            </button>
            <button
              type="button"
              className="stealth-button stealth-button--ghost"
              onClick={onMcpAddCustom}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
              title="Any MCP server (Linear, Jira, Bitbucket, Sentry, Postgres, internal tooling) — provide command + env vars"
            >
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, fontWeight: 700, fontSize: "0.78rem" }}>+</span>
              <span>Custom</span>
            </button>
            <span
              className="stealth-button stealth-button--ghost"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", opacity: 0.5, cursor: "not-allowed" }}
              title="Coming soon — Google OAuth wizard (Gmail / Drive / Calendar). Use + Custom for now."
            >
              <McpProviderIcon provider="google" />
              <span>Google (soon)</span>
            </span>
            <span
              className="stealth-button stealth-button--ghost"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", opacity: 0.5, cursor: "not-allowed" }}
              title="Coming soon — Microsoft OAuth wizard (Outlook / Teams / OneDrive). Use + Custom for now."
            >
              <McpProviderIcon provider="microsoft" />
              <span>Microsoft (soon)</span>
            </span>
          </div>
          <p className="settings-note" style={{ marginTop: "0.4rem", fontSize: "0.75rem" }}>
            Linear / Jira / Bitbucket / Sentry / Postgres etc. work today via <strong>+ Custom</strong> — paste the package name and your token.
          </p>
        </div>
        <div className="settings-actions settings-actions--end" style={{ marginBottom: "0.75rem" }}>
          <button
            type="button"
            className="stealth-button stealth-button--ghost"
            onClick={onMcpReload}
            title="Re-read mcp-servers.json from disk"
          >
            Reload from disk
          </button>
        </div>
        {mcpSnapshot.length === 0 ? (
          <p className="settings-note">
            No servers configured. Drop a <code>mcp-servers.json</code> file at <code>~/.bandit/</code> or <code>.bandit/</code>, then click <strong>Reload from disk</strong>.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {mcpSnapshot.map((s) => {
              const stateColor =
                s.state === "connected" ? "var(--agent-ui-success, #34d399)" :
                s.state === "error" ? "var(--agent-ui-error, #f87171)" :
                s.state === "connecting" ? "var(--agent-ui-warn, #facc15)" :
                "var(--agent-ui-text-dim)";
              const stateLabel =
                s.state === "connected" ? `connected · ${s.toolCount ?? 0} tool${s.toolCount === 1 ? "" : "s"}` :
                s.state === "error" ? `error: ${s.errorMessage ?? "unknown"}` :
                s.state === "connecting" ? "connecting…" :
                s.state === "disabled" ? "disabled" :
                "idle (lazy connect)";
              return (
                <div
                  key={s.name}
                  style={{
                    border: "1px solid var(--agent-ui-card-border)",
                    borderRadius: 8,
                    padding: "0.75rem 0.85rem",
                    background: "var(--agent-ui-card-bg)"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: stateColor, flexShrink: 0 }} />
                        <span style={{ display: "inline-flex", color: "var(--agent-ui-text-muted)", flexShrink: 0 }}>
                          <McpProviderIcon provider={s.providerHint} />
                        </span>
                        <strong style={{ fontFamily: "ui-monospace, monospace" }}>{s.name}</strong>
                        <span
                          style={{
                            fontSize: "0.7rem",
                            padding: "0.1rem 0.45rem",
                            borderRadius: 999,
                            border: "1px solid var(--agent-ui-card-border)",
                            color: "var(--agent-ui-text-dim)",
                            cursor: "pointer",
                            userSelect: "none"
                          }}
                          title={
                            (s.activation ?? "always") === "always"
                              ? "Active every prompt — click to switch to on-mention (only registers when triggers match the prompt)"
                              : "Only registers when prompt mentions trigger keywords — click to switch to always-on"
                          }
                          onClick={() => onMcpToggleActivation(s.name, (s.activation ?? "always") === "always" ? "on-mention" : "always")}
                        >
                          {(s.activation ?? "always") === "always" ? "always" : "on-mention"}
                        </span>
                      </div>
                      <span style={{ fontSize: "0.78rem", color: "var(--agent-ui-text-dim)" }}>{stateLabel}</span>
                      <code style={{ fontSize: "0.72rem", color: "var(--agent-ui-text-dim)", overflowWrap: "anywhere" }}>
                        {s.command}{s.args.length > 0 ? " " + s.args.join(" ") : ""}
                      </code>
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0, alignItems: "center", flexWrap: "wrap" }}>
                      {s.trusted && (
                        <button
                          type="button"
                          className="stealth-button stealth-button--ghost stealth-button--danger"
                          onClick={() => onMcpRevokeTrust(s.name)}
                          title="Remove this server from ~/.bandit/mcp-trust.json — next spawn will re-prompt for approval"
                        >
                          Revoke trust
                        </button>
                      )}
                      {s.state === "connected" || s.state === "connecting" ? (
                        <button
                          type="button"
                          className="stealth-button stealth-button--ghost"
                          onClick={() => onMcpDisconnect(s.name)}
                        >
                          Disconnect
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="stealth-button stealth-button--ghost"
                          onClick={() => onMcpReconnect(s.name)}
                          disabled={s.state === "disabled"}
                        >
                          Connect
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="settings-card">
        <h3>Tavily web search (BYOK)</h3>
        <p className="settings-note">
          Bandit's <code>web_search</code> tool is backed by{" "}
          <a href="https://tavily.com" target="_blank" rel="noopener noreferrer">Tavily</a>
          {" "}— purpose-built for LLM agents, returns ranked snippets instead of raw HTML.
          Free tier covers casual use. Paste your key below and the next turn picks it up; until
          then the tool returns "not configured" and the agent falls back to <code>web_fetch</code>
          {" "}with a known URL.
        </p>
        <label className="settings-inline-label" htmlFor="tavily-api-key">API Key</label>
        <div className="settings-input-row">
          <input
            id="tavily-api-key"
            type="password"
            value={tavilyKeyDraft}
            onChange={(event) => onTavilyKeyChange(event.target.value)}
            placeholder={hasTavilyKey ? "•••••••• (stored)" : "tvly-... (paste your key)"}
            autoComplete="off"
          />
          {hasTavilyKey && (
            <span className="api-key-status" data-has-tooltip="true" data-tooltip="Saved as banditStealth.webSearch.tavilyApiKey (global settings)">
              <CheckBadgeIcon aria-hidden="true" />
              Saved
            </span>
          )}
          {hasTavilyKey && (
            <button
              type="button"
              className="stealth-button stealth-button--ghost stealth-button--danger"
              onClick={onClearTavilyKey}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="stealth-button stealth-button--ghost"
            onClick={onSaveTavilyKey}
            disabled={tavilyKeyDraft.trim().length === 0}
          >
            Save
          </button>
        </div>
        <p className="settings-note" style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
          Per-shell override: set <code>TAVILY_API_KEY</code> in your environment — env always wins over the saved setting.
        </p>
      </div>
    </div>
  );

  const tabContent =
    activeTab === "account"
      ? renderAccount()
      : activeTab === "providers"
        ? renderProviders()
        : activeTab === "connections"
          ? renderConnections()
          : activeTab === "voice"
            ? renderVoice()
            : activeTab === "preferences"
              ? renderPreferences()
              : renderAppearance();

  return (
    <section className="settings-panel" aria-label="Settings">
      <header className="settings-panel__header">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          disabled={disableClose}
          aria-label="Back to conversation"
          title="Back to conversation"
        >
          <ArrowLeftIcon aria-hidden="true" />
        </button>
        <h2>Settings</h2>
      </header>
      {requireKey && (
        <div className="settings-panel__notice">
          <p>Connect a valid API key to continue using Bandit Stealth.</p>
        </div>
      )}
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={handleTabKeyDown}
      >
        {visibleTabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) {tabRefs.current.set(tab.id, node);}
                else {tabRefs.current.delete(tab.id);}
              }}
              id={`settings-tab-${tab.id}`}
              type="button"
              className={clsx("settings-tab", selected && "is-active")}
              role="tab"
              aria-selected={selected}
              aria-controls="settings-tabpanel"
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
            >
              <tab.Icon aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div
        className="settings-panel__content"
        id="settings-tabpanel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {tabContent}
      </div>
      <footer className="settings-panel__footer">
        {brandLogoSrc && (
          <img src={brandLogoSrc} alt="" className="settings-panel__footer-logo" decoding="async" loading="lazy" />
        )}
        <span>
          Bandit Stealth{extensionVersion ? ` ${extensionVersion}` : ""} · Burtson Labs
        </span>
      </footer>
    </section>
  );
}
