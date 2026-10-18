/**
 * Page switching for the view's title-bar actions.
 *
 * History, new conversation, settings and trace logs are buttons in VS
 * Code's own view title bar (contributes.menus `view/title`). The host
 * forwards each click as a `viewAction` message; this module decides what
 * the webview does with it. The same logic backs the in-webview toolbar
 * used when the host does not provide title-bar actions.
 *
 * Every action works from any page: opening one surface closes the
 * others, so the user never has to back out of Settings before History
 * responds (the old toolbar disabled the other buttons instead).
 */

export type ViewAction =
  | "newConversation"
  | "toggleHistory"
  | "toggleSettings"
  | "openSettings"
  | "openTraceLogs";

const VIEW_ACTIONS: ReadonlySet<string> = new Set<ViewAction>([
  "newConversation",
  "toggleHistory",
  "toggleSettings",
  "openSettings",
  "openTraceLogs"
]);

export const isViewAction = (value: unknown): value is ViewAction =>
  typeof value === "string" && VIEW_ACTIONS.has(value);

export interface ViewSurface {
  page: "workspace" | "settings";
  showHistory: boolean;
  tracePanelOpen: boolean;
}

export interface ViewActionEffects {
  showSettings: () => void;
  hideSettings: () => void;
  /** Ask the host to show or hide the history list. */
  setHistoryVisible: (visible: boolean) => void;
  closeTracePanel: () => void;
  /** Open the trace logs panel (requests the trace list). */
  openTracePanel: () => void;
  startNewConversation: () => void;
}

export function applyViewAction(
  action: ViewAction,
  surface: ViewSurface,
  effects: ViewActionEffects
): void {
  const inSettings = surface.page === "settings";
  switch (action) {
    case "newConversation":
      if (surface.tracePanelOpen) {effects.closeTracePanel();}
      if (inSettings) {effects.hideSettings();}
      if (surface.showHistory) {effects.setHistoryVisible(false);}
      effects.startNewConversation();
      return;
    case "toggleHistory": {
      if (surface.tracePanelOpen) {effects.closeTracePanel();}
      if (inSettings) {
        effects.hideSettings();
        if (!surface.showHistory) {effects.setHistoryVisible(true);}
        return;
      }
      effects.setHistoryVisible(!surface.showHistory);
      return;
    }
    case "toggleSettings":
    case "openSettings":
      if (surface.tracePanelOpen) {effects.closeTracePanel();}
      if (surface.showHistory) {effects.setHistoryVisible(false);}
      if (inSettings && action === "toggleSettings") {
        effects.hideSettings();
      } else {
        effects.showSettings();
      }
      return;
    case "openTraceLogs":
      if (surface.tracePanelOpen) {
        effects.closeTracePanel();
        return;
      }
      if (inSettings) {effects.hideSettings();}
      effects.openTracePanel();
      return;
    default:
      return;
  }
}

/**
 * The short name of what the view is showing, in sentence case. Shown
 * next to the view title in VS Code's title bar, and as the heading of
 * the in-webview toolbar.
 */
export function viewTitleFor(input: {
  page: "workspace" | "settings";
  showHistory: boolean;
  tracePanelOpen: boolean;
  activeView: "conversation" | "plan";
  conversationName?: string | null;
}): string {
  if (input.page === "settings") {return "Settings";}
  if (input.tracePanelOpen) {return "Trace logs";}
  if (input.showHistory) {return "History";}
  if (input.activeView === "plan") {return "Plan";}
  const name = input.conversationName?.trim();
  return name ? name : "New conversation";
}
