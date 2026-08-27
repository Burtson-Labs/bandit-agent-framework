/**
 * How much of a thinking model's chain-of-thought to show in the transcript.
 *
 * Reasoning models (bandit-core-2 and friends) can spend most of a turn in a
 * `<think>` block, and dumping all of it as dim italic buries the actual answer
 * under a wall of "Let me… Actually… Wait…". This picks how much to render.
 * Pure and UI-free so the banding is testable without a terminal.
 *
 * The reasoning is still generated in full — thinking is where these models
 * choose their tools, so it can't be turned off — this only controls DISPLAY.
 */

export type ReasoningDisplay = 'full' | 'compact' | 'off';

export const REASONING_DISPLAY_MODES: readonly ReasoningDisplay[] = ['full', 'compact', 'off'] as const;

export function isReasoningDisplay(v: unknown): v is ReasoningDisplay {
  return typeof v === 'string' && (REASONING_DISPLAY_MODES as readonly string[]).includes(v);
}

/** Lines shown before a compact block collapses the rest. */
export const COMPACT_REASONING_LINES = 6;

export interface ReasoningRender {
  /** Lines of reasoning to print (already trimmed to the mode). */
  lines: string[];
  /** A short trailing note when content was hidden, e.g. "+18 more lines".
   *  Empty when nothing was collapsed. */
  collapsedNote: string;
  /** True when the block should render at all. `off` still returns a one-line
   *  marker via `collapsedNote`, so callers check `lines.length`. */
  show: boolean;
}

/**
 * Decide what to render for a reasoning block under the given mode.
 *
 *  - `full`:    every line.
 *  - `compact`: the first COMPACT_REASONING_LINES lines; the rest becomes a
 *               "+N more lines · /reasoning full" note.
 *  - `off`:     no body, just a one-line "thought for N lines" marker so the
 *               user still knows the model paused to think.
 */
export function renderReasoning(body: string, mode: ReasoningDisplay): ReasoningRender {
  const allLines = body.split('\n');
  const total = allLines.length;

  if (mode === 'off') {
    return {
      lines: [],
      collapsedNote: `thought for ${total} line${total === 1 ? '' : 's'} · /reasoning compact to show`,
      show: true,
    };
  }

  if (mode === 'compact' && total > COMPACT_REASONING_LINES) {
    const hidden = total - COMPACT_REASONING_LINES;
    return {
      lines: allLines.slice(0, COMPACT_REASONING_LINES),
      collapsedNote: `+${hidden} more line${hidden === 1 ? '' : 's'} · /reasoning full to expand`,
      show: true,
    };
  }

  // full, or compact that fits
  return { lines: allLines, collapsedNote: '', show: true };
}
