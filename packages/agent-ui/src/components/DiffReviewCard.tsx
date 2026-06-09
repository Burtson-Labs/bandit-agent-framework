import type { JSX } from "react";
import { classNames } from "../utils/classNames";
import type { DiffReviewPayload } from "../types/ui-schema";

export interface DiffReviewCardProps {
  data: DiffReviewPayload;
  onAction?: (action: "apply" | "explain" | "discard") => void;
  onCopyDiff?: (path: string) => void;
  state?: DiffReviewPayload["state"];
}

export const DiffReviewCard = ({
  data,
  onAction,
  state = data.state ?? "pending"
}: DiffReviewCardProps): JSX.Element => {
  const actions: Array<{ label: string; action: "apply" | "explain" | "discard"; variant: string }> = [
    { label: "Apply", action: "apply", variant: "primary" },
    { label: "Explain", action: "explain", variant: "secondary" }
  ];

  if (data.hasBackup) {
    actions.push({ label: "Discard", action: "discard", variant: "danger" });
  }

  const handleAction = (action: "apply" | "explain" | "discard"): void => {
    if (state === "pending") {
      onAction?.(action);
    }
  };

  const statusMessage = (): string => {
    switch (state) {
      case "apply":
        return "Changes applied.";
      case "explain":
        return "Explaining changes in chat.";
      case "discard":
        return "Changes discarded.";
      case "error":
        return data.message ?? "Unable to perform that action.";
      default:
        return "";
    }
  };

  return (
    <article className="message assistant diff-review" data-state={state}>
      <div className="message-body assistant">
        <div className="message-content">
          <header className="diff-review-header">
            <span className="diff-review-badge">Review</span>
            <code className="diff-review-path">{data.path}</code>
          </header>
          <p className="diff-review-message">
            {data.message ?? "Choose how to handle the proposed changes."}
          </p>
          <div className="diff-review-actions">
            {actions.map(({ label, action, variant }) => (
              <button
                key={action}
                type="button"
                className={classNames("diff-review-button", `diff-review-${variant}`, state !== "pending" && "pending")}
                disabled={state !== "pending"}
                onClick={() => handleAction(action)}
              >
                {label}
              </button>
            ))}
          </div>
          {statusMessage() && <p className="diff-review-status">{statusMessage()}</p>}
        </div>
      </div>
    </article>
  );
};
