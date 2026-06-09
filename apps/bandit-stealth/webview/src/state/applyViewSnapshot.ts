import type { WebviewState } from "../types/webview";

/**
 * Setter surface for the active-view slice (conversation vs plan tab +
 * plan unread indicator). Rule: opening the plan tab always clears the
 * unread badge; an unread flag from the wire only takes effect when
 * the conversation tab is the active view.
 */
export interface ViewSnapshotDeps {
  setActiveView: (value: "conversation" | "plan") => void;
  setPlanUnread: (value: boolean) => void;
}

export function applyViewSnapshot(state: WebviewState, deps: ViewSnapshotDeps): void {
  const nextActiveView: "conversation" | "plan" = state.activeView === "plan" ? "plan" : "conversation";
  deps.setActiveView(nextActiveView);
  if (nextActiveView === "plan") {
    deps.setPlanUnread(false);
  } else if (state.planUnread) {
    deps.setPlanUnread(true);
  }
}
