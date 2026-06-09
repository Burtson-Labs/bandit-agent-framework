import { useCallback, useMemo, useState } from "react";
import { useBanditTheme, type ThemePreference } from "@burtson-labs/agent-ui";
import {
  SettingsPanel,
  type McpServerEntry,
  type SettingsTab,
  type VoiceProviderSettings
} from "../../../bandit-stealth/webview/src/components/SettingsPanel";

interface WorkbenchSettingsOverlayProps {
  onClose: () => void;
}

const noop = (): void => {};

const mockMcpSnapshot: McpServerEntry[] = [
  {
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    state: "connected",
    toolCount: 12,
    trusted: true,
    activation: "always",
    providerHint: "github"
  },
  {
    name: "linear",
    command: "npx",
    args: ["-y", "@tacticlaunch/mcp-linear"],
    state: "idle",
    activation: "on-mention",
    providerHint: null
  }
];

const mockVoiceProviderSettings: VoiceProviderSettings = {
  sttProvider: "bandit",
  sttUrl: "",
  sttApiKey: "",
  sttModel: "",
  ttsProvider: "bandit",
  ttsUrl: "",
  ttsApiKey: "",
  ttsModel: "",
  ttsVoiceId: ""
};

/**
 * Mounts the real extension SettingsPanel inside the workbench sidebar
 * with mocked handlers for everything except Appearance. The theme tab
 * is wired to `useBanditTheme()` — picking a theme here repaints every
 * surface that reads `--bandit-*` CSS variables, which is the whole
 * point of having a settings preview in the workbench (verify a theme
 * change before shipping a release).
 */
export function WorkbenchSettingsOverlay({ onClose }: WorkbenchSettingsOverlayProps) {
  const { preference, setPreference, options, isAuto, theme } = useBanditTheme();
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const [providerKind, setProviderKind] = useState<"bandit" | "ollama" | "openai-compatible">(
    "bandit"
  );
  const [voiceProviderSettings, setVoiceProviderSettings] = useState(mockVoiceProviderSettings);
  const [voiceAutoSpeak, setVoiceAutoSpeak] = useState(false);
  const [voiceMic, setVoiceMic] = useState(true);
  const [planArtifacts, setPlanArtifacts] = useState(true);

  // The real extension picks "auto" → "Mirrors VS Code: <ide theme>"
  // and a manual choice → "Locked to <label>." Mirror that copy here so
  // the chip status line reads identically to the shipped panel.
  const themeStatusLabel = useMemo(() => {
    if (isAuto) {
      return `Mirrors VS Code — currently rendering as ${theme.label}.`;
    }
    return `Locked to ${theme.label}. Switch to IDE Sync to follow VS Code.`;
  }, [isAuto, theme.label]);

  const themeOptions = useMemo(
    () => options.map((option) => ({ id: option.id, label: option.label })),
    [options]
  );

  const handleSelectTheme = useCallback(
    (next: ThemePreference) => {
      setPreference(next);
    },
    [setPreference]
  );

  return (
    <SettingsPanel
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onClose={onClose}
      disableClose={false}
      accountProfile={{
        valid: true,
        firstName: "Workbench",
        lastName: "Preview",
        email: "preview@example.com",
        plan: "team",
        credits: 1_000_000,
        maskedKey: "bai_••••••••••preview"
      }}
      accountProfileStatus="idle"
      accountProfileError={null}
      onRefreshAccountProfile={noop}
      onOpenUsage={noop}
      apiKeyDraft=""
      apiKeyInputType="password"
      apiKeyInputValue=""
      onApiKeyChange={noop}
      onApiKeyFocus={noop}
      onSaveApiKey={noop}
      onClearApiKey={noop}
      onSignInWithBurtson={noop}
      hasStoredApiKey={true}
      maskStoredKey={true}
      setMaskStoredKey={noop}
      ollamaBaseUrlDraft="http://localhost:11434"
      onOllamaBaseUrlChange={noop}
      onSaveOllamaBaseUrl={noop}
      onResetOllamaBaseUrl={noop}
      ollamaAuthDraft=""
      onOllamaAuthChange={noop}
      onSaveOllamaAuth={noop}
      onClearOllamaAuth={noop}
      hasOllamaAuthToken={false}
      extensionVersion="workbench"
      providerKind={providerKind}
      onSelectProvider={setProviderKind}
      onOpenSettings={noop}
      themePreference={preference}
      themeOptions={themeOptions}
      onSelectTheme={handleSelectTheme}
      themeStatusLabel={themeStatusLabel}
      planArtifactsEnabled={planArtifacts}
      onTogglePlanArtifacts={() => setPlanArtifacts((v) => !v)}
      feedbackPromptEnabled={true}
      onToggleFeedback={noop}
      developerMode={false}
      skipValidationInDev={false}
      onToggleSkipValidationInDev={noop}
      toolUseEnabled={true}
      onToggleToolUse={noop}
      createBranchBeforeRun={false}
      onToggleCreateBranchBeforeRun={noop}
      voiceAutoSpeakPref={voiceAutoSpeak}
      voiceMicPref={voiceMic}
      onToggleVoiceAutoSpeak={() => setVoiceAutoSpeak((v) => !v)}
      onToggleVoiceMic={() => setVoiceMic((v) => !v)}
      voiceProviderSettings={voiceProviderSettings}
      onUpdateVoiceProviderSetting={(key, value) =>
        setVoiceProviderSettings((prev) => ({ ...prev, [key]: value }))
      }
      requireKey={false}
      mcpSnapshot={mockMcpSnapshot}
      onMcpReload={noop}
      onMcpReconnect={noop}
      onMcpDisconnect={noop}
      onMcpRevokeTrust={noop}
      onMcpToggleActivation={noop}
      onMcpAddGitHub={noop}
      onMcpAddSlack={noop}
      onMcpAddGitLab={noop}
      onMcpAddCustom={noop}
      tavilyKeyDraft=""
      onTavilyKeyChange={noop}
      onSaveTavilyKey={noop}
      onClearTavilyKey={noop}
      hasTavilyKey={false}
    />
  );
}
