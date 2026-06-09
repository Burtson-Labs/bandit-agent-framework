import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  ArrowUturnLeftIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  MinusIcon
} from "@heroicons/react/24/outline";
import { DiffBlock } from "@burtson-labs/agent-ui";
import type { CompletedChangeEntry, DiffPreviewAction } from "../state/diffStorage";
import { getFileDisplayName } from "../state/keyHelpers";

interface CompletedChangesPanelProps {
  entries: CompletedChangeEntry[];
  totals: { added: number; removed: number };
  onAction: (path: string, action: DiffPreviewAction) => void;
  onUndo?: () => void;
  undoDisabled?: boolean;
  onCollapse?: () => void;
  defaultExpanded?: boolean;
  compactActions?: boolean;
}

export function CompletedChangesPanel({
  entries,
  totals,
  onAction,
  onUndo,
  undoDisabled,
  onCollapse,
  defaultExpanded = false,
  compactActions = false
}: CompletedChangesPanelProps): JSX.Element | null {
  const makeDefaultMap = useCallback(
    (expandAll = false) =>
      expandAll
        ? entries.reduce<Record<string, boolean>>((acc, entry) => {
            acc[entry.path] = true;
            return acc;
          }, {})
        : {},
    [entries]
  );
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => makeDefaultMap(defaultExpanded));

  useEffect(() => {
    setOpenMap(makeDefaultMap(defaultExpanded));
  }, [entries, defaultExpanded, makeDefaultMap]);
  if (!entries.length) {
    return null;
  }

  const undoAll = (): void => {
    if (typeof onUndo === "function") {
      onUndo();
      return;
    }
    entries.forEach((entry) => entry.path && onAction(entry.path, "discard"));
  };
  const expandAll = (): void => {
    setOpenMap(
      entries.reduce<Record<string, boolean>>((acc, entry) => {
        acc[entry.path] = true;
        return acc;
      }, {})
    );
  };

  const toggleEntry = (path: string): void => {
    setOpenMap((prev) => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  return (
    <section className="completed-changes-panel" aria-live="polite">
      <header className="completed-changes-panel__header">
        <div>
          <p className="completed-changes-panel__title">
            {entries.length} {entries.length === 1 ? "file" : "files"} changed
          </p>
          <p className="completed-changes-panel__delta">
            <span className="completed-changes-panel__delta-added">+{totals.added}</span>
            <span className="completed-changes-panel__delta-removed">-{totals.removed}</span>
          </p>
        </div>
        <div className={clsx("completed-changes-panel__actions", compactActions && "is-compact")}>
          <button type="button" onClick={undoAll} disabled={undoDisabled}>
            <ArrowUturnLeftIcon aria-hidden="true" />
            Undo
          </button>
          {!compactActions && onCollapse && (
            <button type="button" onClick={expandAll}>
              View all changes
            </button>
          )}
          {onCollapse && (
            <button
              type="button"
              className="collapsible-toggle"
              onClick={onCollapse}
              aria-label="Collapse files changed widget"
            >
              <MinusIcon aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <div className="completed-changes-list">
        {entries.map((entry) => {
          const expanded = Boolean(openMap[entry.path]);
          return (
            <article key={entry.path} className={clsx("completed-change", expanded && "is-open")}>
              <div className="completed-change__header">
                <button
                  type="button"
                  className="completed-change__toggle"
                  onClick={() => toggleEntry(entry.path)}
                  aria-expanded={expanded}
                >
                  <span className="completed-change__path" title={entry.path}>
                    {getFileDisplayName(entry.path)}
                  </span>
                  {typeof entry.added === "number" && typeof entry.removed === "number" && (
                    <span className="completed-change__delta">
                      <span className="completed-changes-panel__delta-added">+{entry.added}</span>
                      <span className="completed-changes-panel__delta-removed">-{entry.removed}</span>
                    </span>
                  )}
                  <span className="completed-change__chevron" aria-hidden="true">
                    {expanded ? (
                      <ArrowsPointingInIcon aria-hidden="true" />
                    ) : (
                      <ArrowsPointingOutIcon aria-hidden="true" />
                    )}
                  </span>
                </button>
              </div>
              {expanded && entry.diffText && (
                <DiffBlock source={entry.diffText} className="completed-change__diff" />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
