import type { JSX } from "react";
import clsx from "clsx";
import {
  ClockIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  PencilSquareIcon
} from "@heroicons/react/24/outline";

export interface TopBarProps {
  /** Title text shown to the left of the icon buttons. */
  toolbarTitle: string;
  /** Tooltip for the settings button when not in settings mode. */
  settingsButtonTooltip: string;
  /** Which top-level page is active (drives the muted/disabled state of the icon buttons). */
  activePage: "workspace" | "settings";
  /** Whether the history drawer is open. */
  showHistory: boolean;
  /** Whether the settings page is the active overlay. */
  isSettingsPage: boolean;
  /** Whether the trace logs panel is the active overlay. */
  tracePanelOpen: boolean;
  /** Click handlers — one per icon button. */
  onToggleHistory: () => void;
  onOpenTracePanel: () => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
  onHideSettings: () => void;
}

/**
 * Top-of-shell toolbar with the four mutually-exclusive icon buttons:
 * history, trace logs, new conversation, and settings. Only one of
 * history / new-conversation / settings can be the active mode at a
 * time; the buttons for the inactive modes fade + become unclickable
 * while another mode is open so the user isn't presented with three
 * "where am I?" affordances simultaneously. Clicking the currently
 * active button toggles back to conversation.
 */
export function TopBar(props: TopBarProps): JSX.Element {
  const {
    toolbarTitle,
    settingsButtonTooltip,
    activePage,
    showHistory,
    isSettingsPage,
    tracePanelOpen,
    onToggleHistory,
    onOpenTracePanel,
    onNewConversation,
    onOpenSettings,
    onHideSettings
  } = props;
  return (
    <div className="stealth-toolbar">
      <div className="stealth-toolbar__text">
        <h1 className="stealth-toolbar__title">{toolbarTitle}</h1>
      </div>
      <div className="stealth-toolbar__actions">
        <button
          className={clsx("icon-button", showHistory && "active", (isSettingsPage || tracePanelOpen) && "is-muted")}
          type="button"
          aria-label={showHistory ? "Hide history" : "Show history"}
          aria-pressed={showHistory}
          disabled={isSettingsPage || tracePanelOpen}
          onClick={onToggleHistory}
          data-has-tooltip="true"
          data-tooltip={tracePanelOpen ? "Close trace logs to view history" : isSettingsPage ? "Close settings to view history" : (showHistory ? "Hide history" : "Show history")}
          data-tooltip-position="below"
        >
          <ClockIcon aria-hidden="true" />
        </button>
        <button
          className={clsx("icon-button", tracePanelOpen && "active")}
          type="button"
          aria-label={tracePanelOpen ? "Close trace logs" : "Open trace logs"}
          aria-pressed={tracePanelOpen}
          onClick={onOpenTracePanel}
          data-has-tooltip="true"
          data-tooltip={tracePanelOpen ? "Close trace logs" : "Trace logs"}
          data-tooltip-position="below"
        >
          <DocumentTextIcon aria-hidden="true" />
        </button>
        <button
          className={clsx("icon-button", (isSettingsPage || showHistory || tracePanelOpen) && "is-muted")}
          type="button"
          aria-label="New conversation"
          disabled={isSettingsPage || showHistory || tracePanelOpen}
          onClick={onNewConversation}
          data-has-tooltip="true"
          data-tooltip={tracePanelOpen ? "Close trace logs to start a new conversation" : isSettingsPage ? "Close settings to start a new conversation" : showHistory ? "Hide history to start a new conversation" : "New conversation"}
          data-tooltip-position="below"
        >
          <PencilSquareIcon aria-hidden="true" />
        </button>
        <button
          className={clsx("icon-button", activePage === "settings" && "active", (showHistory || tracePanelOpen) && "is-muted")}
          type="button"
          aria-label={activePage === "settings" ? "Close settings" : settingsButtonTooltip}
          onClick={activePage === "settings" ? onHideSettings : onOpenSettings}
          aria-pressed={activePage === "settings"}
          disabled={showHistory || tracePanelOpen}
          data-has-tooltip="true"
          data-tooltip={tracePanelOpen ? "Close trace logs to open settings" : showHistory ? "Hide history to open settings" : (activePage === "settings" ? "Close settings — return to conversation" : settingsButtonTooltip)}
          data-tooltip-align="right"
          data-tooltip-position="below"
        >
          <Cog6ToothIcon aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
