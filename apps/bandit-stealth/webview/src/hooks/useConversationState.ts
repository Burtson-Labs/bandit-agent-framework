import { useCallback, useState } from "react";
import type { ChatMessage } from "@burtson-labs/agent-ui";
import type {
  ConversationEntry,
  ModeKind,
  WebviewState
} from "../types/webview";
import { stripTurnTokens } from "../util/stripTurnTokens";

/**
 * Project a conversation entry onto the agent-ui ChatMessage shape.
 * Stays a pure helper (no React deps) so the hook below can call it
 * inside setConversationEntries to keep `messages` in sync without
 * extra useEffect noise.
 */
export const mapConversationToChat = (entries: ConversationEntry[]): ChatMessage[] =>
  entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: stripTurnTokens(entry.content),
    feedback: entry.feedback
      ? {
          rating: entry.feedback.rating,
          submitted: entry.feedback.submitted
        }
      : undefined,
    contextFiles: Array.isArray(entry.contextFiles)
      ? entry.contextFiles
          .filter((path): path is string => typeof path === "string" && path.length > 0)
          .map((path) => ({
            path,
            source: entry.contextSource
          }))
      : undefined,
    images: Array.isArray(entry.images)
      ? entry.images
          .map((src) => (typeof src === "string" ? src.trim() : ""))
          .filter((src): src is string => src.length > 0)
      : undefined
  }));

export interface ConversationStateHook {
  conversationEntries: ConversationEntry[];
  messages: ChatMessage[];
  showFullConversation: boolean;
  composerValue: string;
  mode: ModeKind;
  statusText: string;
  busy: boolean;
  currentConversationId: string | undefined;

  /** Replace conversation entries; messages auto-update via mapConversationToChat. */
  setConversationEntries: (entries: ConversationEntry[]) => void;
  /** Raw setter for the composer text field. Accepts a value or a (prev → next) updater. */
  setComposerValue: (value: string | ((prev: string) => string)) => void;
  /**
   * Append text to the composer. Used by the voice-transcription path —
   * appends with a leading space when there's existing typed content, so
   * the user's draft isn't clobbered.
   */
  appendToComposer: (text: string) => void;
  /** Convenience: clear the composer. */
  clearComposer: () => void;
  setShowFullConversation: (value: boolean) => void;
  setStatusText: (value: string) => void;
  setBusy: (value: boolean) => void;
  setCurrentConversationId: (id: string | undefined) => void;
  /**
   * User picks a new mode from the toggle. Posts `setMode` to the
   * extension AND flips local state. No-op when the picked mode is
   * already current.
   */
  changeMode: (next: string) => void;
  /**
   * Apply the conversation slice of a boot/state message. Sets
   * entries+messages, mode, busy, statusText, and conversation id from
   * the wire shape. Returns nothing.
   */
  applyConversationStateSnapshot: (state: WebviewState) => void;
}

/**
 * Owns the conversation core: entries + derived messages, composer
 * draft, mode toggle, busy/status indicator, and the current
 * conversation id. The hook keeps `messages` in sync with
 * `conversationEntries` so consumers can read the projection without
 * a useMemo dance.
 *
 * Most of the inbound state lands via applyConversationStateSnapshot
 * (a thin shim over the relevant state-message fields). The narrower
 * setters are exposed for the in-flight mutations that fire between
 * state messages — composer typing, mode toggle, busy flips around
 * the agent loop, etc.
 */
export function useConversationState(): ConversationStateHook {
  const [conversationEntries, setConversationEntriesRaw] = useState<ConversationEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showFullConversation, setShowFullConversation] = useState(false);
  const [composerValue, setComposerValue] = useState<string>("");
  const [mode, setMode] = useState<ModeKind>("ask");
  const [statusText, setStatusText] = useState<string>("Ready");
  const [busy, setBusy] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>();

  const setConversationEntries = useCallback((entries: ConversationEntry[]) => {
    setConversationEntriesRaw(entries);
    setMessages(mapConversationToChat(entries));
  }, []);

  const appendToComposer = useCallback((text: string) => {
    if (!text) {return;}
    setComposerValue((prev) => (prev.trim().length > 0 ? `${prev} ${text}` : text));
  }, []);

  const clearComposer = useCallback(() => {
    setComposerValue("");
  }, []);

  const changeMode = useCallback(
    (next: string) => {
      if (next !== "agent" && next !== "ask") {return;}
      const nextMode = next as ModeKind;
      if (nextMode === mode) {return;}
      vscode.postMessage({ type: "setMode", value: nextMode });
      setMode(nextMode);
    },
    [mode]
  );

  const applyConversationStateSnapshot = useCallback(
    (state: WebviewState) => {
      const normalizedMessages = Array.isArray(state.messages) ? state.messages : [];
      setConversationEntries(normalizedMessages);
      setMode(state.mode);
      setBusy(state.isBusy);
      setStatusText(state.statusText ?? (state.isBusy ? "Working…" : "Ready"));
      // composerValue is intentionally NOT cleared here — the presetPrompt
      // merge logic lives in App.tsx where it can compare against the
      // user's in-flight composerValue without forcing the hook to know
      // about presetPrompt's wire semantics.
      setCurrentConversationId(state.currentConversationId);
    },
    [setConversationEntries]
  );

  return {
    conversationEntries,
    messages,
    showFullConversation,
    composerValue,
    mode,
    statusText,
    busy,
    currentConversationId,
    setConversationEntries,
    setComposerValue,
    appendToComposer,
    clearComposer,
    setShowFullConversation,
    setStatusText,
    setBusy,
    setCurrentConversationId,
    changeMode,
    applyConversationStateSnapshot
  };
}
