/**
 * Best-effort detection of "the assistant just asked a yes/no question"
 * so the REPL can render an inline [y]/[n] shortcut. Must be conservative —
 * firing on open-ended questions creates a confusing UX ("pick y/n"
 * when the model was asking for a file path). Only triggers when the
 * response ends with a `?` AND contains one of a narrow set of
 * affirmative-pivot phrases in the last sentence.
 */

// Only the phrases that unambiguously invite a yes/no ACTION — i.e. the
// model is explicitly offering to perform a next step for the user. Old
// list included `\bcan i\b` and `\bmay i\b`, which fire on rhetorical
// language that verbose reasoning models (bandit-logic / Qwen 3.6
// thinking mode) emit routinely — "Can I summarize the changes?",
// "May I walk through the flow?" are STATEMENTS of intent, not
// actionable prompts. Those got users the [y]/[n] hint after plain
// summaries, which was the bug.
const YES_NO_PATTERNS = [
  /\bwould you like\b/i,
  /\bshould i\b/i,
  /\bdo you want\b/i,
  /\bwant me to\b/i,
  /\bshall i\b/i,
  /\bproceed\??$/i,
  /\bok(ay)? (to|with|for)\b/i,
  /\bis that (ok|okay|fine|right|correct)\b/i
];

/**
 * Strip reasoning/thinking scaffolding that leaks into `finalResponse` but
 * is hidden from the user's terminal by the streaming sanitizer. Qwen 3.6
 * (bandit-logic) emits <think>…</think> blocks, and every model supporting
 * the "bandit-reasoning" fence convention emits ```bandit-reasoning …```
 * sections. Both commonly contain rhetorical prose like "Should I
 * introduce myself?" that ended with a `?` and triggered the y/n hint on
 * plain "who are you?" style answers even though the user never saw the
 * thinking text. Detector operates on the USER-VISIBLE tail only.
 */
export function stripHiddenReasoningForDetection(text: string): string {
  return text
    // <think>…</think> blocks (Qwen reasoning-mode)
    .replace(/<think\b[\s\S]*?<\/think\s*>/gi, '')
    // Unterminated <think> mid-stream (shouldn't happen in finalResponse
    // but guard anyway)
    .replace(/<think\b[\s\S]*$/i, '')
    // ```bandit-reasoning …``` fences (our own convention)
    .replace(/```bandit-reasoning\b[\s\S]*?```/gi, '')
    // Unterminated bandit-reasoning opener
    .replace(/```bandit-reasoning\b[\s\S]*$/i, '')
    .trim();
}

export function looksLikeYesNoQuestion(text: string): boolean {
  const visible = stripHiddenReasoningForDetection(text);
  if (!visible || !visible.endsWith('?')) return false;

  // Skip if the tail is inside a code fence. Models sometimes close
  // an answer with a command example like:
  // ```bash
  // curl https://...?q=1
  // ```
  // which ends with `?` inside the fence — not a question. We detect
  // this by counting ``` delimiters after the last double-newline;
  // an odd count means we're still inside a fence when we hit end-of-text.
  const lastBreak = visible.lastIndexOf('\n\n');
  const fenceScope = lastBreak >= 0 ? visible.slice(lastBreak) : visible;
  const fenceCount = (fenceScope.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) return false;

  // Only scan the last sentence — otherwise a long explanation that
  // includes an incidental rhetorical question 3 paragraphs up would
  // false-positive. Split on ". " or "\n\n" — whichever is closer.
  const lastPeriod = visible.lastIndexOf('. ');
  const cutoff = Math.max(lastBreak, lastPeriod);
  const tail = cutoff >= 0 ? visible.slice(cutoff + 1) : visible;
  if (!YES_NO_PATTERNS.some(re => re.test(tail))) return false;
  // Multi-choice escape hatch (2026-05-06). "Want me to dig into anything
  // specific — resource usage, pods, etc.?" matches `want me to` + ends
  // with `?` but is offering alternatives, not a yes/no. Skip the hint
  // when the tail looks like an enumerated list:
  // - has an em-dash followed by 2+ comma-separated items
  // - contains the word "etc"
  // - has 2+ commas (typical of a list)
  // Single-comma "Want me to fix that, [name]?" stays a y/n.
  if (/\betc\.?\??$/i.test(tail)) return false;
  if (/[—-]\s*[^,]+,\s*[^,]+/.test(tail)) return false;
  const commaCount = (tail.match(/,/g) ?? []).length;
  if (commaCount >= 2) return false;
  // open-question prefix guard. "What would you like to do
  // next?" / "Where would you like the file?" / "What do you want me to
  // focus on?" all match the y/n patterns above (the offered-verb-phrase
  // matched) but are actually open questions, not yes/no. When the tail
  // STARTS with a wh-word, treat the whole thing as open. Captured
  // 2026-05-23: assistant said "Yes, I'm here and ready to go. ... What
  // would you like to do next?" and the [y]/[n] shortcut rendered
  // beneath it, asking the user to confirm/deny an answer-style
  // statement that was never a yes/no question.
  const trimmedTail = tail.trimStart();
  if (/^(what|which|where|when|how|why|who)\b/i.test(trimmedTail)) return false;
  return true;
}
