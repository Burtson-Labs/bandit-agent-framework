/**
 * Degenerate-repetition detector for streamed model output.
 *
 * Real failure (2026-10-19 model sweep): gemma4:12b — and once gemma4:26b —
 * sometimes falls into a loop in its THINKING channel, emitting
 * `<|channel>thought ` back to back for as long as the server lets it (30k
 * chars in four minutes, still going). The tokens keep the stream alive, so no
 * idle timer ever fires; the turn just burns GPU until something gives up.
 *
 * The rule here is deliberately narrow so that it never stops a model doing
 * real work: it flags ONLY when the last `minRun` characters of a channel are a
 * single unit of 1..`maxUnit` characters repeated back to back with no
 * variation at all (exact periodicity). Anything that changes — a counter, an
 * identifier, a table cell, a word — breaks the period and resets the match.
 * Tables of numbers, repeated test cases, lists of similar import lines and
 * long code all vary within any 4000-character window; a line of separators is
 * at most a few hundred characters. See outputLoopDetector.test.ts for the
 * legitimate shapes this is pinned against.
 */

/** Characters of exact repetition required before the thinking channel trips. */
export const THINKING_LOOP_MIN_RUN = 4000;
/** Longest repeating unit considered. Longer cycles are left to the agent loop's own detectors. */
export const LOOP_MAX_UNIT = 80;
/** How often (in appended chars) the tail is re-checked — bounds CPU on long streams. */
const CHECK_EVERY = 200;

/** Error code carried by {@link ModelOutputLoopError}. */
export const MODEL_OUTPUT_LOOP_CODE = 'MODEL_OUTPUT_LOOP';
/** Message prefix of {@link ModelOutputLoopError}; agent-core matches on it as well as the code. */
export const MODEL_OUTPUT_LOOP_PREFIX = 'Model output loop detected';

export type OutputChannel = 'thinking' | 'content';

export interface PeriodicTailMatch {
  /** The repeating unit (period-length substring at the end of the text). */
  unit: string;
  /** Length of the exactly-periodic window that was checked. */
  run: number;
}

/**
 * Returns the smallest unit (length 1..maxUnit) such that the last `minRun`
 * characters of `text` are that unit repeated back to back, or null.
 */
export function findPeriodicTail(text: string, minRun: number, maxUnit = LOOP_MAX_UNIT): PeriodicTailMatch | null {
  const n = text.length;
  if (minRun <= 0 || n < minRun) {return null;}
  const start = n - minRun;
  const limit = Math.min(maxUnit, Math.floor(minRun / 2));
  for (let p = 1; p <= limit; p++) {
    let periodic = true;
    // Walk backwards: a mismatch near the end is found immediately for normal text.
    for (let i = n - 1; i >= start + p; i--) {
      if (text.charCodeAt(i) !== text.charCodeAt(i - p)) {
        periodic = false;
        break;
      }
    }
    if (periodic) {
      return { unit: text.slice(n - p), run: minRun };
    }
  }
  return null;
}

export class ModelOutputLoopError extends Error {
  readonly code = MODEL_OUTPUT_LOOP_CODE;
  readonly channel: OutputChannel;
  readonly unit: string;
  readonly run: number;

  constructor(channel: OutputChannel, match: PeriodicTailMatch) {
    const shown = JSON.stringify(match.unit.length > 40 ? `${match.unit.slice(0, 40)}…` : match.unit);
    super(
      `${MODEL_OUTPUT_LOOP_PREFIX}: the model repeated ${shown} for ${match.run}+ characters in its ${channel} ` +
      'without variation, so the request was stopped. This is a sampling loop in the model, not a slow or cold start.'
    );
    this.name = 'ModelOutputLoopError';
    this.channel = channel;
    this.unit = match.unit;
    this.run = match.run;
  }
}

export function isModelOutputLoopError(error: unknown): boolean {
  if (error instanceof ModelOutputLoopError) {return true;}
  if (typeof error !== 'object' || error === null) {return false;}
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === MODEL_OUTPUT_LOOP_CODE
    || (typeof message === 'string' && message.startsWith(MODEL_OUTPUT_LOOP_PREFIX));
}

export interface OutputLoopDetectorOptions {
  /**
   * Minimum exact-repetition run per channel; 0 or undefined disables that
   * channel. Defaults: thinking = THINKING_LOOP_MIN_RUN, content = disabled.
   *
   * Why content is OFF by default: the agent loop (agent-core
   * streamAndAggregate) already guards the content channel with a
   * repeated-line check, a repeated-window fingerprint and a 24k hard cap, and
   * native tool-call arguments (where big files are written) are buffered by
   * Ollama and never stream through here. A second content kill switch would
   * add false-positive surface — a user who asks for a long run of one
   * character, a wide zero-filled array on one line — and catch nothing the
   * loop does not. The thinking channel has no other guard: hosts route it to
   * a display hook, so the loop never sees it.
   */
  minRun?: Partial<Record<OutputChannel, number>>;
  maxUnit?: number;
}

/** Rolling per-channel tail checker. Feed it streamed deltas; it returns a match once a channel degenerates. */
export class OutputLoopDetector {
  private readonly minRun: Record<OutputChannel, number>;
  private readonly maxUnit: number;
  private readonly tails: Record<OutputChannel, string> = { thinking: '', content: '' };
  private readonly sinceCheck: Record<OutputChannel, number> = { thinking: 0, content: 0 };

  constructor(opts: OutputLoopDetectorOptions = {}) {
    this.minRun = {
      thinking: opts.minRun?.thinking ?? THINKING_LOOP_MIN_RUN,
      content: opts.minRun?.content ?? 0
    };
    this.maxUnit = opts.maxUnit ?? LOOP_MAX_UNIT;
  }

  /** Append a delta; returns the match when the channel's tail is degenerate, else null. */
  push(channel: OutputChannel, delta: string): PeriodicTailMatch | null {
    const minRun = this.minRun[channel];
    if (!delta || !minRun) {return null;}
    let tail = this.tails[channel] + delta;
    // Keep a little more than the window so the check always sees a full run.
    const keep = minRun + CHECK_EVERY + this.maxUnit;
    if (tail.length > keep * 2) {tail = tail.slice(tail.length - keep);}
    this.tails[channel] = tail;
    this.sinceCheck[channel] += delta.length;
    if (tail.length < minRun || this.sinceCheck[channel] < CHECK_EVERY) {return null;}
    this.sinceCheck[channel] = 0;
    return findPeriodicTail(tail, minRun, this.maxUnit);
  }
}
