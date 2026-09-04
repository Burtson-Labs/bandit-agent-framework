/**
 * Phase 10 — routing heuristics (the cheap pre-gate).
 *
 * Empirical routing (Phase 10 proper) needs the BanditBench baseline to say
 * WHICH execution mode wins for WHICH task shape. But calling the planner
 * model on every prompt just to hear "this is a plain loop" is wasteful — most
 * prompts are obviously not graph-shaped. This module is the zero-inference
 * pre-gate: a fast, explainable signal for whether a prompt is even worth
 * asking the planner about.
 *
 * It NEVER decides execution — it only gates the (paid) planner call:
 *   score low   → don't bother the planner; run the normal loop
 *   score high  → the prompt smells decomposable; offer/consult the planner
 *
 * Deliberately conservative and transparent (returns its reasons) so a host
 * can log why it routed, and so tuning it against the bench is inspectable
 * rather than a black box. "graph rarely wins" is the null hypothesis the
 * bench exists to test, so the bar to even SUGGEST a graph is high.
 */

export interface GraphShapeSignal {
  /** 0..1 — how graph-shaped the prompt looks. */
  score: number;
  /** Human-readable contributors, for logging + tuning. */
  reasons: string[];
  /** Convenience: score >= the suggest threshold. */
  suggestsGraph: boolean;
}

export interface GraphShapeOptions {
  /** Score at/above which we'd consult the planner. Default 0.6 (high bar). */
  suggestThreshold?: number;
}

// Phrases that signal INDEPENDENT sub-parts (the thing a graph is for).
const MULTI_PART_MARKERS = [
  /\bcompare\b[\s\S]*\b(?:and|vs\.?|versus|with|to|against)\b/i, // two-sided compare
  /\bcontrast\b/i,
  /\beach of\b/i,
  /\bboth\b[\s\S]*\band\b/i,
  /\bin parallel\b/i,
  /\bseparately\b/i,
  /\bindependently\b/i,
  /\bacross (the |these |all )?\w+/i,
  /\bfor (?:each|every)\b/i,
  // Sequential fan-in: "…then/finally summarize/combine/merge the results".
  /\b(?:then|afterwards|finally)\b[\s\S]*\b(?:summari[sz]|synthesi[sz]|combin|merg|compil)/i,
];

// Explicit enumeration: "A, B, and C" or "A and B" of comparable nouns.
const AND_LIST = /\b\w[\w./-]*(?:,\s*\w[\w./-]*)+\s*,?\s*and\s+\w[\w./-]*/i;
const SIMPLE_AND = /\band\b/i;

// A synthesis verb paired with multiple sources is the classic fan-in shape.
// "compar(e|ison)" counts here too — a comparison IS a synthesis over sources.
const SYNTHESIS_MARKERS = [
  /\bsummari[sz]e\b/i,
  /\bsynthesi[sz]e\b/i,
  /\bcombine\b/i,
  /\breport\b/i,
  /\boverview\b/i,
  /\bcompar(?:e|ison|ing)\b/i,
];

// Strong single-step signals that argue AGAINST a graph regardless.
const SINGLE_STEP_MARKERS = [
  /\bfix (the |a )?typo\b/i,
  /\brename\b/i,
  /\bbump (the )?version\b/i,
  /^\s*(what|where|when|who|why|how)\b.*\?\s*$/i, // a single question
  /\badd (a |an )?(comment|line|import|field)\b/i,
];

/** Count distinct file-ish tokens (paths, dotted names) mentioned. */
function fileMentions(text: string): number {
  const matches = text.match(/\b[\w-]+\/[\w./-]+|\b[\w-]+\.(ts|tsx|js|jsx|py|cs|go|rs|md|json|ya?ml|sh)\b/gi) ?? [];
  return new Set(matches.map((m) => m.toLowerCase())).size;
}

/**
 * Score how graph-shaped a prompt looks. Pure, fast, no model call.
 */
export function classifyGraphShaped(prompt: string, opts: GraphShapeOptions = {}): GraphShapeSignal {
  const threshold = opts.suggestThreshold ?? 0.6;
  const text = prompt.trim();
  const reasons: string[] = [];
  let score = 0;

  // Very short prompts are almost never worth decomposing.
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 8) {
    return { score: 0, reasons: ['prompt too short to decompose'], suggestsGraph: false };
  }

  // Hard single-step signals cap the score low — a typo fix is a typo fix.
  for (const re of SINGLE_STEP_MARKERS) {
    if (re.test(text)) {
      return { score: 0.1, reasons: [`single-step marker: ${re.source}`], suggestsGraph: false };
    }
  }

  const multiPartHits = MULTI_PART_MARKERS.filter((re) => re.test(text));
  if (multiPartHits.length > 0) {
    score += 0.4;
    reasons.push(`multi-part phrasing (${multiPartHits.length})`);
  }

  const files = fileMentions(text);
  if (files >= 3) {
    score += 0.3;
    reasons.push(`${files} distinct files/paths mentioned`);
  } else if (files === 2) {
    score += 0.15;
    reasons.push('2 files/paths mentioned');
  }

  const hasSynthesis = SYNTHESIS_MARKERS.some((re) => re.test(text));
  const hasList = AND_LIST.test(text);
  if (hasSynthesis && (hasList || multiPartHits.length > 0 || files >= 2)) {
    // Synthesis over multiple things = the fan-in a graph handles well.
    score += 0.3;
    reasons.push('synthesis over multiple sources');
  } else if (hasList) {
    score += 0.15;
    reasons.push('enumerated list of targets');
  } else if (SIMPLE_AND.test(text) && words >= 20) {
    // A bare "and" in a long prompt is weak evidence at most.
    score += 0.05;
    reasons.push('conjunction in a long prompt');
  }

  // Long, dense prompts have more room for separable work.
  if (words >= 40) {
    score += 0.1;
    reasons.push('long prompt');
  }

  score = Math.min(1, score);
  if (reasons.length === 0) reasons.push('no graph-shape signals');
  return { score, reasons, suggestsGraph: score >= threshold };
}
