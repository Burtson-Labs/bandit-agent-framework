import type { JSX } from "react";
import { DiffFileGroup } from "./DiffFileGroup";

export interface DiffItem {
  filePath: string;
  diffText: string;
  added?: number;
  removed?: number;
  confidence?: number;
  review?: string | null;
}

export interface DiffReviewPanelProps {
  diffs: DiffItem[];
  onCopyDiff?: (filePath: string, diffText: string) => void;
  onOpenFile?: (filePath: string) => void;
}

const aggregateTotals = (items: DiffItem[]): { added: number; removed: number } => {
  return items.reduce(
    (acc, item) => {
      if (typeof item.added === "number" && Number.isFinite(item.added)) {
        acc.added += item.added;
      }
      if (typeof item.removed === "number" && Number.isFinite(item.removed)) {
        acc.removed += item.removed;
      }
      return acc;
    },
    { added: 0, removed: 0 }
  );
};

export const DiffReviewPanel = ({
  diffs,
  onCopyDiff,
  onOpenFile
}: DiffReviewPanelProps): JSX.Element | null => {
  if (!Array.isArray(diffs) || diffs.length === 0) {
    return null;
  }

  const totals = aggregateTotals(diffs);

  return (
    <section className="diff-review-panel" aria-label="Diff review">
      <header className="diff-review-header">
        <div>
          <p className="diff-review-eyebrow">Diff Review</p>
          <h4 className="diff-review-title">Proposed changes</h4>
        </div>
        <span className="diff-review-metrics">
          Total Δ +{totals.added} / -{totals.removed}
        </span>
      </header>
      <div className="diff-review-list">
        {diffs.map((diff, index) => (
          <DiffFileGroup
            key={diff.filePath}
            {...diff}
            defaultOpen={index === 0}
            onCopyDiff={onCopyDiff}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </section>
  );
};

