import type { JSX, MouseEvent } from "react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { sanitizeModelOutput } from "@burtson-labs/core-chat";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import morphdom from "morphdom";
// The Token constructor lives under markdown-it/lib/token and isn't typed in @types,
// so suppress the type error on import.
// @ts-expect-error no types for markdown-it/lib/token
import Token from "markdown-it/lib/token";
// @ts-expect-error no types for markdown-it/lib/token
import type TokenCtor from "markdown-it/lib/token";
type MarkdownToken = InstanceType<TokenCtor>;

const FILE_REFERENCE_REGEX =
  /(?:[A-Za-z0-9._-]+\/)+(?:[A-Za-z0-9._-]+)(?:\.[A-Za-z0-9]+)?(?::\d+(?:-\d+)?)?/g;

export interface MarkdownRenderOptions {
  resolveFileHref?: (reference: string) => string | undefined;
}

export interface MarkdownMessageProps extends MarkdownRenderOptions {
  content: string;
  className?: string;
  /**
   * Optional override for rendering markdown to HTML. If not provided,
   * a shared MarkdownIt renderer with linkify + syntax highlighting is used.
   */
  renderHtml?: (content: string) => string;
  onFileReferenceClick?: (reference: string, event: MouseEvent<HTMLDivElement>) => void;
}

const createFileLinkTokens = (
  md: MarkdownIt,
  reference: string,
  href?: string
): MarkdownToken[] => {
  const linkOpen = new Token("link_open", "a", 1);
  linkOpen.attrSet("href", href ?? "#");
  linkOpen.attrSet("data-file-ref", reference);
  if (href) {
    linkOpen.attrSet("target", "_blank");
    linkOpen.attrSet("rel", "noreferrer");
  }
  const textToken = new Token("text", "", 0);
  textToken.content = reference;
  const linkClose = new Token("link_close", "a", -1);
  return [linkOpen, textToken, linkClose];
};

const fileReferencePlugin = (
  md: MarkdownIt,
  resolveFileHref?: MarkdownRenderOptions["resolveFileHref"]
): void => {
  md.core.ruler.after("inline", "file-references", (state) => {
    state.tokens.forEach((blockToken) => {
      if (blockToken.type !== "inline" || !blockToken.children) {
        return;
      }
      const children: MarkdownToken[] = [];
      let insideLink = false;
      (blockToken.children as MarkdownToken[]).forEach((token) => {
        if (token.type === "link_open") {
          insideLink = true;
          children.push(token);
          return;
        }
        if (token.type === "link_close") {
          insideLink = false;
          children.push(token);
          return;
        }
        if (token.type === "code_inline" || token.type !== "text" || insideLink) {
          children.push(token);
          return;
        }
        const content = token.content;
        const matches: RegExpMatchArray[] = Array.from(
          content.matchAll(new RegExp(FILE_REFERENCE_REGEX))
        );
        if (matches.length === 0) {
          children.push(token);
          return;
        }
        let lastIndex = 0;
        matches.forEach((match: RegExpMatchArray) => {
          const matchText = match[0];
          const startIndex = match.index ?? 0;
          if (startIndex > lastIndex) {
            const textToken = new Token("text", "", 0);
            textToken.content = content.slice(lastIndex, startIndex);
            children.push(textToken);
          }
          const href = resolveFileHref?.(matchText);
          children.push(...createFileLinkTokens(state.md, matchText, href));
          lastIndex = startIndex + matchText.length;
        });
        if (lastIndex < content.length) {
          const trailing = new Token("text", "", 0);
          trailing.content = content.slice(lastIndex);
          children.push(trailing);
        }
      });
      (blockToken as unknown as { children: MarkdownToken[] }).children = children;
    });
  });
};

const createMarkdownRenderer = (options?: MarkdownRenderOptions): MarkdownIt => {
  const md: MarkdownIt = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true
  });

  md.options.highlight = (code: string, language: string): string => {
    if (language && hljs.getLanguage(language)) {
      try {
        const highlighted = hljs.highlight(code, { language }).value;
        // Diff blocks get wrapped in a Claude-style expandable card:
        // `<details>` with a `<summary>` that shows the line counts so
        // users can collapse long diffs but still see what changed.
        // Open by default when the diff is short, closed when long so
        // the chat doesn't become a wall of +/- lines on big edits.
        if (language === 'diff') {
          const rawLines = code.split('\n').filter(l => l.length > 0);
          const added = rawLines.filter(l => l.startsWith('+')).length;
          const removed = rawLines.filter(l => l.startsWith('-')).length;
          const openByDefault = rawLines.length <= 18;
          const summary = `<summary class="bandit-diff-card__summary">`
            + `<span class="bandit-diff-card__icon">⎔</span>`
            + `<span class="bandit-diff-card__title">diff</span>`
            + `<span class="bandit-diff-card__stats">`
            +   `<span class="bandit-diff-card__plus">+${added}</span>`
            +   ` `
            +   `<span class="bandit-diff-card__minus">−${removed}</span>`
            + `</span>`
            + `</summary>`;
          return `<details class="bandit-diff-card" ${openByDefault ? 'open' : ''}>`
            + summary
            + `<pre><code class="hljs language-diff">${highlighted}</code></pre>`
            + `</details>`;
        }
        return `<pre><code class="hljs language-${md.utils.escapeHtml(language)}">${highlighted}</code></pre>`;
      } catch {
        // Fall through to plain escape below.
      }
    }
    const escaped = md.utils.escapeHtml(code);
    return `<pre><code class="hljs">${escaped}</code></pre>`;
  };

  fileReferencePlugin(md, options?.resolveFileHref);
  return md;
};

export const renderMarkdownToHtml = (
  content: string,
  options?: MarkdownRenderOptions
): string => {
  const md = createMarkdownRenderer(options);
  return md.render(content);
};

export const MarkdownMessage = ({
  content,
  className,
  renderHtml,
  resolveFileHref,
  onFileReferenceClick
}: MarkdownMessageProps): JSX.Element => {
  const sanitizedContent = useMemo(() => sanitizeModelOutput(content), [content]);
  const html = useMemo(() => {
    const rendered = renderHtml
      ? renderHtml(sanitizedContent)
      : renderMarkdownToHtml(sanitizedContent, { resolveFileHref });
    return DOMPurify.sanitize(rendered, { ADD_ATTR: ["data-file-ref", "target", "rel"] });
  }, [renderHtml, resolveFileHref, sanitizedContent]);

  // Morph the new HTML into the existing DOM instead of replacing
  // innerHTML wholesale. `el.innerHTML = html` (what
  // dangerouslySetInnerHTML does on every change) tears down and rebuilds
  // the entire subtree on every stream token — at ~30 tokens/sec the
  // reasoning <details> cards were destroyed and recreated constantly,
  // which is the "reasoning flash" the user saw and the reason a
  // mid-stream expand click was lost (2026-06-14, Mark). morphdom patches
  // only the nodes that actually changed, so a card that hasn't changed
  // keeps the SAME DOM node — no flash, scroll/selection/open-state
  // preserved. onBeforeElUpdated keeps a user-toggled <details> open
  // across the brief window before the next render's HTML (driven by the
  // host's stable-key open-state map) catches up.
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {return;}
    morphdom(el, `<div>${html}</div>`, {
      childrenOnly: true,
      onBeforeElUpdated(fromEl, toEl) {
        if (
          fromEl instanceof HTMLDetailsElement &&
          toEl instanceof HTMLDetailsElement &&
          fromEl.open &&
          !toEl.hasAttribute("open")
        ) {
          toEl.setAttribute("open", "");
        }
        return true;
      }
    });
  }, [html]);

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onFileReferenceClick) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.("a[data-file-ref]") as HTMLAnchorElement | null;
    const reference = anchor?.getAttribute("data-file-ref");
    if (anchor && reference) {
      event.preventDefault();
      onFileReferenceClick(reference, event);
    }
  };

  const mergedClassName = className ? `markdown-message ${className}` : "markdown-message";

  // Children are managed by morphdom (via the ref + effect above), NOT by
  // React — so this div intentionally has no JSX children and no
  // dangerouslySetInnerHTML. The initial paint is handled by the effect
  // running after mount.
  return (
    <div ref={containerRef} className={mergedClassName} onClick={handleClick} />
  );
};
