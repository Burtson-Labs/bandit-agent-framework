import type { JSX } from "react";
import clsx from "clsx";
import type { BackgroundTaskRecord } from "../types/backgroundTasks";

/**
 * Live tile for background subagent tasks. Sits between the
 * permission queue and the composer. Renders nothing when there's
 * nothing happening; collapses to a compact summary line when there's
 * activity; expands to a per-task drill-down on click.
 *
 * Reads from the `backgroundTasks` map kept in App state. The
 * extension owns the truth (host-kit's BackgroundTaskStore lives in
 * the BanditStealthViewProvider) and pushes lifecycle events to the
 * webview, which is purely a projection.
 */
export function BackgroundTaskTile(props: {
  tasks: BackgroundTaskRecord[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onCancel: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
}): JSX.Element | null {
  const { tasks, expanded, onToggleExpanded, onCancel, onDismiss } = props;
  // Surface running, plus any unconsumed completed/failed/cancelled.
  // Once the agent has consumed a completion (via the auto-injection
  // path or check_task), the extension flips `consumed` and we drop
  // it from the live tile — no point cluttering UI with stale results.
  const visible = tasks.filter((t) => t.status === "running" || !t.consumed);
  if (visible.length === 0) {return null;}

  const running = visible.filter((t) => t.status === "running");
  const completed = visible.filter((t) => t.status === "completed");
  const failed = visible.filter((t) => t.status === "failed");
  const cancelled = visible.filter((t) => t.status === "cancelled");

  const summaryBits: string[] = [];
  if (running.length > 0) {summaryBits.push(`${running.length} running`);}
  if (completed.length > 0) {summaryBits.push(`${completed.length} done`);}
  if (failed.length > 0) {summaryBits.push(`${failed.length} failed`);}
  if (cancelled.length > 0) {summaryBits.push(`${cancelled.length} cancelled`);}
  const summary = summaryBits.join(" · ");

  return (
    <div className={clsx("background-task-tile", expanded && "is-expanded")}>
      <button
        type="button"
        className="background-task-tile__summary"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
      >
        <span className="background-task-tile__icon" aria-hidden="true">
          {running.length > 0 ? "⟳" : completed.length > 0 ? "✓" : failed.length > 0 ? "✗" : "•"}
        </span>
        <span className="background-task-tile__label">Background subagents</span>
        <span className="background-task-tile__summary-text">{summary}</span>
        <span className="background-task-tile__chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <ul className="background-task-tile__list">
          {visible.map((t) => {
            const seconds = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
            const goalSlice = t.goal.length > 100 ? t.goal.slice(0, 100) + "…" : t.goal;
            return (
              <li key={t.id} className={clsx("background-task-tile__item", `is-${t.status}`)}>
                <div className="background-task-tile__item-head">
                  <span className="background-task-tile__id">{t.id}</span>
                  <span className="background-task-tile__status">
                    {t.status === "running"
                      ? `running · ${seconds.toFixed(0)}s · ${t.iterations} iter${t.lastTool ? ` · ${t.lastTool}` : ""}`
                      : `${t.status} · ${seconds.toFixed(1)}s · ${t.iterations} iter`}
                  </span>
                  {t.status === "running" && (
                    <button
                      type="button"
                      className="background-task-tile__cancel"
                      onClick={() => onCancel(t.id)}
                      aria-label={`Cancel task ${t.id}`}
                      title="Cancel"
                    >
                      ×
                    </button>
                  )}
                  {t.status !== "running" && (
                    <button
                      type="button"
                      className="background-task-tile__cancel"
                      onClick={() => onDismiss(t.id)}
                      aria-label={`Dismiss task ${t.id}`}
                      title="Dismiss — clears from this tile without sending the result into your next prompt"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="background-task-tile__goal">{goalSlice}</div>
                {t.status === "completed" && t.synopsis && (
                  <div className="background-task-tile__synopsis">{t.synopsis}</div>
                )}
                {t.status === "failed" && t.error && (
                  <div className="background-task-tile__error">{t.error}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
