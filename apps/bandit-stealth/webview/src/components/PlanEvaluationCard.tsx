import type { JSX } from "react";
import type { PlanRunSummary } from "../types/webview";
import { stripTurnTokens } from "../util/stripTurnTokens";

export function PlanEvaluationCard({ run }: { run: PlanRunSummary | null }): JSX.Element | null {
  const evaluation = run?.evaluation ?? null;
  const hasArtifacts = Boolean(run?.artifactsPath);
  if (!evaluation && !hasArtifacts) {
    return null;
  }
  const goal = stripTurnTokens(run?.goal ?? "") || "Latest plan run";
  const confidence =
    typeof evaluation?.confidence === "number" && Number.isFinite(evaluation.confidence)
      ? `${(evaluation.confidence * 100).toFixed(1)}%`
      : null;
  const completedAt =
    typeof run?.completedAt === "number"
      ? new Date(run.completedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : null;
  return (
    <section className="agent-ui-panel plan-eval-card">
      <header className="plan-eval-card__header">
        <div>
          <p className="plan-eval-card__eyebrow">Run Summary</p>
          <h3 className="plan-eval-card__title">{goal}</h3>
        </div>
        {confidence && <span className="plan-eval-card__confidence">Confidence {confidence}</span>}
      </header>
      {evaluation && (
        <p className="plan-eval-card__status" data-state={evaluation.success ? "success" : "attention"}>
          {evaluation.success ? "Success" : "Needs attention"}
        </p>
      )}
      {evaluation?.feedback && <p className="plan-eval-card__feedback">{evaluation.feedback}</p>}
      <div className="plan-eval-card__meta">
        {completedAt && <span className="plan-eval-card__meta-item">Completed {completedAt}</span>}
        {hasArtifacts && run?.artifactsPath && (
          <span className="plan-eval-card__meta-item">Artifacts {run.artifactsPath}</span>
        )}
      </div>
    </section>
  );
}
