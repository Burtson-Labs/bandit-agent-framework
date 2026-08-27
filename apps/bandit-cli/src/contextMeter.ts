/**
 * Context-window pressure for the status bar.
 *
 * The status bar showed a running token count — `~12K tok` — which is a number
 * without a denominator. The signal a user actually wants is how full the
 * context window is RIGHT NOW, because that percentage is what predicts when
 * compaction kicks in and answer quality starts to slip. `18K / 128K (14%)`
 * tells you you're fine; `120K / 128K (94%)` tells you to wrap up or /compact.
 *
 * Pure and dependency-free so it's unit-testable without a model or a terminal.
 */

/** Rough char→token estimate — the same ~4-chars-per-token the loop uses. */
export function estimateTokens(text: string): number {
  if (!text) {return 0;}
  return Math.ceil(text.length / 4);
}

/** Sum the estimated tokens across a set of message contents. */
export function estimateConversationTokens(messages: Array<{ content?: string }>): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {chars += m.content.length;}
  }
  return Math.ceil(chars / 4);
}

export type ContextPressure = 'ok' | 'warn' | 'high';

export interface ContextMeter {
  /** Compact label, e.g. "ctx 18K/128K 14%". */
  label: string;
  /** Fraction used in [0, 1]. */
  fraction: number;
  /** Banding for coloring — warn at ≥75%, high at ≥90%. */
  pressure: ContextPressure;
}

function compact(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // One decimal below 10K, whole numbers above — but drop a trailing ".0" so
    // 8000 reads "8K", not "8.0K".
    const s = k >= 100 ? String(Math.round(k)) : k.toFixed(k >= 10 ? 0 : 1);
    return `${s.replace(/\.0$/, '')}K`;
  }
  return String(n);
}

/**
 * Build the context meter from current usage and the window size.
 *
 * Returns null when the window is unknown (≤0) — better to show nothing than a
 * meter divided by a guessed denominator, which would mislead exactly when the
 * user is trusting it to decide whether to compact.
 */
export function formatContextMeter(usedTokens: number, windowTokens: number): ContextMeter | null {
  if (!windowTokens || windowTokens <= 0) {return null;}
  const used = Math.max(0, usedTokens);
  const fraction = Math.min(1, used / windowTokens);
  const pct = Math.round(fraction * 100);
  const pressure: ContextPressure = fraction >= 0.9 ? 'high' : fraction >= 0.75 ? 'warn' : 'ok';
  return {
    label: `ctx ${compact(used)}/${compact(windowTokens)} ${pct}%`,
    fraction,
    pressure,
  };
}
