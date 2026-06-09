import type { JSX } from "react";
import clsx from "clsx";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import {
  LIVE_STATUS_ICON_MAP,
  LIVE_STATUS_LABELS,
  type LiveUpdateEntry
} from "../state/liveUpdates";

export function LiveStepMessage({ entry }: { entry: LiveUpdateEntry }): JSX.Element {
  const Icon = LIVE_STATUS_ICON_MAP[entry.status] ?? Cog6ToothIcon;
  const statusLabel = LIVE_STATUS_LABELS[entry.status] ?? "Update";
  return (
    <article
      className={clsx("live-step-message", `live-step-message--${entry.status}`)}
      aria-live="polite"
    >
      <div className="live-step-message__status" role="img" aria-label={statusLabel}>
        <Icon aria-hidden="true" />
      </div>
      <div className="live-step-message__body">
        <p className="live-step-message__title">
          {entry.title}
          <span className="live-step-message__badge">{statusLabel}</span>
        </p>
        {entry.summary && <p className="live-step-message__summary">{entry.summary}</p>}
        {entry.path && <p className="live-step-message__path">{entry.path}</p>}
      </div>
    </article>
  );
}
