import type { JSX } from "react";
import { useMemo, useState } from "react";
import clsx from "clsx";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
  ArchiveBoxArrowDownIcon,
  ArrowUturnLeftIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XCircleIcon
} from "@heroicons/react/24/outline";
import type { ConversationSummary } from "../types/webview";

interface HistoryPanelProps {
  history: ConversationSummary[];
  currentConversationId?: string;
  hasArchived: boolean;
  onSelect: (id: string) => void;
  onClear?: () => void;
  onDismiss?: () => void;
  onArchive?: (id: string, archived: boolean) => void;
  onDelete?: (id: string) => void;
}

type HistoryFilter = "all" | "active" | "archived";

interface HistoryFilterOption {
  value: HistoryFilter;
  label: string;
  Icon: typeof ChatBubbleOvalLeftEllipsisIcon;
}

const HISTORY_FILTER_OPTIONS: HistoryFilterOption[] = [
  { value: "all", label: "All", Icon: ChatBubbleOvalLeftEllipsisIcon },
  { value: "active", label: "Active", Icon: CheckCircleIcon },
  { value: "archived", label: "Archived", Icon: ArchiveBoxArrowDownIcon }
];

const formatHistoryTimestamp = (value: number): string => {
  try {
    return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
};

const formatHistoryRelative = (value: number): { label: string; tooltip: string } => {
  const tooltip = formatHistoryTimestamp(value);
  if (!value) {
    return { label: "", tooltip };
  }
  const delta = Date.now() - value;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (delta < minute) {
    return { label: "just now", tooltip };
  }
  if (delta < hour) {
    const minutes = Math.max(1, Math.round(delta / minute));
    return { label: `${minutes}m ago`, tooltip };
  }
  if (delta < day) {
    const hours = Math.round(delta / hour);
    return { label: `${hours}h ago`, tooltip };
  }
  if (delta < week) {
    const days = Math.round(delta / day);
    return { label: `${days}d ago`, tooltip };
  }
  const dateLabel = new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
  return { label: dateLabel, tooltip };
};

export function HistoryPanel({
  history,
  currentConversationId,
  hasArchived,
  onSelect,
  onClear,
  onDismiss,
  onArchive,
  onDelete
}: HistoryPanelProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filterCounts = useMemo(() => {
    const counts: Record<HistoryFilter, number> = {
      all: history.length,
      active: 0,
      archived: 0
    };
    history.forEach((item) => {
      if (item.archived) {
        counts.archived += 1;
      } else {
        counts.active += 1;
      }
    });
    return counts;
  }, [history]);

  const filteredHistory = useMemo(() => {
    return history.filter((item) => {
      if (filter === "active" && item.archived) {
        return false;
      }
      if (filter === "archived" && !item.archived) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = `${item.name ?? ""} ${item.id}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [history, filter, normalizedQuery]);

  const showEmptyState = history.length === 0;
  const showNoMatches = !showEmptyState && filteredHistory.length === 0;

  const handleFilterChange = (value: string) => {
    if (!value) {
      return;
    }
    setFilter(value as HistoryFilter);
  };

  return (
    <section className="history-panel history-panel--expanded">
      <header className="history-panel__header">
        <div>
          <p className="history-panel__eyebrow">History</p>
          <h3 className="history-panel__title">Recent conversations</h3>
        </div>
        <div className="history-panel__actions">
          {history.length > 0 && onClear && (
            <button className="link-button" type="button" onClick={onClear}>
              Clear all
            </button>
          )}
          {onDismiss && (
            <button className="link-button" type="button" onClick={onDismiss}>
              Hide
            </button>
          )}
        </div>
      </header>
      {history.length > 0 && (
        <div className="history-panel__toolbar">
          <div className="history-panel__search">
            <MagnifyingGlassIcon aria-hidden="true" />
            <input
              type="search"
              placeholder="Search by name or ID"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search conversations"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search">
                <XCircleIcon aria-hidden="true" />
              </button>
            )}
          </div>
          <ToggleGroup.Root
            type="single"
            value={filter}
            onValueChange={handleFilterChange}
            className="history-panel__filters"
            aria-label="Filter conversations"
          >
            {HISTORY_FILTER_OPTIONS.map(({ value, label, Icon }) => (
              <ToggleGroup.Item
                key={value}
                value={value}
                className={clsx("mode-chip", "mode-chip--history", filter === value && "is-active")}
                aria-label={`${label} conversations`}
              >
                <Icon aria-hidden="true" />
                <span className="mode-chip__label">{label}</span>
                <span className="history-filter__count">{filterCounts[value]}</span>
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>
      )}
      {showEmptyState ? (
        <div className="history-panel__empty">
          <p>No conversations yet.</p>
          <p>Start a new chat to build your history.</p>
        </div>
      ) : showNoMatches ? (
        <div className="history-panel__empty">
          <p>No conversations match "{searchQuery}".</p>
          <button className="link-button" type="button" onClick={() => setSearchQuery("")}>
            Clear search
          </button>
        </div>
      ) : (
        <ul className="history-panel__list">
          {filteredHistory.map((item) => (
            <li key={item.id} className="history-panel__row">
              <div
                role="button"
                tabIndex={0}
                className={clsx("history-panel__item", currentConversationId === item.id && "is-active")}
                onClick={() => onSelect(item.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(item.id);
                  }
                }}
              >
                <div className="history-panel__item-body">
                  <div className="history-panel__item-text">
                    <p className="history-panel__item-title">{item.name || "Untitled conversation"}</p>
                    {(() => {
                      const meta = formatHistoryRelative(item.updatedAt);
                      return (
                        <p
                          className="history-panel__item-meta"
                          data-has-tooltip={meta.tooltip ? "true" : undefined}
                          data-tooltip={meta.tooltip}
                        >
                          {meta.label}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="history-panel__badges">
                    {currentConversationId === item.id && <span className="history-panel__badge">Active</span>}
                    {item.archived && <span className="history-panel__badge muted">Archived</span>}
                  </div>
                </div>
                <div className="history-panel__item-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={item.archived ? "Restore conversation" : "Archive conversation"}
                    onClick={(event) => {
                      event.stopPropagation();
                      onArchive?.(item.id, !item.archived);
                    }}
                  >
                    {item.archived ? <ArrowUturnLeftIcon aria-hidden="true" /> : <ArchiveBoxArrowDownIcon aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Delete conversation"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete?.(item.id);
                    }}
                  >
                    <TrashIcon aria-hidden="true" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasArchived && (
        <p className="history-panel__hint">Archived conversations are available from the Bandit history drawer.</p>
      )}
    </section>
  );
}
