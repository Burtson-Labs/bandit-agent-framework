const CONTROL_TOKEN_REGEXES: RegExp[] = [
  /<\/?\|?(?:im_start|im_end|start_of_turn|end_of_turn)\|?>/gi,
  /<\s*end_of_turn\s*>/gi,
  /<\s*endofturn\s*>/gi
];

const ROLE_PREFIX_REGEX = /(^|\n)\s*(?:user|assistant|system|tool)\s*[:：]\s*/gi;

// Some small models (observed: bandit-core-1 on pburg-bowl, Apr 2026)
// stream raw HTML instead of markdown — wrapping every sentence in
// `<p>…</p>` and every identifier in `<code>…</code>`. The markdown-it
// renderer runs with `html: false`, so those tags arrive in the user's
// chat as literal escaped text ("<p>Wait, I see <code>foo.ts</code>…</p>").
// Convert the handful of structural tags we actually see into their
// markdown equivalents before rendering. Everything else that looks
// tag-ish gets stripped so it never reaches the user as escaped angle
// brackets. This is defense-in-depth: the renderer also runs DOMPurify
// downstream, so even if an exotic tag slips through the markdown pass
// it cannot execute.
function convertInlineHtmlToMarkdown(input: string): string {
  let out = input;
  // `<code>…</code>` → `` `…` ``. `[\s\S]*?` so it survives newlines.
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) =>
    '`' + inner.replace(/`/g, '\\`') + '`'
  );
  // `<pre>…</pre>` → fenced block.
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) =>
    '\n```\n' + inner + '\n```\n'
  );
  // `<strong>` / `<b>` → **bold**
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) =>
    `**${inner}**`
  );
  // `<em>` / `<i>` → *italic*
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) =>
    `*${inner}*`
  );
  // Paragraph / break / list structural tags → newlines & bullets.
  out = out.replace(/<br\s*\/?\s*>/gi, '\n');
  out = out.replace(/<\/p\s*>/gi, '\n\n');
  out = out.replace(/<p[^>]*>/gi, '');
  out = out.replace(/<\/?(?:div|section|article|header|footer|main|aside)[^>]*>/gi, '\n');
  out = out.replace(/<li[^>]*>/gi, '- ');
  out = out.replace(/<\/li\s*>/gi, '\n');
  out = out.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n');
  return out;
}

// Catch-all: any remaining `<tagname…>` or `</tagname>` pair that the
// conversions above missed. Stripped rather than converted because we
// have no sensible markdown equivalent and leaving them as literal text
// is worse than dropping them. Deliberately narrow (letter-starting
// tag name) so real `<` in prose ("x < 5") is left alone.
const STRAY_HTML_TAG_REGEX = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/g;

// Tool-call envelope (and its content) must be stripped entirely before
// the generic tag pass runs — otherwise the tags go but the JSON body
// (`{"name":"apply_edit","params":{"find":"…entire function body…"}}`)
// stays visible in the chat. Covers both closed blocks and the
// partial/unclosed form that arrives mid-stream.
const TOOL_CALL_BLOCK_REGEX = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi;
const TOOL_CALL_OPEN_TAIL_REGEX = /<tool_call\b[\s\S]*$/i;

// Trailing partial tag starter, e.g. `…foo<` or `…foo<tool_ca`, left
// behind when the stream cuts mid-tag. Without this the user sees a
// bare `<` hanging off the last visible line until the next chunk
// arrives.
const PARTIAL_TAG_TAIL_REGEX = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?$|<$/;

// Gemma-family models (observed: bandit-core:12b-it-qat on pburg-bowl,
// Apr 2026) frequently emit a bare `>` as the first character of every
// assistant response — a chat-template artifact that isn't stripped by
// our existing control-token regex because it's just the closing
// bracket, not a recognizable tag. Real Markdown blockquotes require
// a space after the `>` (`> quoted text`), so the safe heuristic is:
// strip a leading `>` ONLY when it's immediately followed by a
// non-whitespace character. That preserves intentional blockquotes
// and removes the Gemma artifact.
const GEMMA_LEADING_ANGLE_REGEX = /(^|\n)>(?=\S)/g;

/**
 * Strip base64-of-binary blobs that leak into streamed response text —
 * typically on multimodal turns where the gateway/model echoes the
 * image_url payload, or when a small model recites its own prompt.
 * A blob is 120+ consecutive base64-valid chars with no whitespace,
 * optionally prefixed by `data:<mime>;base64,`. Replaced with a short
 * `[base64 stripped: NNN chars]` marker so the user sees that something
 * was elided without being shown the wall of characters. 120 is
 * conservative — real base64 in code (JWTs, auth tokens, sha refs) is
 * rarely on a single unbroken line past ~100 chars; embedded images
 * are 10k+.
 */
export function stripBase64Blobs(text: string): string {
  const BLOB = /(?:data:[\w/.+-]+;base64,)?[A-Za-z0-9+/]{120,}={0,2}/g;
  return text.replace(BLOB, (match) => `[base64 stripped: ${match.length} chars]`);
}

/**
 * Remove leaked control tokens and tidy up model output before rendering.
 */
export function sanitizeModelOutput(text: string | null | undefined): string {
  if (!text) {
    return "";
  }
  let sanitized = text.replace(/\r\n/g, "\n");
  sanitized = stripBase64Blobs(sanitized);
  for (const regex of CONTROL_TOKEN_REGEXES) {
    sanitized = sanitized.replace(regex, "");
  }
  // Strip complete `<tool_call>…</tool_call>` blocks *with their body*
  // first, then any unclosed tool_call tail left mid-stream. Must run
  // before the generic tag strip below, which would remove the tags
  // and leave the JSON body visible.
  sanitized = sanitized.replace(TOOL_CALL_BLOCK_REGEX, "");
  sanitized = sanitized.replace(TOOL_CALL_OPEN_TAIL_REGEX, "");
  // Convert HTML-wrapped prose into markdown before any other processing
  // so the role-prefix / whitespace passes below operate on the stripped
  // form.
  sanitized = convertInlineHtmlToMarkdown(sanitized);
  sanitized = sanitized.replace(STRAY_HTML_TAG_REGEX, "");
  // Drop any trailing partial tag starter (`…foo<` or `…foo<tool_c`)
  // left by a chunk boundary so the user never sees a bare `<` while
  // streaming.
  sanitized = sanitized.replace(PARTIAL_TAG_TAIL_REGEX, "");
  // Strip the Gemma-family leading `>` artifact (e.g. `>Okay…`) while
  // keeping real blockquotes (`> quoted text`) intact.
  sanitized = sanitized.replace(GEMMA_LEADING_ANGLE_REGEX, "$1");
  sanitized = sanitized.replace(ROLE_PREFIX_REGEX, "$1");
  sanitized = sanitized.replace(/\u00a0/g, " "); // convert non-breaking spaces
  sanitized = sanitized.replace(/[ \t]+\n/g, "\n");
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");
  return sanitized.trim();
}

export const controlTokenRegexes = CONTROL_TOKEN_REGEXES;
