import type { JSX } from "react";
import clsx from "clsx";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import { DiffBlock } from "@burtson-labs/agent-ui";
import { LIVE_STATUS_ICON_MAP, type LiveUpdateEntry } from "../state/liveUpdates";

export function LiveUpdatesFeed({
  entries,
  busy
}: {
  entries: LiveUpdateEntry[];
  busy: boolean;
}): JSX.Element {
  return (
    <section className="live-ticker" aria-live="polite" aria-label="Agent progress">
      <header className="live-ticker__header">
        <span>{busy ? "Working" : "Latest run"}</span>
        <span className="live-ticker__pulse" aria-hidden="true" />
      </header>
      <ul className="live-ticker__list">
        {entries.map((entry) => {
          const Icon = LIVE_STATUS_ICON_MAP[entry.status] ?? Cog6ToothIcon;
          const summaryLabel =
            entry.diff?.summary && Number.isFinite(entry.diff.summary.added) && Number.isFinite(entry.diff.summary.removed)
              ? `Δ +${entry.diff.summary.added} / -${entry.diff.summary.removed}`
              : null;
          const confidenceLabel =
            typeof entry.diff?.confidence === "number"
              ? `${Math.round(entry.diff.confidence * 100)}% confidence`
              : null;
          return (
            <li
              key={entry.id}
              className={clsx("live-ticker__item", `live-ticker__item--${entry.status}`)}
            >
              <div className="live-ticker__icon" aria-hidden="true">
                <Icon />
              </div>
              <div className="live-ticker__content">
                {entry.path && <p className="live-ticker__path">{entry.path}</p>}
                <p className="live-ticker__title">{entry.title}</p>
                {entry.summary && <p className="live-ticker__summary">{entry.summary}</p>}
                {(summaryLabel || confidenceLabel) && (
                  <p className="live-ticker__diff-summary">
                    {summaryLabel}
                    {summaryLabel && confidenceLabel && " · "}
                    {confidenceLabel}
                  </p>
                )}
                {entry.diff?.preview && (
                  <DiffBlock source={entry.diff.preview} className="live-ticker__diff-preview" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
