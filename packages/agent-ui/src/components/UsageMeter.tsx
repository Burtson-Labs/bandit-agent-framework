import type { JSX } from "react";
import clsx from "clsx";

/**
 * A used-of-limit meter that never invents a number. `used` missing reads as
 * "Unknown", not 0; a missing or non-positive `limit` shows the usage with
 * no bar, not a full one. Use it for account quotas and context windows.
 */
export interface UsageMeterProps {
  label: string;
  /** Amount used. `null`/`undefined` means the provider didn't report it. */
  used?: number | null;
  /** Ceiling. `null`/`undefined`/≤0 means no limit was reported. */
  limit?: number | null;
  /** Unit appended to the figures, e.g. "tokens". */
  unit?: string;
  /** Secondary line under the bar, e.g. "Resets in 2h 10m". */
  note?: string;
  className?: string;
}

const isKnown = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Percentage of `limit` used, or null when either side is unknown. */
export const usagePercent = (used?: number | null, limit?: number | null): number | null => {
  if (!isKnown(used) || !isKnown(limit) || limit <= 0) {return null;}
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
};

export const UsageMeter = ({ label, used, limit, unit, note, className }: UsageMeterProps): JSX.Element => {
  const pct = usagePercent(used, limit);
  const suffix = unit ? ` ${unit}` : "";
  const figure = !isKnown(used)
    ? "Unknown"
    : pct === null
      ? `${used.toLocaleString()}${suffix} · no limit reported`
      : `${used.toLocaleString()} / ${(limit as number).toLocaleString()}${suffix}`;
  return (
    <div className={clsx("usage-meter", pct === null && "is-unknown", className)}>
      <div className="usage-meter__header">
        <span>{label}</span>
        <span className="usage-meter__figure">{figure}</span>
      </div>
      {pct !== null && (
        <div
          className="usage-meter__track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={figure}
        >
          <div
            className={clsx("usage-meter__fill", pct >= 90 && "is-high")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {note && <p className="usage-meter__note">{note}</p>}
    </div>
  );
};

export interface ContextMeterProps {
  /** Tokens currently in the context window. */
  used?: number | null;
  /** The model's context window size. */
  limit?: number | null;
  className?: string;
}

/** Context-window fill for the active conversation. */
export const ContextMeter = ({ used, limit, className }: ContextMeterProps): JSX.Element => (
  <UsageMeter label="Context" used={used} limit={limit} unit="tokens" className={className} />
);
