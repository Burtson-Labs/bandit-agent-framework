import type { JSX } from "react";
import clsx from "clsx";
import {
  ClockIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  PlusIcon
} from "@heroicons/react/24/outline";
import type { ViewAction } from "../state/viewActions";

export interface TopBarProps {
  /** What the view is showing, in sentence case ("New conversation", "Settings"…). */
  title: string;
  /** Which top-level page is active. */
  activePage: "workspace" | "settings";
  /** Whether the history list is open. */
  showHistory: boolean;
  /** Whether the trace logs panel is open. */
  tracePanelOpen: boolean;
  onAction: (action: ViewAction) => void;
}

/**
 * In-webview toolbar, used only when the host does not put these actions
 * in VS Code's view title bar (the extension does, via contributes.menus
 * `view/title`; see bootConfig.nativeTitleActions).
 *
 * Square 26px ghost buttons in VS Code's toolbar style. Every button stays
 * enabled: choosing one closes whichever surface is open (see
 * state/viewActions.ts). The title shrinks with an ellipsis and the
 * buttons never wrap or clip, down to a 220px-wide view.
 */
export function TopBar(props: TopBarProps): JSX.Element {
  const { title, activePage, showHistory, tracePanelOpen, onAction } = props;
  const settingsOpen = activePage === "settings";
  return (
    <div className="stealth-toolbar" role="toolbar" aria-label="Bandit Stealth">
      <h1 className="stealth-toolbar__title" title={title}>{title}</h1>
      <div className="stealth-toolbar__actions">
        <button
          className="icon-button"
          type="button"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => onAction("newConversation")}
        >
          <PlusIcon aria-hidden="true" />
        </button>
        <button
          className={clsx("icon-button", showHistory && "active")}
          type="button"
          aria-label="Conversation history"
          title={showHistory ? "Hide history" : "Conversation history"}
          aria-pressed={showHistory}
          onClick={() => onAction("toggleHistory")}
        >
          <ClockIcon aria-hidden="true" />
        </button>
        <button
          className={clsx("icon-button", tracePanelOpen && "active")}
          type="button"
          aria-label="Trace logs"
          title={tracePanelOpen ? "Close trace logs" : "Trace logs"}
          aria-pressed={tracePanelOpen}
          onClick={() => onAction("openTraceLogs")}
        >
          <DocumentTextIcon aria-hidden="true" />
        </button>
        <button
          className={clsx("icon-button", settingsOpen && "active")}
          type="button"
          aria-label="Settings"
          title={settingsOpen ? "Close settings" : "Settings"}
          aria-pressed={settingsOpen}
          onClick={() => onAction("toggleSettings")}
        >
          <Cog6ToothIcon aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
