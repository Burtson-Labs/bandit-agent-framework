import type { ConversationSummary, WebviewState } from "../types/webview";

/**
 * Setter surface for the conversation-history slice (list + drawer
 * visibility + archive flag + current conversation name + undo
 * availability). Concern: anything you'd expect to see in the history
 * drawer or its toolbar. The actual conversation MESSAGES live on
 * [[useConversationState]].
 */
export interface HistorySnapshotDeps {
  setHistory: (value: ConversationSummary[]) => void;
  setShowHistory: (value: boolean) => void;
  setHasArchivedConversations: (value: boolean) => void;
  setCurrentConversationName: (value: string) => void;
  setCanUndoAgentChange: (value: boolean) => void;
}

export function applyHistorySnapshot(state: WebviewState, deps: HistorySnapshotDeps): void {
  deps.setHistory(state.history ?? []);
  deps.setShowHistory(state.showHistory ?? false);
  deps.setHasArchivedConversations(state.hasArchivedConversations ?? false);
  deps.setCurrentConversationName(state.currentConversationName ?? "New Conversation");
  deps.setCanUndoAgentChange(Boolean(state.undoAvailable));
}
