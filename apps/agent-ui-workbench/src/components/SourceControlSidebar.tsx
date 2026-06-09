import { useState } from "react";
import clsx from "clsx";
import {
  ArrowPathIcon,
  EllipsisHorizontalIcon,
  CheckIcon,
  PlusIcon,
  XMarkIcon,
  ChevronDownIcon,
  ChevronRightIcon
} from "@heroicons/react/24/outline";

type ChangeKind = "M" | "A" | "D" | "U" | "R";

interface ChangeEntry {
  /** Full repo-relative path so the row can split into name + dir. */
  path: string;
  kind: ChangeKind;
  /** Optional diff stats — populates the "+12 -3" tooltip on hover. */
  added?: number;
  removed?: number;
}

// Mirrors the exact set of files this workbench session has touched
// while building out tabs/explorer/marketplace/tool palette — so the
// 12 badge on the activity bar isn't lying. Bump when we add/remove
// files in upcoming turns to keep the workbench self-honest.
const CHANGES: ChangeEntry[] = [
  { path: "apps/agent-ui-workbench/src/App.tsx", kind: "M", added: 9, removed: 3 },
  { path: "apps/agent-ui-workbench/src/components/Sidebar.tsx", kind: "M", added: 2, removed: 1 },
  { path: "apps/agent-ui-workbench/src/components/StatusBar.tsx", kind: "M", added: 1, removed: 1 },
  { path: "apps/agent-ui-workbench/src/components/BanditPanel.tsx", kind: "M", added: 142, removed: 6 },
  { path: "apps/agent-ui-workbench/src/markdown/banditMarkdown.ts", kind: "M", added: 132, removed: 1 },
  { path: "apps/agent-ui-workbench/src/mocks/mockConversation.ts", kind: "M", added: 36, removed: 24 },
  { path: "apps/agent-ui-workbench/src/index.css", kind: "M", added: 644, removed: 12 },
  { path: "apps/agent-ui-workbench/vite.config.ts", kind: "M", added: 15, removed: 0 },
  { path: "apps/agent-ui-workbench/src/components/ExplorerSidebar.tsx", kind: "A", added: 172 },
  { path: "apps/agent-ui-workbench/src/components/ExtensionsSidebar.tsx", kind: "A", added: 56 },
  { path: "apps/agent-ui-workbench/src/components/ExtensionsMarketplacePanel.tsx", kind: "A", added: 264 },
  { path: "apps/agent-ui-workbench/src/components/SourceControlSidebar.tsx", kind: "A", added: 195 }
];

const UNTRACKED: ChangeEntry[] = [
  { path: "apps/agent-ui-workbench/src/components/AskUserCard.tsx", kind: "U" },
  { path: "apps/agent-ui-workbench/src/components/ToolPalette.tsx", kind: "U" },
  { path: "apps/agent-ui-workbench/src/components/WorkbenchSettingsOverlay.tsx", kind: "U" },
  { path: "apps/agent-ui-workbench/src/marketplace/banditMeta.ts", kind: "U" },
  { path: "apps/agent-ui-workbench/src/marketplace/vite-globals.d.ts", kind: "U" },
  { path: "apps/agent-ui-workbench/src/mocks/toolFixtures.ts", kind: "U" }
];

const KIND_LABEL: Record<ChangeKind, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  U: "Untracked",
  R: "Renamed"
};

const KIND_COLOR: Record<ChangeKind, string> = {
  M: "#e2c08d",
  A: "#73c991",
  D: "#f48771",
  U: "#73c991",
  R: "#73c991"
};

function splitPath(full: string): { name: string; dir: string } {
  const idx = full.lastIndexOf("/");
  if (idx < 0) {
    return { name: full, dir: "" };
  }
  return { name: full.slice(idx + 1), dir: full.slice(0, idx) };
}

interface ChangeListProps {
  title: string;
  entries: ChangeEntry[];
  defaultOpen?: boolean;
}

function ChangeList({ title, entries, defaultOpen = true }: ChangeListProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (entries.length === 0) {
    return null;
  }
  return (
    <section className="scm__section">
      <button
        type="button"
        className="scm__section-header"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDownIcon className="scm__chevron" aria-hidden="true" />
        ) : (
          <ChevronRightIcon className="scm__chevron" aria-hidden="true" />
        )}
        <span className="scm__section-title">{title}</span>
        <span className="scm__section-count">{entries.length}</span>
      </button>
      {open && (
        <ul className="scm__list">
          {entries.map((entry) => {
            const { name, dir } = splitPath(entry.path);
            const stats =
              entry.added != null && entry.removed != null
                ? `+${entry.added} -${entry.removed}`
                : entry.added != null
                  ? `+${entry.added}`
                  : "";
            return (
              <li key={entry.path} className="scm__row" title={`${KIND_LABEL[entry.kind]} · ${stats}`}>
                <span className="scm__name">{name}</span>
                <span className="scm__dir">{dir}</span>
                <span className="scm__row-actions" aria-hidden="true">
                  <button type="button" className="scm__row-btn" title="Discard">
                    <ArrowPathIcon />
                  </button>
                  <button type="button" className="scm__row-btn" title={entry.kind === "U" ? "Add" : "Stage"}>
                    <PlusIcon />
                  </button>
                </span>
                <span
                  className={clsx("scm__badge", `scm__badge--${entry.kind}`)}
                  style={{ color: KIND_COLOR[entry.kind] }}
                  title={KIND_LABEL[entry.kind]}
                >
                  {entry.kind}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * VS Code-style Source Control pane. Two sections — tracked Changes
 * and Untracked Files — match the 12 + 6 split this workbench session
 * actually produced. Commit message + buttons are wired to noop
 * handlers since the workbench can't talk to git; the value here is
 * that the activity-bar badge isn't lying when a viewer flips over.
 */
export function SourceControlSidebar() {
  const [message, setMessage] = useState("");
  const trackedCount = CHANGES.length;
  const totalCount = trackedCount + UNTRACKED.length;
  return (
    <div className="scm">
      <div className="scm__toolbar">
        <span className="scm__toolbar-title" title="Active source control provider">
          BANDIT-AGENT-FRAMEWORK · main
        </span>
        <span className="scm__toolbar-actions">
          <button type="button" className="scm__icon-btn" title="Refresh">
            <ArrowPathIcon />
          </button>
          <button type="button" className="scm__icon-btn" title="More actions">
            <EllipsisHorizontalIcon />
          </button>
        </span>
      </div>
      <div className="scm__commit">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={`Message (⌘Enter to commit on 'main')`}
          rows={3}
        />
        <div className="scm__commit-actions">
          <button
            type="button"
            className="scm__commit-btn"
            disabled={message.trim().length === 0}
          >
            <CheckIcon aria-hidden="true" />
            <span>Commit</span>
            <span className="scm__commit-btn-split" aria-hidden="true">▾</span>
          </button>
          <span className="scm__commit-summary">
            {trackedCount} staged · {totalCount} total
          </span>
        </div>
        {message.trim().length === 0 && (
          <p className="scm__hint">
            <XMarkIcon aria-hidden="true" />
            <span>Workbench preview — no real git wired in.</span>
          </p>
        )}
      </div>
      <div className="scm__lists">
        <ChangeList title="Changes" entries={CHANGES} />
        <ChangeList title="Untracked Files" entries={UNTRACKED} />
      </div>
    </div>
  );
}
