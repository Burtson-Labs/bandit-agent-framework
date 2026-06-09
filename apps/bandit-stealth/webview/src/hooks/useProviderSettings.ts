import { useCallback, useState } from "react";
import type { WebviewState } from "../types/webview";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_BANDIT_MODEL = "bandit-core-1";
const DEFAULT_OLLAMA_MODEL = "gemma4:12b";

export type ProviderKind = "bandit" | "ollama" | "openai-compatible";
export type OllamaStatus = "ready" | "offline" | "no-model" | "unknown";

export interface ProviderSettingsHook {
  // ── state ───────────────────────────────────────────────────────
  providerKind: ProviderKind;
  providerLabel: string;
  banditModelName: string;
  ollamaModelName: string;
  /**
   * Display string for the model picker chip in the composer footer.
   * Tracks the active provider's model name; updates when the
   * provider switches.
   */
  modelLabel: string;
  ollamaBaseUrlDraft: string;
  ollamaAuthDraft: string;
  hasOllamaAuthToken: boolean;
  ollamaStatus: OllamaStatus;
  /**
   * When set, the chat-feed landing screen shows the
   * `ollama pull <name>` recovery command. Driven by the extension's
   * health probe — it only sets this when the active model is
   * configured but missing.
   */
  ollamaModelMissing: string | undefined;

  // ── controlled-input setters (used by SettingsPanel's textboxes) ─
  setOllamaBaseUrlDraft: (value: string) => void;
  setOllamaAuthDraft: (value: string) => void;

  // ── user actions ────────────────────────────────────────────────
  /** User picked a provider — flips state + posts setProvider; no-op on same provider. */
  handleSelectProvider: (value: ProviderKind) => void;
  /** Open the extension's input box to edit the active model name. */
  handleEditModel: () => void;
  /** Open the extension's input box to edit the Ollama base URL. */
  handleEditOllamaUrl: () => void;
  /** Persist the Ollama base URL draft (whitespace trimmed). */
  handleSaveOllamaBaseUrl: () => void;
  /** Restore the default Ollama base URL and post it. */
  handleResetOllamaBaseUrl: () => void;
  /** Persist the Ollama auth-token draft if non-empty, then clear the draft. */
  handleSaveOllamaAuth: () => void;
  /** Drop the persisted Ollama auth token and clear the draft. */
  handleClearOllamaAuth: () => void;

  /**
   * Apply the provider slice of a boot/state-sync WebviewState message.
   * Replaces every provider-related slot in one go.
   */
  applyStateSnapshot: (state: WebviewState) => void;
}

/**
 * Provider/model selection surface — the chat-header chip's source of
 * truth, the SettingsPanel's "Providers" tab state, and the Ollama
 * health/auth signals that drive the landing screen + the auth toast.
 *
 * The hook owns the read state + the trivial outbound wire messages;
 * the extension is the canonical source of provider/model truth and
 * will broadcast a state message back as confirmation.
 */
export function useProviderSettings(): ProviderSettingsHook {
  const [providerLabel, setProviderLabel] = useState("Ollama");
  const [providerKind, setProviderKind] = useState<ProviderKind>("ollama");
  const [banditModelName, setBanditModelName] = useState(DEFAULT_BANDIT_MODEL);
  const [ollamaModelName, setOllamaModelName] = useState(DEFAULT_OLLAMA_MODEL);
  const [modelLabel, setModelLabel] = useState(DEFAULT_OLLAMA_MODEL);
  const [ollamaBaseUrlDraft, setOllamaBaseUrlDraft] = useState("");
  const [ollamaAuthDraft, setOllamaAuthDraft] = useState("");
  const [hasOllamaAuthToken, setHasOllamaAuthToken] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>("unknown");
  const [ollamaModelMissing, setOllamaModelMissing] = useState<string | undefined>();

  const handleSelectProvider = useCallback(
    (value: ProviderKind) => {
      if (value === providerKind) {return;}
      setProviderKind(value);
      const label =
        value === "ollama"
          ? "Ollama"
          : value === "openai-compatible"
            ? "OpenAI-compatible"
            : "Bandit AI";
      setProviderLabel(label);
      // Model label only updates for the two providers we track in
      // local state. openai-compatible reads its model from workspace
      // config so the active label updates on the next syncState.
      if (value === "ollama") {setModelLabel(ollamaModelName);}
      else if (value === "bandit") {setModelLabel(banditModelName);}
      vscode.postMessage({ type: "setProvider", value });
    },
    [providerKind, banditModelName, ollamaModelName]
  );

  const handleEditModel = useCallback(() => {
    vscode.postMessage({ type: "editModel" });
  }, []);

  const handleEditOllamaUrl = useCallback(() => {
    vscode.postMessage({ type: "editOllamaUrl" });
  }, []);

  const handleSaveOllamaBaseUrl = useCallback(() => {
    const trimmed = ollamaBaseUrlDraft.trim();
    vscode.postMessage({ type: "setOllamaBaseUrl", value: trimmed });
  }, [ollamaBaseUrlDraft]);

  const handleResetOllamaBaseUrl = useCallback(() => {
    setOllamaBaseUrlDraft(DEFAULT_OLLAMA_URL);
    vscode.postMessage({ type: "setOllamaBaseUrl", value: DEFAULT_OLLAMA_URL });
  }, []);

  const handleSaveOllamaAuth = useCallback(() => {
    const trimmed = ollamaAuthDraft.trim();
    if (!trimmed) {return;}
    vscode.postMessage({ type: "setOllamaAuthToken", value: trimmed });
    setOllamaAuthDraft("");
  }, [ollamaAuthDraft]);

  const handleClearOllamaAuth = useCallback(() => {
    vscode.postMessage({ type: "clearOllamaAuthToken" });
    setOllamaAuthDraft("");
  }, []);

  const applyStateSnapshot = useCallback((state: WebviewState) => {
    setHasOllamaAuthToken(
      Boolean((state as { hasOllamaAuthToken?: boolean }).hasOllamaAuthToken)
    );
    setOllamaBaseUrlDraft((state.ollamaUrl ?? "").trim());
    const normalizedProvider: ProviderKind =
      state.provider === "ollama"
        ? "ollama"
        : state.provider === "openai-compatible"
          ? "openai-compatible"
          : "bandit";
    setProviderKind(normalizedProvider);
    setProviderLabel(
      normalizedProvider === "ollama"
        ? "Ollama"
        : normalizedProvider === "openai-compatible"
          ? "OpenAI-compatible"
          : "Bandit AI"
    );
    const nextBanditModel = state.model ?? DEFAULT_BANDIT_MODEL;
    const nextOllamaModel = state.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
    setBanditModelName(nextBanditModel);
    setOllamaModelName(nextOllamaModel);
    setModelLabel(normalizedProvider === "ollama" ? nextOllamaModel : nextBanditModel);
    if (state.ollamaStatus) {setOllamaStatus(state.ollamaStatus);}
    if (state.ollamaModelMissing) {setOllamaModelMissing(state.ollamaModelMissing);}
  }, []);

  return {
    providerKind,
    providerLabel,
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
    applyStateSnapshot
  };
}
