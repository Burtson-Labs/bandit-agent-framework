import type { JSX } from "react";
import { ArrowUpRightIcon, ArrowUturnLeftIcon } from "@heroicons/react/24/outline";

export function FilesChangedSummaryCard({
  fileCount,
  totals,
  onExpand,
  onUndo,
  undoDisabled,
  showUndo = true
}: {
  fileCount: number;
  totals: { added: number; removed: number };
  onExpand: () => void;
  onUndo: () => void;
  undoDisabled: boolean;
  showUndo?: boolean;
}): JSX.Element {
  return (
    <section className="files-summary-card">
      <div className="files-summary-card__left">
        <p className="files-summary-card__title">
          {fileCount} {fileCount === 1 ? "file" : "files"} changed
        </p>
        <p className="files-summary-card__meta">
          <span className="delta-added">+{totals.added}</span>
          <span className="delta-removed">-{totals.removed}</span>
        </p>
      </div>
      <div className="files-summary-card__actions">
        {showUndo && (
          <button type="button" onClick={onUndo} disabled={undoDisabled}>
            <ArrowUturnLeftIcon aria-hidden="true" />
            Undo
          </button>
        )}
        <button type="button" className="files-summary-card__expand" onClick={onExpand}>
          View all changes
          <ArrowUpRightIcon aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
