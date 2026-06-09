import type { JSX } from "react";
import { ArrowsPointingOutIcon } from "@heroicons/react/24/outline";

export function TaskSummaryCard({
  stats,
  onExpand
}: {
  stats: { total: number; completed: number; percent: number };
  onExpand: () => void;
}): JSX.Element {
  return (
    <section className="summary-card">
      <header className="summary-card__header">
        <div>
          <p className="summary-card__title">Agent tasks</p>
          <p className="summary-card__meta">
            {stats.completed}/{stats.total} complete · {stats.percent}%
          </p>
        </div>
        <button
          type="button"
          className="summary-card__expand"
          onClick={onExpand}
          aria-label="Expand agent tasks"
        >
          <ArrowsPointingOutIcon aria-hidden="true" />
        </button>
      </header>
      <div
        className="summary-card__progress"
        role="progressbar"
        aria-valuenow={stats.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${stats.percent}%` }} />
      </div>
    </section>
  );
}
