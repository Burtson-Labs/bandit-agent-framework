import type { JSX } from "react";
import type {
  AgentSummaryContextItem,
  AgentSummaryData,
  AgentSummaryFile
} from "../types/ui-schema";
import { DiffReviewPanel, type DiffItem } from "./DiffReview";

export interface AgentSummaryCardProps {
  data: AgentSummaryData;
  onOpenFile?: (path: string) => void;
  onCopyDiff?: (diff: string) => void;
}

const formatFileMeta = (file: AgentSummaryFile): string | undefined => {
  const parts: string[] = [];
  if (file.summary) {
    parts.push(`+${file.summary.added} / -${file.summary.removed}`);
  }
  if (typeof file.confidence === "number") {
    parts.push(`${Math.round(file.confidence * 100)}% conf.`);
  }
  if (!parts.length) {
    return undefined;
  }
  return parts.join(" • ");
};

const renderContextList = (items: AgentSummaryContextItem[] = []): JSX.Element | null => {
  if (!items.length) {
    return null;
  }
  return (
    <ul className="agent-summary-context">
      {items.map((item) => (
        <li key={`${item.label}-${item.value}`}>
          <span>{item.label}</span>
          <span className="agent-summary-file-meta">{item.value}</span>
        </li>
      ))}
    </ul>
  );
};

const aggregateDiffTotals = (files: AgentSummaryFile[]): { added: number; removed: number } => {
  return files.reduce(
    (acc, file) => {
      if (typeof file.summary?.added === "number") {
        acc.added += file.summary.added;
      }
      if (typeof file.summary?.removed === "number") {
        acc.removed += file.summary.removed;
      }
      return acc;
    },
    { added: 0, removed: 0 }
  );
};

export const AgentSummaryCard = ({
  data,
  onOpenFile,
  onCopyDiff
}: AgentSummaryCardProps): JSX.Element => {
  const files = Array.isArray(data.files) ? data.files : [];
  const updatedPaths = files.map((file) => file.path).filter(Boolean);
  const diffTotals = aggregateDiffTotals(files);

  const handleOpenFile = (path: string): void => {
    onOpenFile?.(path);
  };

  const handleCopyDiff = (path: string, diff: string): void => {
    if (onCopyDiff) {
      onCopyDiff(diff);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(diff);
    }
  };

  const fileDiffItems: DiffItem[] = files
    .map((file) => ({
      filePath: file.path,
      diffText: file.diff ?? "",
      added: file.summary?.added,
      removed: file.summary?.removed,
      confidence: file.confidence,
      review: file.review
    }))
    .filter((item) => item.diffText.trim().length > 0);

  const hasPreview = Boolean(data.diffPreview && data.diffPreview.trim().length > 0);
  const diffItems: DiffItem[] = hasPreview
    ? [
        {
          filePath: updatedPaths.length === 1 ? updatedPaths[0] : "Agent diff preview",
          diffText: data.diffPreview ?? "",
          added: diffTotals.added || undefined,
          removed: diffTotals.removed || undefined,
          confidence: data.confidence
        }
      ]
    : fileDiffItems;
  const diffPanelOnOpenFile = hasPreview ? undefined : handleOpenFile;

  const metricParts: string[] = [];
  if (typeof data.confidence === "number" && Number.isFinite(data.confidence)) {
    metricParts.push(`Confidence ${(data.confidence * 100).toFixed(1)}%`);
  }
  if (typeof data.iterations === "number") {
    metricParts.push(`Iterations ${data.iterations}`);
  }
  if (Array.isArray(data.steps) && data.steps.length) {
    const completed = data.steps.filter((step) => step.status === "complete").length;
    metricParts.push(`${completed}/${data.steps.length} steps`);
  }

  return (
    <article
      className="agent-summary-card"
      data-state={data.success ? "success" : "attention"}
      data-diff={data.diffPreview ?? undefined}
    >
      <header className="agent-summary-header">
        <span className="agent-summary-status">{data.success ? "Success" : "Needs follow-up"}</span>
        {metricParts.length > 0 && (
          <div className="agent-summary-metrics">{metricParts.join(" • ")}</div>
        )}
      </header>

      <div className="agent-summary-body">
        <section className="agent-summary-section">
          <span className="agent-summary-label">Goal</span>
          <p className="agent-summary-goal">{data.goal}</p>
        </section>

        {updatedPaths.length > 0 && (
          <section className="agent-summary-section">
            <span className="agent-summary-label">
              {updatedPaths.length === 1 ? "File Updated" : "Files Updated"}
            </span>
            <ul className="agent-summary-files">
              {updatedPaths.map((path) => {
                const file = files.find((entry) => entry.path === path);
                if (!file) {
                  return null;
                }
                const meta = formatFileMeta(file);
                return (
                  <li key={path} className="agent-summary-file">
                    <button
                      type="button"
                      className="link-button agent-summary-file-link"
                      onClick={() => handleOpenFile(path)}
                    >
                      {path}
                    </button>
                    {meta && <span className="agent-summary-file-meta">{meta}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {data.feedback?.trim() && (
          <section className="agent-summary-section">
            <span className="agent-summary-label">Feedback</span>
            <p className="agent-summary-feedback">{data.feedback.trim()}</p>
          </section>
        )}

        {renderContextList(data.context)}

        {diffItems.length > 0 && (
          <section className="agent-summary-section agent-summary-diff-collection">
            <DiffReviewPanel
              diffs={diffItems}
              onCopyDiff={handleCopyDiff}
              onOpenFile={diffPanelOnOpenFile}
            />
          </section>
        )}

        {data.backupPath && (
          <section className="agent-summary-section">
            <span className="agent-summary-label">Backup</span>
            <p className="agent-summary-backup-line">{data.backupPath}</p>
          </section>
        )}

        {data.reviewMarkdown && (
          <details className="agent-summary-details">
            <summary>Full summary</summary>
            <div className="agent-summary-markdown">{data.reviewMarkdown}</div>
          </details>
        )}
      </div>
    </article>
  );
};
