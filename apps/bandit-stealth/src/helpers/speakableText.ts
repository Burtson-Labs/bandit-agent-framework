/**
 * Distill an assistant response down to the portion worth reading aloud.
 *
 * TTS over a full assistant transcript would be painful: nobody wants to
 * hear "tool call braces name quote apply underscore edit" or the entire
 * body of a 400-line code fence recited. This extractor keeps the model's
 * prose (which summarizes the work done) and strips everything that's
 * visual-only:
 *
 * - fenced code blocks (```…```) — the user reads the diff, doesn't
 * want it narrated
 * - inline tool-call markup (<tool_call>…</tool_call>)
 * - custom Bandit fence families (bandit-tl, bandit-run, bandit-diff-card,
 * bandit-reasoning, bandit-subagent) — these render as UI widgets
 * - in-stream status markers (`⟳ pondering…`, thinking animations)
 * - markdown heading hashes, list bullets, heavy formatting
 * - HTML tags
 *
 * Returns an empty string when the message is essentially all code / tool
 * activity with no prose — caller uses that signal to skip TTS.
 */
export function extractSpeakableText(content: string): string {
  if (!content) {return '';}
  let text = content;
  // Strip reasoning-mode blocks (body AND tags) BEFORE anything else.
  // Qwen 3.6 / bandit-logic emit <think>…</think> blocks that the user
  // never sees on screen but contain 500+ words of internal reasoning.
  // If we leave that content in the speakable string, the word-count
  // cap ("> 120 words" default) almost always rejects the turn and
  // auto-speak silently does nothing. Strip body-inclusive.
  text = text.replace(/<think\b[\s\S]*?<\/think\s*>/gi, ' ');
  text = text.replace(/<think\b[\s\S]*$/i, ' ');
  // Same for our own bandit-reasoning fence convention.
  text = text.replace(/```bandit-reasoning\b[\s\S]*?```/gi, ' ');
  text = text.replace(/```bandit-reasoning\b[\s\S]*$/i, ' ');
  // Drop fenced blocks of any kind (``` / ~~~ / language-tagged).
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  // Strip inline tool call markup.
  text = text.replace(/<tool_call\b[\s\S]*?<\/tool_call\s*>/gi, ' ');
  text = text.replace(/<tool_result\b[\s\S]*?<\/tool_result\s*>/gi, ' ');
  // Strip in-stream status pills (both legacy `_⟳ _` and current `` `⟳ ` ``).
  text = text.replace(/[`_*]?⟳[^`_*\n]*[`_*]?/g, ' ');
  // Strip inline HTML tags but keep their text content.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  // Collapse markdown heading/list/quote prefixes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s+/gm, '');
  // Strip emphasis wrapping but keep the text.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/_([^_\n]+)_/g, '$1');
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Collapse whitespace and trim.
  text = text.replace(/\s+/g, ' ').trim();
  // If what's left is a few symbols or a trivial fragment, treat as empty
  // — the UI will just not play anything.
  if (text.length < 4) {return '';}
  return text;
}
