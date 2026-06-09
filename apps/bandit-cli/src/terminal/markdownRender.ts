/**
 * Streaming markdown → ANSI renderer.
 *
 * Models emit responses with markdown markup (`# Header`, `**bold**`,
 * `` `code` ``, fenced blocks, lists, blockquotes). Without rendering
 * those land in the user's terminal as literal asterisks and hashes,
 * which is what the user reported on 2026-04-30 — "the markdown
 * rendering in the cli doesn't seem to be working."
 *
 * Approach: per-line transform with a small state machine for
 * fenced code blocks. Operates AFTER the table renderer so a row
 * like `| **col** |` doesn't get its asterisks collapsed before the
 * table parser sees it. Inline transforms (bold/italic/inline-code)
 * are regex-based and skipped inside code fences.
 *
 * Streaming model: same line-buffered approach as the table renderer.
 * Partial trailing lines stay in `markdownBuffer` until a newline
 * arrives. Prose still streams roughly word-by-word because models
 * tend to emit on word boundaries; the only visible latency is
 * end-of-line markup (a `**bold**` span won't render until its
 * closing `**` lands in the same line).
 */
import { c, supportsBlockArt, supportsTrueColor, downsampleTruecolorTo256 } from '../ansi';
import { resolveLang, highlightCode } from '../syntaxHighlight';
import type { StreamStrippingState } from '../streaming/streamStripping';

export const HEADER_RE = /^(#{1,6})\s+(.*)$/;
export const FENCE_RE = /^(\s*)(```|~~~)(.*)$/;
export const BLOCKQUOTE_RE = /^(\s*)>\s?(.*)$/;
export const HRULE_RE = /^\s*(?:[-*_]\s*){3,}\s*$/;
export const ULIST_RE = /^(\s*)([-*+])\s+(.*)$/;
export const OLIST_RE = /^(\s*)(\d{1,3}\.)\s+(.*)$/;

export function applyInlineMarkdown(text: string): string {
  // Order matters: handle inline code first so its content isn't
  // double-transformed by the bold/italic regexes that follow. Each
  // pass uses the canonical CommonMark-ish form — we don't try to be
  // clever about edge cases (escaped backticks, nested spans), just
  // good enough for what models actually emit.
  let out = text;
  // Inline code `code` — cyan, no further transforms inside.
  // Capture is non-greedy and tolerates one or two backticks.
  out = out.replace(/(`+)([^`\n]+?)\1/g, (_, _ticks, body) => c.cyan(body));
  // Markdown link `[label](url)` — render the label as cyan +
  // underlined and wrap with OSC-8 so the user can Cmd-click in
  // supported terminals. Run BEFORE bold/italic so the URL's
  // `*`/`_` characters can't get eaten by the emphasis regexes.
  out = out.replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g, (_, label: string, url: string) =>
    c.link(c.cyan(c.underline(label)), url)
  );
  // Bare URLs — http(s)://… that wasn't already wrapped in markdown
  // link syntax. Models routinely emit URLs in prose without any
  // bracket/paren markup; making them clickable is the whole point.
  // Skip URLs that already carry an OSC-8 wrapper (the `\x1b]8;;`
  // sequence emitted above) so we don't double-wrap. The trailing
  // `[^…]*` excludes common punctuation that follows a URL in
  // English prose (".", ",", ")", "]") so the link doesn't gobble it.
  out = out.replace(/(?<!\x1b\]8;;)(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`).,;:!?\]])/g, (url: string) =>
    c.link(c.cyan(c.underline(url)), url)
  );
  // Bold **text** — render before italic so `**inner*` isn't half-eaten.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_, body) => c.bold(body));
  // Bold __text__
  out = out.replace(/__([^_\n]+?)__/g, (_, body) => c.bold(body));
  // Italic *text* — must avoid matching `* ` list markers or `**`
  // adjacency. Require non-space on both ends and disallow `*` inside.
  out = out.replace(/(?<![*\w])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?!\w)/g, (_, body) => c.italic(body));
  // Italic _text_ — same constraints, anchored to word boundaries.
  out = out.replace(/(?<![_\w])_([^_\s][^_\n]*?[^_\s]|[^_\s])_(?!\w)/g, (_, body) => c.italic(body));
  return out;
}

// IDE-style code-fence highlighting gate — truecolor only (same gate as the
// diff bands) so 16-color / Apple Terminal / NO_COLOR keep the flat cyan
// block. Code fences have no background band, so tokens reset to the terminal
// default foreground after each span.
const CODE_HIGHLIGHT = supportsBlockArt();
const CODE_TRUECOLOR = supportsTrueColor();
const CODE_FENCE_RESET = '\x1b[39m';

export function renderMarkdownLine(line: string, state: StreamStrippingState): string {
  // Code fence toggles. The fence line itself is rendered as a dim
  // divider so the user sees code-block boundaries without a stray
  // ``` floating in the prose.
  const fenceMatch = FENCE_RE.exec(line);
  if (fenceMatch) {
    state.inCodeFence = !state.inCodeFence;
    const lang = fenceMatch[3].trim();
    state.fenceLang = state.inCodeFence ? lang : undefined;
    return c.dim(state.inCodeFence
      ? (lang ? `── ${lang} ──` : '──────')
      : '──────');
  }
  if (state.inCodeFence) {
    // IDE-style syntax highlighting on truecolor terminals when the fence
    // language is known. Foreground-only over the default background; falls
    // back to the flat cyan block on 16-color / Apple Terminal / NO_COLOR.
    if (CODE_HIGHLIGHT && state.fenceLang) {
      const lang = resolveLang(state.fenceLang);
      if (lang) {
        const lit = highlightCode(line, lang, CODE_FENCE_RESET);
        // Truecolor terminals get the 24-bit palette; 256-color terminals
        // (Apple Terminal) get a downsample — foreground-only, no bleed.
        return CODE_TRUECOLOR ? lit : downsampleTruecolorTo256(lit);
      }
    }
    return c.cyan(line);
  }
  // Horizontal rule: `---`, `***`, `___` (3+ same chars). Avoid
  // colliding with `***bold***` (no spaces between asterisks) by
  // requiring whitespace separation in the regex.
  if (HRULE_RE.test(line) && line.trim().length >= 3) {
    const width = Math.min(process.stdout.columns || 60, 80);
    return c.dim('─'.repeat(width));
  }
  // ATX header: # to ###### with a single bold accent line. Keep
  // depth visible via dim leading marker so nested sections are
  // distinguishable in dense responses.
  const headerMatch = HEADER_RE.exec(line);
  if (headerMatch) {
    const level = headerMatch[1].length;
    const body = applyInlineMarkdown(headerMatch[2]);
    const marker = c.dim('#'.repeat(level));
    return `${marker} ${c.bold(c.accent(body))}`;
  }
  // Blockquote: dim italic, keep `│` rail prefix so it visually
  // detaches from surrounding prose.
  const blockquoteMatch = BLOCKQUOTE_RE.exec(line);
  if (blockquoteMatch) {
    const indent = blockquoteMatch[1];
    const body = applyInlineMarkdown(blockquoteMatch[2]);
    return `${indent}${c.dim('│ ')}${c.italic(body)}`;
  }
  // Unordered list: replace marker with bullet glyph; keep indent.
  const ulistMatch = ULIST_RE.exec(line);
  if (ulistMatch) {
    const indent = ulistMatch[1];
    const body = applyInlineMarkdown(ulistMatch[3]);
    return `${indent}${c.accent('•')} ${body}`;
  }
  // Ordered list: keep `N.` marker but accent it.
  const olistMatch = OLIST_RE.exec(line);
  if (olistMatch) {
    const indent = olistMatch[1];
    const body = applyInlineMarkdown(olistMatch[3]);
    return `${indent}${c.accent(olistMatch[2])} ${body}`;
  }
  return applyInlineMarkdown(line);
}

export function consumeMarkdownInChunk(state: StreamStrippingState, text: string): string {
  if (text.length === 0) return '';
  const combined = state.markdownBuffer + text;
  const lastNl = combined.lastIndexOf('\n');
  if (lastNl === -1) {
    // No newline yet — whole text is a partial line. Hold it back so
    // we can transform whole lines (headers/lists/inline spans need
    // the full line to be safe). Single-iteration cost: at most one
    // line worth of latency, which models cross within a few hundred ms.
    state.markdownBuffer = combined;
    return '';
  }
  const completeChunk = combined.slice(0, lastNl + 1);
  state.markdownBuffer = combined.slice(lastNl + 1);
  const lines = completeChunk.split('\n');
  // The trailing \n splits to an empty final element; drop it so we
  // don't render an extra blank line each chunk.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => renderMarkdownLine(line, state)).join('\n') + '\n';
}

export function flushMarkdownState(state: StreamStrippingState): string {
  if (state.markdownBuffer.length === 0) return '';
  const tail = state.markdownBuffer;
  state.markdownBuffer = '';
  return renderMarkdownLine(tail, state);
}
