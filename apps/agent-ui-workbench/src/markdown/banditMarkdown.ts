import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

/**
 * Workbench-local markdown renderer that understands the same custom
 * fenced blocks the Bandit Stealth extension emits:
 *
 *   ```bandit-tl       JSON tool-call timeline row (skill + name + arg + duration)
 *   ```bandit-reasoning Raw chain-of-thought collapsible
 *
 * Lifted directly from the extension's App.tsx fence handlers so the
 * workbench scrollback renders the same HTML the shipped panel does
 * — same .bandit-tl-row vertical rail, same .bandit-reasoning details
 * disclosure. Permission cards (`bandit-permission` fences) are NOT
 * handled here — agent-ui's ChatMessage extracts those before
 * markdown runs.
 */

interface BanditTlPayload {
  id?: string;
  glyph?: string;
  name?: string;
  primary?: string | null;
  status?: "running" | "repeat" | "done" | "error";
  skill?: string | null;
  durationMs?: number;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const formatDuration = (ms: number | undefined): string => {
  if (typeof ms !== "number" || ms <= 0) {return "";}
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
};

const renderBanditTl = (raw: string): string | null => {
  try {
    const data = JSON.parse(raw) as BanditTlPayload;
    const status = data.status ?? "running";
    const name = escapeHtml(data.name ?? "");
    const primary = data.primary ? escapeHtml(data.primary) : "";
    const dur = formatDuration(data.durationMs);
    const clickable = status === "done" || status === "error";
    return (
      `<div class="bandit-tl-row${clickable ? " bandit-tl-row--clickable" : ""}" data-status="${status}">` +
      `<span class="bandit-tl-name">${name}</span>` +
      (primary ? `<span class="bandit-tl-arg">${primary}</span>` : "") +
      (status === "repeat" ? `<span class="bandit-tl-tag">already run</span>` : "") +
      (dur ? `<span class="bandit-tl-dur">${dur}</span>` : "") +
      (clickable ? `<span class="bandit-tl-open" aria-hidden="true">↗</span>` : "") +
      `</div>`
    );
  } catch {
    return null;
  }
};

interface BanditSearchPayload {
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}

interface BanditTerminalPayload {
  command: string;
  output: string;
  exitCode?: number;
}

interface BanditFetchPayload {
  url: string;
  title: string;
  publishedAt?: string;
  summary: string;
  highlights?: string[];
}

interface BanditFindPayload {
  query: string;
  candidates: Array<{ path: string; recency?: string; confidence?: number }>;
}

const tryParse = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const renderBanditSearch = (raw: string): string | null => {
  const data = tryParse<BanditSearchPayload>(raw);
  if (!data) {
    return null;
  }
  const resultHtml = data.results
    .map(
      (r) =>
        `<li class="bandit-search__result">` +
        `<a class="bandit-search__title" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.title)}</a>` +
        `<span class="bandit-search__url">${escapeHtml(r.url)}</span>` +
        `<p class="bandit-search__snippet">${escapeHtml(r.snippet)}</p>` +
        `</li>`
    )
    .join("");
  return (
    `<section class="bandit-search">` +
    `<header class="bandit-search__header">` +
    `<span class="bandit-search__label">web_search</span>` +
    `<span class="bandit-search__query">${escapeHtml(data.query)}</span>` +
    `</header>` +
    `<ol class="bandit-search__results">${resultHtml}</ol>` +
    `</section>`
  );
};

const renderBanditTerminal = (raw: string): string | null => {
  const data = tryParse<BanditTerminalPayload>(raw);
  if (!data) {
    return null;
  }
  const exitBadge =
    typeof data.exitCode === "number"
      ? `<span class="bandit-terminal__exit" data-ok="${data.exitCode === 0 ? "true" : "false"}">exit ${data.exitCode}</span>`
      : "";
  return (
    `<section class="bandit-terminal">` +
    `<header class="bandit-terminal__header">` +
    `<span class="bandit-terminal__prompt">$</span>` +
    `<code class="bandit-terminal__cmd">${escapeHtml(data.command)}</code>` +
    exitBadge +
    `</header>` +
    `<pre class="bandit-terminal__output">${escapeHtml(data.output)}</pre>` +
    `</section>`
  );
};

const renderBanditFetch = (raw: string): string | null => {
  const data = tryParse<BanditFetchPayload>(raw);
  if (!data) {
    return null;
  }
  const highlights = data.highlights?.length
    ? `<ul class="bandit-fetch__highlights">${data.highlights
        .map((h) => `<li>${escapeHtml(h)}</li>`)
        .join("")}</ul>`
    : "";
  return (
    `<section class="bandit-fetch">` +
    `<header class="bandit-fetch__header">` +
    `<span class="bandit-fetch__label">web_fetch</span>` +
    `<a class="bandit-fetch__url" href="${escapeHtml(data.url)}" target="_blank" rel="noreferrer">${escapeHtml(data.url)}</a>` +
    `</header>` +
    `<h4 class="bandit-fetch__title">${escapeHtml(data.title)}</h4>` +
    (data.publishedAt ? `<p class="bandit-fetch__meta">Published ${escapeHtml(data.publishedAt)}</p>` : "") +
    `<p class="bandit-fetch__summary">${escapeHtml(data.summary)}</p>` +
    highlights +
    `</section>`
  );
};

const renderBanditFind = (raw: string): string | null => {
  const data = tryParse<BanditFindPayload>(raw);
  if (!data) {
    return null;
  }
  const candidates = data.candidates
    .map((c) => {
      const confidencePct = typeof c.confidence === "number" ? `${Math.round(c.confidence * 100)}%` : "";
      return (
        `<li class="bandit-find__candidate">` +
        `<code class="bandit-find__path">${escapeHtml(c.path)}</code>` +
        (c.recency ? `<span class="bandit-find__recency">${escapeHtml(c.recency)}</span>` : "") +
        (confidencePct ? `<span class="bandit-find__confidence">${confidencePct}</span>` : "") +
        `</li>`
      );
    })
    .join("");
  return (
    `<section class="bandit-find">` +
    `<header class="bandit-find__header">` +
    `<span class="bandit-find__label">find_directory</span>` +
    `<span class="bandit-find__query">${escapeHtml(data.query)}</span>` +
    `</header>` +
    `<ol class="bandit-find__list">${candidates}</ol>` +
    `</section>`
  );
};

const renderBanditReasoning = (raw: string): string => {
  const lineCount = raw.split("\n").filter((l) => l.trim().length > 0).length;
  const summary = `reasoning (${lineCount} line${lineCount === 1 ? "" : "s"})`;
  return (
    `<details class="bandit-reasoning" open>` +
    `<summary>${escapeHtml(summary)}</summary>` +
    `<pre class="bandit-reasoning__body">${escapeHtml(raw)}</pre>` +
    `</details>`
  );
};

let cachedRenderer: MarkdownIt | null = null;
let cachedReadmeRenderer: MarkdownIt | null = null;

const getRenderer = (): MarkdownIt => {
  if (cachedRenderer) {return cachedRenderer;}
  const md: MarkdownIt = new MarkdownIt({ html: true, linkify: true, breaks: true });
  const defaultFence = md.renderer.rules.fence ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const lang = (token.info || "").trim().toLowerCase();
    if (lang === "bandit-tl") {
      const html = renderBanditTl(token.content);
      if (html) {return html;}
    }
    if (lang === "bandit-reasoning") {
      return renderBanditReasoning(token.content);
    }
    if (lang === "bandit-search") {
      const html = renderBanditSearch(token.content);
      if (html) {return html;}
    }
    if (lang === "bandit-terminal") {
      const html = renderBanditTerminal(token.content);
      if (html) {return html;}
    }
    if (lang === "bandit-fetch") {
      const html = renderBanditFetch(token.content);
      if (html) {return html;}
    }
    if (lang === "bandit-find") {
      const html = renderBanditFind(token.content);
      if (html) {return html;}
    }
    return defaultFence(tokens, idx, opts, env, self);
  };
  cachedRenderer = md;
  return md;
};

/**
 * Render a markdown string into sanitized HTML using the workbench
 * renderer. Passed to ChatConversation via the `renderMarkdown` prop
 * so the scrollback matches the shipped extension.
 */
export const renderBanditMarkdown = (content: string): string => {
  const rendered = getRenderer().render(content);
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: [
      "data-file-ref",
      "data-status",
      "data-run-id",
      "data-reasoning-key",
      "data-ok",
      "target",
      "rel"
    ],
    ADD_TAGS: ["details", "summary"]
  });
};

const getReadmeRenderer = (): MarkdownIt => {
  if (cachedReadmeRenderer) {
    return cachedReadmeRenderer;
  }
  // README content follows standard CommonMark line-break semantics:
  // single newlines are spaces, blank lines separate paragraphs. The
  // chat renderer uses `breaks: true` because chat authors expect
  // Enter-to-newline; that flag stacks the marketplace badges
  // vertically (every line in the README's badge block becomes its
  // own `<br>`-terminated row). A second renderer with `breaks:
  // false` keeps the marketplace page true to the README's intent.
  cachedReadmeRenderer = new MarkdownIt({ html: true, linkify: true, breaks: false });
  return cachedReadmeRenderer;
};

/**
 * Render a markdown string with CommonMark line-break behavior. Use
 * for long-form content like an extension README where authors
 * intend single newlines as soft wraps, not hard breaks. Drops the
 * custom bandit-* fence handlers since README authors won't reach
 * for them — falls back to the default code-block render for any
 * bandit-tagged fence, which is the safe behavior.
 */
export const renderReadmeMarkdown = (content: string): string => {
  const rendered = getReadmeRenderer().render(content);
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ["target", "rel"],
    ADD_TAGS: ["details", "summary"]
  });
};
