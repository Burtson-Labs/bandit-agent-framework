import type { JSX, SyntheticEvent } from "react";
import { useState } from "react";
import { DiffBlock } from "./DiffBlock";

export interface DiffFileGroupProps {
  filePath: string;
  diffText: string;
  added?: number;
  removed?: number;
  confidence?: number;
  review?: string | null;
  defaultOpen?: boolean;
  onCopyDiff?: (filePath: string, diffText: string) => void;
  onOpenFile?: (filePath: string) => void;
}

const formatSummary = (added?: number, removed?: number): string | null => {
  if (typeof added !== "number" && typeof removed !== "number") {
    return null;
  }
  const addedLabel = typeof added === "number" ? `+${added}` : "+0";
  const removedLabel = typeof removed === "number" ? `-${removed}` : "-0";
  return `${addedLabel} / ${removedLabel}`;
};

const formatConfidence = (confidence?: number): string | null => {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return null;
  }
  return `${Math.round(confidence * 100)}% conf.`;
};

export const DiffFileGroup = ({
  filePath,
  diffText,
  added,
  removed,
  confidence,
  review,
  defaultOpen = false,
  onCopyDiff,
  onOpenFile
}: DiffFileGroupProps): JSX.Element => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const summary = formatSummary(added, removed);
  const confidenceLabel = formatConfidence(confidence);

  const handleCopy = (): void => {
    if (onCopyDiff) {
      onCopyDiff(filePath, diffText);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(diffText);
    }
  };

  const handleOpenFile = (): void => {
    onOpenFile?.(filePath);
  };

  const fileLabel =
    typeof onOpenFile === "function" ? (
      <button type="button" className="link-button diff-review-file-link" onClick={handleOpenFile}>
        {filePath}
      </button>
    ) : (
      <span className="diff-review-file-label">{filePath}</span>
    );

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    setIsOpen(event.currentTarget.open);
  };

  return (
    <details className="diff-review-file" open={isOpen} onToggle={handleToggle}>
      <summary className="diff-review-file-summary">
        <div className="diff-review-file-meta">
          {fileLabel}
          {summary && <span className="diff-review-chip">{summary}</span>}
          {confidenceLabel && <span className="diff-review-chip">{confidenceLabel}</span>}
        </div>
        <div className="diff-review-file-actions">
          <button type="button" className="link-button" onClick={handleCopy}>
            Copy diff
          </button>
        </div>
      </summary>
      <div className="diff-review-file-body">
        <DiffBlock diffText={diffText} className="diff-review-diff" />
        {review?.trim() && (
          <div className="diff-review-note">
            <p>{review.trim()}</p>
          </div>
        )}
      </div>
    </details>
  );
};
