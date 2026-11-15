import { useEffect, useId, useState, type JSX } from "react";

/**
 * Bandit's activity indicator: the ninja mark, traced from the Bandit logo and
 * split into the hood (with the eye slit as negative space) and the two eyes,
 * so the eyes can move on their own. One state per thing the agent does:
 *
 *   thinking   eyes glance left, hold, right, hold, blink (the CLI spinner's cadence)
 *   tool       a soft band of light sweeps across the eye slit
 *   streaming  steady eyes, an occasional blink
 *
 * The motion lives in styles/agent-ui.css (`.bandit-thinking-mark`), transform
 * and opacity only. The mark rides `currentColor`: the stylesheet gives it the
 * theme's muted text colour; it is never the accent, never white. Reduced
 * motion renders the static mark with the eyes open.
 *
 * Two renderers share the geometry: the React component for React surfaces,
 * and an HTML string for the VS Code webview, whose chat is markdown rendered
 * to a string and sanitized (DOMPurify keeps inline SVG and `data-*`, `role`,
 * `aria-*` attributes, so the string carries everything the stylesheet and
 * assistive tech need).
 */
export type BanditThinkingState = "thinking" | "tool" | "streaming";

/** The logo's 733-unit box; path coordinates are in it. */
export const BANDIT_MARK_VIEWBOX = "0 0 733 733";

export const BANDIT_MARK_PATHS = {
  hood: "M399 28c-24 2-51 8-71 15-66 24-124 79-153 145l-3 6-5-8c-17-28-43-49-71-55-19-4-27 1-27 18 0 19 7 40 20 59 5 8 24 27 31 33l5 3-4-1c-5-1-18 1-28 3-24 7-54 30-54 42 0 7 11 16 26 21 9 3 26 4 37 2 10-1 28-7 37-12l8-4 0 20c-1 29 2 54 8 81 21 93 84 184 176 253 24 18 60 41 85 53l7 4 9-4c46-24 97-61 135-98 93-91 136-197 128-313-10-136-103-240-232-260-13-2-50-3-62-2z",
  slit: "M648 290c2 25 0 63-4 84-6 26-18 51-30 61-16 13-42 21-65 20-19-1-30-5-72-28-24-13-37-17-54-17-16 0-30 4-52 15-8 4-22 11-31 16-23 12-39 15-59 13-43-4-65-24-79-68-7-23-10-54-8-84 1-10 1-18 1-19 0 0 12 4 38 13 38 14 86 24 137 29 17 2 86 2 104 0 44-4 86-13 124-25 15-4 40-14 45-17 4-2 4-2 5 6z",
  eyeL: "M233 329c3 14 19 30 37 36 3 1 4 2 3 3 0 1-1 6-1 11 0 7 1 9 3 14 3 7 10 13 16 16 7 3 22 3 28 0 11-6 18-17 19-28l0-6 5-1c12-2 25-6 31-11 3-2 3-2-10-5-17-4-120-28-125-29l-4-1 1 3z",
  eyeR: "M590 332c-20 5-83 20-105 25-7 2-13 3-13 3-1 1 11 8 19 10 3 1 8 2 11 3l6 1 0 6c1 12 8 22 20 27 8 4 21 4 29 0 14-7 22-24 17-37l-2-5 4-1c16-4 33-20 36-34 1-3 1-4-22 2z"
} as const;

/** The band of light that crosses the eye slit while a tool runs. */
const BAND_POINTS = "150,262 240,262 205,478 115,478";

/** Accessible name for a state: what a status region around the mark says. */
export const banditThinkingLabel = (state: BanditThinkingState, tool?: string): string => {
  if (state === "tool") {
    return tool ? `Running ${tool}` : "Running a tool";
  }
  return state === "streaming" ? "Writing" : "Bandit is thinking";
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * True when the OS asks for reduced motion. The stylesheet honours the media
 * query on its own; this lets the markup follow too (a plain "…" instead of
 * the dots) and makes the static rendering testable.
 */
export const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(query.matches);
    if (typeof query.addEventListener !== "function") {
      return;
    }
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
};

export interface BanditThinkingMarkProps {
  state?: BanditThinkingState;
  /** Rendered width and height in CSS pixels; the stylesheet may override in em. */
  size?: number;
  className?: string;
}

/**
 * The animated mark alone: decorative, hidden from assistive tech. Put the
 * accessible name (role="status", aria-label) on the row around it.
 */
export const BanditThinkingMark = ({
  state = "thinking",
  size = 16,
  className
}: BanditThinkingMarkProps): JSX.Element => {
  // Each instance clips its own band: a shared id would break the moment the
  // first mark on the page unmounts.
  const clipId = `bandit-mark-slit-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      className={className ? `bandit-thinking-mark ${className}` : "bandit-thinking-mark"}
      data-state={state}
      viewBox={BANDIT_MARK_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={BANDIT_MARK_PATHS.slit} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <polygon className="bm-band" points={BAND_POINTS} />
      </g>
      <path
        className="bm-hood"
        fillRule="evenodd"
        d={BANDIT_MARK_PATHS.hood + BANDIT_MARK_PATHS.slit}
      />
      <g className="bm-lid">
        <g className="bm-eyes">
          <path d={BANDIT_MARK_PATHS.eyeL + BANDIT_MARK_PATHS.eyeR} />
        </g>
      </g>
    </svg>
  );
};

/**
 * A label's trailing ellipsis: three dots that bounce in turn, or a plain "…"
 * under reduced motion. Decorative; render it inside aria-hidden text.
 */
export const BanditThinkingDots = ({ reduced }: { reduced: boolean }): JSX.Element => (
  <>
    {reduced ? null : (
      <span className="bandit-thinking-dots">
        <i />
        <i />
        <i />
      </span>
    )}
    <span className="bandit-thinking-ellipsis">…</span>
  </>
);

let htmlClipCounter = 0;

/** The mark as an HTML string, for renderers that build markup as text. */
export const banditThinkingMarkHtml = (state: BanditThinkingState): string => {
  const clipId = `bandit-mark-slit-h${++htmlClipCounter}`;
  return (
    `<svg class="bandit-thinking-mark" data-state="${state}" viewBox="${BANDIT_MARK_VIEWBOX}" aria-hidden="true">` +
    `<defs><clipPath id="${clipId}"><path d="${BANDIT_MARK_PATHS.slit}"></path></clipPath></defs>` +
    `<g clip-path="url(#${clipId})"><polygon class="bm-band" points="${BAND_POINTS}"></polygon></g>` +
    `<path class="bm-hood" fill-rule="evenodd" d="${BANDIT_MARK_PATHS.hood}${BANDIT_MARK_PATHS.slit}"></path>` +
    `<g class="bm-lid"><g class="bm-eyes"><path d="${BANDIT_MARK_PATHS.eyeL}${BANDIT_MARK_PATHS.eyeR}"></path></g></g>` +
    `</svg>`
  );
};

/** The dots as an HTML string (reduced motion is the stylesheet's, here). */
export const banditThinkingDotsHtml = (): string =>
  `<span class="bandit-thinking-dots"><i></i><i></i><i></i></span><span class="bandit-thinking-ellipsis">…</span>`;

/**
 * Which state a `⟳ …` status phrase from the agent describes. The extension
 * emits "generating tool call · …" and "streaming response…" around the
 * model's rotating thinking phrases (apps/bandit-stealth/src/agent/
 * statusIndicators.ts, turnFinalize.ts).
 */
export const statusPhraseState = (phrase: string): BanditThinkingState => {
  const p = phrase.trim().toLowerCase();
  if (p.startsWith("generating tool call") || p.startsWith("running ")) {
    return "tool";
  }
  if (p.startsWith("streaming response")) {
    return "streaming";
  }
  return "thinking";
};

/** The tool named in a tool-state phrase, if it says one ("running bash"). */
const statusPhraseTool = (phrase: string): string | undefined => {
  const m = /^running\s+(.+?)(?:\s*[·…]|\.{3}|$)/i.exec(phrase.trim());
  return m?.[1]?.trim() || undefined;
};

/**
 * The chat's status line as an HTML string: the mark, the phrase one letter
 * per span (the stylesheet's `:nth-child` stagger carries an accent wave
 * across them), and the bouncing dots as the phrase's ellipsis. The whole
 * line is one `role="status"` region named for the state; the visible phrase
 * is aria-hidden, so a phrase that changes never re-announces.
 *
 * `phrase` is the text after `⟳`, already HTML-escaped by the markdown
 * renderer. A phrase holding an entity (`&amp;`) renders flat rather than be
 * split mid-entity.
 */
export const banditStatusLineHtml = (phrase: string): string => {
  const state = statusPhraseState(phrase);
  const words = phrase.replace(/\s*(?:…|\.{3})\s*$/u, "").trimEnd();
  const inner = /[&<>]/.test(words)
    ? words
    : Array.from(words, (ch) =>
        ch === " " ? " " : `<span class="bandit-status-char">${ch}</span>`
      ).join("");
  const label = banditThinkingLabel(state, state === "tool" ? statusPhraseTool(words) : undefined);
  return (
    `<span class="bandit-status-line bandit-thinking" role="status" aria-label="${label}" data-state="${state}">` +
    banditThinkingMarkHtml(state) +
    `<span class="bandit-status-text" aria-hidden="true">${inner}${banditThinkingDotsHtml()}</span>` +
    `</span>`
  );
};
