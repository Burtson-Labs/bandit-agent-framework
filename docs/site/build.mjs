#!/usr/bin/env node
//
// Generates self-contained HTML documentation pages for each
// publishable @burtson-labs/* package. Reads packages/*/README.md
// (the same markdown that ships to npm), renders it via markdown-it
// (resolved through agent-ui's node_modules so no root install
// required), wraps it in a Bandit-themed shell with sidebar nav.
//
// Output: docs/site/<slug>.html — drop these onto cdn.burtson.ai/docs/
// (or wherever the docs host lives) and READMEs link in via absolute URL.
//
// Usage:
//   node docs/site/build.mjs           — build everything
//   node docs/site/build.mjs agent-core — build a single page

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

// Resolve markdown-it through agent-ui — it's already an installed dep there,
// so this script needs no separate install.
const requireFromAgentUi = createRequire(
  path.join(repoRoot, "packages/agent-ui/package.json")
);
const MarkdownIt = requireFromAgentUi("markdown-it");

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
});

// ── Glossary auto-linking ────────────────────────────────────────────────────
// At build time, link the first mention of each curated term on a page to its
// glossary entry. Runs at the markdown-it token level, so it never touches code
// spans, existing links, or headings. Opt-in per render via env.glossaryLink;
// the glossary page itself is skipped so terms aren't self-linked. Add a term
// here (longest/most-specific first) and it auto-links across the docs.
const GLOSSARY_TERMS = [
  // [phrase, glossary anchor, caseSensitive?]
  ["retrieval-augmented generation", "rag"],
  ["model context protocol", "mcp"],
  ["tool-calling protocol", "tool-calling-protocol"],
  ["chain-of-thought", "chain-of-thought"],
  ["context engineering", "context-engineering"],
  ["context window", "context-window"],
  ["cosine similarity", "cosine-similarity"],
  ["semantic search", "vector-semantic-search"],
  ["prompt injection", "prompt-injection"],
  ["local model", "local-model"],
  ["fine-tuning", "fine-tuning"],
  ["quantization", "quantization"],
  ["hallucinations", "hallucination"],
  ["hallucination", "hallucination"],
  ["multimodal", "multimodal"],
  ["transformer", "transformer"],
  ["embeddings", "embedding"],
  ["embedding", "embedding"],
  ["subagents", "subagent"],
  ["subagent", "subagent"],
  ["temperature", "temperature"],
  ["streaming", "streaming"],
  ["inference", "inference"],
  ["tokens", "token"],
  ["token", "token"],
  ["ReAct", "react", true],
  ["RAG", "rag", true],
  ["MCP", "mcp", true],
  ["LLM", "llm", true]
];
const GLOSSARY_MAP = new Map(GLOSSARY_TERMS.map(([p, a, cs]) => [p.toLowerCase(), { phrase: p, anchor: a, cs: !!cs }]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GLOSSARY_RE = new RegExp("\\b(" + GLOSSARY_TERMS.map(([p]) => escapeRe(p)).join("|") + ")\\b", "gi");

function glossaryTokens(text, used, state) {
  GLOSSARY_RE.lastIndex = 0;
  let m, last = 0, out = null;
  while ((m = GLOSSARY_RE.exec(text))) {
    const def = GLOSSARY_MAP.get(m[0].toLowerCase());
    if (!def || (def.cs && m[0] !== def.phrase) || used.has(def.anchor)) continue;
    used.add(def.anchor);
    out = out || [];
    if (m.index > last) { const t = new state.Token("text", "", 0); t.content = text.slice(last, m.index); out.push(t); }
    const open = new state.Token("link_open", "a", 1);
    open.attrSet("href", `./glossary.html#${def.anchor}`);
    open.attrSet("class", "glossary-link");
    open.attrSet("title", "Glossary");
    const inner = new state.Token("text", "", 0); inner.content = m[0];
    out.push(open, inner, new state.Token("link_close", "a", -1));
    last = m.index + m[0].length;
  }
  if (!out) return null;
  if (last < text.length) { const t = new state.Token("text", "", 0); t.content = text.slice(last); out.push(t); }
  return out;
}

md.core.ruler.push("glossary_autolink", (state) => {
  const env = state.env || {};
  if (!env.glossaryLink || env.slug === "glossary") return;
  const used = new Set();
  const toks = state.tokens;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== "inline" || !toks[i].children) continue;
    if (i > 0 && toks[i - 1].type === "heading_open") continue;   // don't link inside headings
    let depth = 0;
    const next = [];
    for (const c of toks[i].children) {
      if (c.type === "link_open") depth++;
      if (c.type === "text" && depth === 0) {
        const rep = glossaryTokens(c.content, used, state);
        if (rep) next.push(...rep); else next.push(c);
      } else next.push(c);
      if (c.type === "link_close") depth--;
    }
    toks[i].children = next;
  }
});

// Resvg renders our per-page Open Graph cards (SVG -> PNG) at build time.
const requireRoot = createRequire(path.join(repoRoot, "package.json"));
const { Resvg } = requireRoot("@resvg/resvg-js");

// The Bandit Stealth mark, embedded as base64 so resvg can draw it into each card.
const OG_LOGO_B64 = fs.readFileSync(path.join(repoRoot, "docs/site/assets/og-logo.png")).toString("base64");

// One social card per page: Bandit-branded, with the page's kind + title +
// tagline. Rendered to docs/site/og/<slug>.png and referenced per page, so a
// link to a specific package unfurls with that package's own card.
function ogCardSvg({ kind, title, subtitle }) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const t = String(title);
  const titleSize = t.length <= 16 ? 88 : t.length <= 26 ? 66 : 50;
  const sub = subtitle && subtitle.length > 64 ? subtitle.slice(0, 62).trimEnd() + "…" : (subtitle || "");
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c0e15"/><stop offset="1" stop-color="#15101f"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="10" fill="#a60ee5"/>
  <image href="data:image/png;base64,${OG_LOGO_B64}" x="956" y="80" width="160" height="160"/>
  <text x="84" y="156" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="4" fill="#b842f0">${esc(kind.toUpperCase())}</text>
  <text x="84" y="${sub ? 320 : 350}" font-family="Helvetica, Arial, sans-serif" font-size="${titleSize}" font-weight="800" fill="#e7eaf2">${esc(t)}</text>
  ${sub ? `<text x="84" y="398" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#9aa3b6">${esc(sub)}</text>` : ""}
  <text x="84" y="562" font-family="Helvetica, Arial, sans-serif" font-size="27" font-weight="600" fill="#6b7385">docs.burtson.ai</text>
  <text x="1116" y="562" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="27" font-weight="700" fill="#8a93a6">Bandit Agent Framework</text>
</svg>`;
}

// An N-spike star path, used on the quiz OG seal.
function starPath(cx, cy, spikes, outerR, innerR) {
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  let d = "";
  for (let i = 0; i < spikes; i++) {
    d += (i === 0 ? "M" : "L") + (cx + Math.cos(rot) * outerR).toFixed(1) + " " + (cy + Math.sin(rot) * outerR).toFixed(1) + " ";
    rot += step;
    d += "L" + (cx + Math.cos(rot) * innerR).toFixed(1) + " " + (cy + Math.sin(rot) * innerR).toFixed(1) + " ";
    rot += step;
  }
  return d + "Z";
}

// The quiz page gets a distinct, award-themed OG card — a gold certificate
// rosette with a ribbon, a bold hook, and a CTA chip — so a shared link actually
// pulls clicks instead of unfurling as just another reference page.
function quizCardSvg() {
  const cx = 1000, cy = 250;
  let scallop = "";
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    scallop += `<circle cx="${(cx + Math.cos(a) * 80).toFixed(1)}" cy="${(cy + Math.sin(a) * 80).toFixed(1)}" r="9" fill="url(#gold)"/>`;
  }
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c0e15"/><stop offset="1" stop-color="#15101f"/></linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe9a6"/><stop offset="0.5" stop-color="#f5c542"/><stop offset="1" stop-color="#d4a017"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="10" fill="#a60ee5"/>
  <text x="84" y="150" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="4" fill="#b842f0">GLOSSARY QUIZ</text>
  <text x="84" y="262" font-family="Helvetica, Arial, sans-serif" font-size="84" font-weight="800" fill="#e7eaf2">Test your</text>
  <text x="84" y="356" font-family="Helvetica, Arial, sans-serif" font-size="84" font-weight="800" fill="#e7eaf2">AI fluency</text>
  <text x="84" y="424" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#9aa3b6">Multiple choice on agent &amp; LLM terms.</text>
  <rect x="84" y="462" width="452" height="58" rx="29" fill="none" stroke="#a60ee5" stroke-width="2"/>
  <text x="112" y="499" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600" fill="#c061f0">Can you reach Bandit Sage? &#8594;</text>
  <polygon points="968,300 1000,300 1000,470 984,452 968,470" fill="#9a6f12"/>
  <polygon points="1000,300 1032,300 1032,470 1016,452 1000,470" fill="#c79a2a"/>
  ${scallop}
  <circle cx="${cx}" cy="${cy}" r="74" fill="url(#gold)"/>
  <circle cx="${cx}" cy="${cy}" r="60" fill="#15101f"/>
  <circle cx="${cx}" cy="${cy}" r="60" fill="none" stroke="url(#gold)" stroke-width="2"/>
  <path d="${starPath(cx, cy - 4, 5, 34, 14)}" fill="url(#gold)"/>
  <text x="${cx}" y="${cy + 42}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="#f5c542">CERTIFIED</text>
  <text x="84" y="566" font-family="Helvetica, Arial, sans-serif" font-size="27" font-weight="600" fill="#6b7385">docs.burtson.ai</text>
  <text x="1116" y="566" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="27" font-weight="700" fill="#8a93a6">Bandit Agent Framework</text>
</svg>`;
}

// Pull the one-line tagline from a doc: the README hero (**bold**), else the
// first real paragraph.
function taglineFrom(mdText) {
  const bold = mdText.match(/\*\*(.+?)\*\*/);
  if (bold) return bold[1].replace(/[`*]/g, "").trim();
  const para = mdText.split("\n").find((l) => l.trim() && !/^[#<|]/.test(l.trim()));
  return (para || "").replace(/[`*\[\]()]/g, "").trim();
}

const KIND_LABEL = {
  "Get started": "Guide",
  "Bandit Stealth": "Bandit Stealth",
  Concepts: "Concept",
  Patterns: "Pattern",
  Reference: "Reference",
  Build: "Guide",
  Packages: "Package"
};

function writeOgCard(outDir, slug, spec) {
  const png = new Resvg(ogCardSvg(spec), { font: { loadSystemFonts: true } }).render().asPng();
  fs.writeFileSync(path.join(outDir, "og", `${slug}.png`), png);
}

// ── Package registry ───────────────────────────────────────────────────────
//
// Order shown in the sidebar. Slug is the URL-safe filename (e.g. "agent-core"
// becomes "agent-core.html"). `path` is the README to render.
// Grouped for the sidebar as an onboarding funnel: Get started (install + first
// turn) -> the shipping products -> Concepts (how Bandit's pieces work) ->
// Patterns (the general agent techniques, with cited sources — a learning
// resource, not just product docs) -> Build (extend it) -> Packages (reference).
// `index` (the landing page) is rendered separately and isn't in a section.
const SECTIONS = [
  {
    title: "Get started",
    items: [
      { slug: "quickstart", name: "Quickstart", readme: "docs/guides/quickstart.md", tagline: "Install and run your first agent in minutes." }
    ]
  },
  {
    title: "Bandit Stealth",
    items: [
      { slug: "bandit-cli", name: "Bandit CLI", readme: "apps/bandit-cli/README.md" },
      { slug: "bandit-stealth", name: "VS Code / Cursor Extension", readme: "apps/bandit-stealth/README.md" }
    ]
  },
  {
    title: "Concepts",
    items: [
      { slug: "how-a-turn-works", name: "How a turn works", readme: "docs/guides/how-a-turn-works.md", tagline: "One trip from a goal to a result, step by step." },
      { slug: "tools", name: "Tools", readme: "docs/concepts/tools.md", tagline: "What the agent can do — and how to add your own." },
      { slug: "skills", name: "Skills", readme: "docs/concepts/skills.md", tagline: "Bundle tools, guidance, and activation into one unit." },
      { slug: "memory", name: "Memory", readme: "docs/concepts/memory.md", tagline: "Durable project context in plain markdown." },
      { slug: "providers-and-models", name: "Providers & models", readme: "docs/concepts/providers-and-models.md", tagline: "Run any model — local, cloud, or OpenAI-compatible." },
      { slug: "mcp", name: "MCP connectors", readme: "docs/concepts/mcp.md", tagline: "Connect external tools over the Model Context Protocol." }
    ]
  },
  {
    title: "Patterns",
    items: [
      { slug: "the-agent-loop", name: "The agent loop", readme: "docs/patterns/the-agent-loop.md", tagline: "Reason, act, observe, repeat — why agents work." },
      { slug: "retrieval-and-context", name: "Retrieval & context", readme: "docs/patterns/retrieval-and-context.md", tagline: "RAG and context engineering, and how Bandit uses them." },
      { slug: "memory-as-synthesis", name: "Memory as synthesis", readme: "docs/patterns/memory-as-synthesis.md", tagline: "Curate, don't just retrieve — the idea behind BANDIT.md." }
    ]
  },
  {
    title: "Reference",
    items: [
      { slug: "glossary", name: "Glossary", readme: "docs/reference/glossary.md", tagline: "Plain-English definitions for the AI terms in these docs." },
      { slug: "quiz", name: "Test your knowledge", tagline: "A glossary quiz with a certificate — see how you score.", quiz: true }
    ]
  },
  {
    title: "Build",
    items: [
      { slug: "build-your-own-host", name: "Build your own host", readme: "docs/guides/build-your-own-host.md", tagline: "From 15 lines to a fully custom agent host." },
      { slug: "writing-a-custom-tool", name: "Writing a custom tool", readme: "docs/guides/writing-a-custom-tool.md", tagline: "Build, register, and call your own tool end to end." },
      { slug: "configuration", name: "Configuration", readme: "docs/guides/configuration.md", tagline: "Config, settings, hooks, and the security guard." }
    ]
  },
  {
    title: "Packages",
    items: [
      { slug: "agent-core", name: "@burtson-labs/agent-core", readme: "packages/agent-core/README.md" },
      { slug: "agent-ui", name: "@burtson-labs/agent-ui", readme: "packages/agent-ui/README.md" },
      { slug: "stealth-core-runtime", name: "@burtson-labs/stealth-core-runtime", readme: "packages/stealth-core-runtime/README.md" },
      { slug: "host-kit", name: "@burtson-labs/host-kit", readme: "packages/host-kit/README.md" },
      { slug: "core-chat", name: "@burtson-labs/core-chat", readme: "packages/core-chat/README.md" },
      { slug: "agent-adapters", name: "@burtson-labs/agent-adapters", readme: "packages/agent-adapters/README.md" },
      { slug: "agent-adapters-provider", name: "@burtson-labs/agent-adapters-provider", readme: "packages/agent-adapters/provider/README.md" },
      { slug: "agent-adapters-node", name: "@burtson-labs/agent-adapters-node", readme: "packages/agent-adapters/node/README.md" },
      { slug: "agent-adapters-github", name: "@burtson-labs/agent-adapters-github", readme: "packages/agent-adapters/github/README.md" },
      { slug: "agent-adapters-vscode", name: "@burtson-labs/agent-adapters-vscode", readme: "packages/agent-adapters/vscode/README.md" },
      { slug: "agent-adapters-web", name: "@burtson-labs/agent-adapters-web", readme: "packages/agent-adapters/web/README.md" }
    ]
  }
];
const PAGES = SECTIONS.flatMap((s) => s.items);

// Canonical host for SEO + per-page OG card URLs (rich link unfurls in
// Slack / Teams / iMessage). Every page gets its own card at /og/<slug>.png.
const BASE_URL = "https://docs.burtson.ai";
// The (now public) source repo — docs link to the real files: a package's src/ for
// package pages, the page's own markdown otherwise.
const REPO_URL = "https://github.com/Burtson-Labs/bandit-agent-framework";

// Rewrite relative repo-file links in rendered markdown (e.g. a README's
// `test/foo.test.ts`) to absolute GitHub source URLs — otherwise they 404 on the
// docs site. Doc cross-links (*.html), in-page anchors, and external URLs are left alone.
const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const hi = token.attrIndex("href");
  const dir = env && env.sourceDir;
  if (hi >= 0 && dir) {
    const href = token.attrs[hi][1];
    if (href && !/^(https?:|mailto:|tel:|#|\/)/i.test(href) && !/\.html(#|$)/i.test(href)) {
      const resolved = path.posix.normalize(path.posix.join(dir, href));
      const kind = /\.[a-z0-9]+$/i.test(resolved) ? "blob" : "tree";
      token.attrs[hi][1] = `${REPO_URL}/${kind}/main/${resolved}`;
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ── HTML template ──────────────────────────────────────────────────────────
//
// Single dark theme + purple accent, matching the Bandit visual language.
// Lucide icons load from iconify (already used by the READMEs themselves).
// highlight.js + Inter font from CDN. No build, no bundler.

const CSS = `
/* Dark theme — default */
:root {
  --bg: #0a0c12;
  --bg-elev: #11141c;
  --bg-elev-2: #161a24;
  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.14);
  --text: #e7eaf2;
  --text-muted: #9aa3b6;
  --text-faint: #6b7385;
  --accent: #a60ee5;
  --accent-soft: rgba(166,14,229,0.12);
  --accent-strong: #b842f0;
  --link: #7ec8ff;
  --code-bg: #1a1e29;
  --code-inline-bg: rgba(166,14,229,0.10);
  --logo-burtson-dark: block;
  --logo-burtson-light: none;
}

/* Light theme — auto-applied when the user prefers light. The Burtson
   Labs CDN ships the dark-text variant for this case. */
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fafbfd;
    --bg-elev: #ffffff;
    --bg-elev-2: #f3f5f9;
    --border: rgba(15,18,27,0.10);
    --border-strong: rgba(15,18,27,0.16);
    --text: #1a1d27;
    --text-muted: #565d6e;
    --text-faint: #8b92a3;
    --accent: #8c0bc4;
    --accent-soft: rgba(166,14,229,0.08);
    --accent-strong: #6f08a0;
    --link: #2a6cb3;
    --code-bg: #f3f5f9;
    --code-inline-bg: rgba(166,14,229,0.07);
    --logo-burtson-dark: none;
    --logo-burtson-light: block;
  }
}

* { box-sizing: border-box; min-width: 0; }

/* Thin, subtle scrollbars — but ONLY on our own scroll panes, never the page. Styling
   the page scrollbar forces a classic gutter-reserving bar (an empty strip on the right,
   esp. on mobile); leaving the page unstyled lets the OS use overlay scrollbars. The nav
   shows its bar so it's obvious there's more below; the content scrolls in its own pane. */
.content-pane, .sidebar-nav, .sidebar, .search-results, .content pre {
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
.content-pane::-webkit-scrollbar, .sidebar-nav::-webkit-scrollbar, .sidebar::-webkit-scrollbar, .search-results::-webkit-scrollbar, .content pre::-webkit-scrollbar { width: 12px; height: 12px; }
.content-pane::-webkit-scrollbar-track, .sidebar-nav::-webkit-scrollbar-track, .sidebar::-webkit-scrollbar-track, .search-results::-webkit-scrollbar-track, .content pre::-webkit-scrollbar-track { background: transparent; }
.content-pane::-webkit-scrollbar-thumb, .sidebar-nav::-webkit-scrollbar-thumb, .sidebar::-webkit-scrollbar-thumb, .search-results::-webkit-scrollbar-thumb, .content pre::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 8px; border: 4px solid transparent; background-clip: content-box; }
.content-pane::-webkit-scrollbar-thumb:hover, .sidebar-nav::-webkit-scrollbar-thumb:hover, .sidebar::-webkit-scrollbar-thumb:hover, .search-results::-webkit-scrollbar-thumb:hover, .content pre::-webkit-scrollbar-thumb:hover { background: var(--text-faint); background-clip: content-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  scroll-behavior: smooth;
}
/* Clip horizontal overflow with overflow:clip, not hidden: clip does NOT create a
   scroll container (so the mobile sticky top bar still docks to the viewport) and
   does NOT reserve a scrollbar gutter (so there's no empty gap on the right). */
body { overflow-x: clip; }

a {
  color: var(--link);
  text-decoration: none;
  transition: color 0.15s ease;
}
a:hover { color: var(--accent-strong); text-decoration: underline; }

.skip-link {
  position: absolute;
  top: -100px;
  left: 16px;
  background: var(--accent);
  color: white;
  padding: 8px 16px;
  border-radius: 6px;
  z-index: 100;
}
.skip-link:focus { top: 16px; }

.layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  min-height: 100vh;
  max-width: 1680px;
  margin: 0 auto;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  padding: 32px 24px;
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* The nav list is the only scroll region; brand + search pin to the top and the
   "Maintained by" footer pins to the bottom, so the full sidebar is always visible. */
.sidebar-nav {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.sidebar-brand {
  display: block;
  margin-bottom: 32px;
  text-align: center;
}
.sidebar-brand img {
  width: 120px;
  height: auto;
}
.sidebar-brand:hover { text-decoration: none; }

.sidebar-intro {
  margin: 0 0 20px;
  padding: 12px 14px;
  background: var(--bg-elev-2);
  border-left: 2px solid var(--accent);
  border-radius: 0 6px 6px 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted);
}
.sidebar-intro strong { color: var(--text); font-weight: 600; }
.sidebar-intro a { color: var(--accent-strong); }

/* Brand row (brand + hamburger). Hamburger is desktop-hidden. */
.sidebar-top { display: flex; align-items: center; justify-content: center; margin-bottom: 20px; }
.nav-toggle {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  width: 42px;
  height: 38px;
  padding: 9px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.nav-toggle span { display: block; height: 2px; width: 100%; background: var(--text); border-radius: 2px; transition: transform 0.2s ease, opacity 0.2s ease; }
.nav-toggle.open span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
.nav-toggle.open span:nth-child(2) { opacity: 0; }
.nav-toggle.open span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }

/* Search box + results dropdown */
.search { position: relative; margin: 0 0 18px; }
.search input {
  width: 100%;
  padding: 9px 12px;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
}
.search input::placeholder { color: var(--text-faint); }
.search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-results {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 62vh;
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: 0 16px 44px rgba(0,0,0,0.4);
  z-index: 60;
  padding: 6px;
}
.search-hit { display: block; padding: 9px 11px; border-radius: 7px; color: var(--text); }
.search-hit:hover { background: var(--accent-soft); text-decoration: none; }
.search-hit-title { display: block; font-weight: 600; font-size: 13.5px; color: var(--text); }
.search-hit-snip { display: block; font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-top: 2px; }
.search-empty { padding: 14px; color: var(--text-faint); font-size: 13px; text-align: center; }

.cobrand {
  margin-top: auto;
  padding-top: 24px;
  border-top: 1px solid var(--border);
  text-align: center;
}
.cobrand-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 14px;
}
.cobrand a {
  display: inline-block;
  line-height: 0;
}
.cobrand img {
  width: 120px;
  height: auto;
  opacity: 0.72;
  transition: opacity 0.15s ease;
  vertical-align: middle;
}
.cobrand a:hover img { opacity: 1; }
.cobrand .logo-dark { display: var(--logo-burtson-dark); }
.cobrand .logo-light { display: var(--logo-burtson-light); }

.sidebar .cobrand { display: block; }
.footer .cobrand { display: none; margin-top: 0; padding-top: 0; border-top: 0; }

.sidebar h3 {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 24px 0 8px;
}

.sidebar ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.sidebar li { margin: 0; }
.sidebar li a {
  display: block;
  padding: 6px 12px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 14px;
  border-left: 2px solid transparent;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.sidebar li a:hover {
  background: var(--bg-elev-2);
  color: var(--text);
  text-decoration: none;
}
.sidebar li a.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  border-left-color: var(--accent);
}

/* Mobile-first: the content is a normal in-flow wrapper (the page scrolls, the
   top bar stays sticky). Desktop turns it into its own scroll pane below. */
.content-pane {
  position: relative;
  scroll-padding-top: 28px;
}
.content {
  padding: 56px 64px;
  max-width: 920px;
}
/* Soft scroll-fade at the top and bottom edges of the pane, toggled by JS so it
   only shows when there's actually more to scroll. */
.content-pane::before,
.content-pane::after {
  content: "";
  position: sticky;
  left: 0;
  right: 0;
  display: block;
  height: 48px;
  pointer-events: none;
  z-index: 4;
  opacity: 0;
  transition: opacity 0.25s ease;
}
.content-pane::before { top: 0; margin-bottom: -48px; background: linear-gradient(var(--bg), transparent); }
.content-pane::after { bottom: 0; margin-top: -48px; background: linear-gradient(transparent, var(--bg)); }
.content-pane.can-scroll-up::before { opacity: 1; }
.content-pane.can-scroll-down::after { opacity: 1; }

/* Desktop only: fix the viewport so the sidebar stays put and the content scrolls
   in its own pane. Scoped to min-width so the mobile sticky top bar is untouched. */
@media (min-width: 901px) {
  html, body { height: 100%; overflow: hidden; }
  .layout { height: 100vh; overflow: hidden; }
  .content-pane { height: 100vh; overflow-y: auto; scroll-behavior: smooth; }
}

.content h1 {
  font-size: 32px;
  font-weight: 700;
  margin: 0 0 12px;
  letter-spacing: -0.01em;
}
.content h2 {
  font-size: 24px;
  font-weight: 600;
  margin: 48px 0 16px;
  letter-spacing: -0.01em;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.content h2 img { vertical-align: middle; margin-right: 8px; }
.content h3 {
  font-size: 18px;
  font-weight: 600;
  margin: 32px 0 12px;
}
.content h4 {
  font-size: 15px;
  font-weight: 600;
  margin: 24px 0 8px;
  color: var(--text-muted);
}

.content p { margin: 0 0 16px; }
.content strong { color: #fff; font-weight: 600; }
.content em { color: var(--text-muted); }

.content ul, .content ol { padding-left: 24px; margin: 0 0 16px; }
.content li { margin-bottom: 6px; }

.content code {
  background: var(--code-inline-bg);
  color: var(--accent-strong);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.92em;
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
}
.content pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  overflow-x: auto;
  margin: 16px 0 24px;
  font-size: 14px;
  line-height: 1.5;
}
.content pre code {
  background: transparent;
  color: var(--text);
  padding: 0;
  font-size: 14px;
}

.content table {
  border-collapse: collapse;
  width: 100%;
  margin: 16px 0 24px;
  font-size: 14px;
}
.content th, .content td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.content th {
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-elev);
}
.content tr:hover td { background: var(--bg-elev-2); }

.content blockquote {
  margin: 16px 0;
  padding: 12px 20px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  color: var(--text-muted);
  border-radius: 0 6px 6px 0;
}

.content hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 32px 0;
}

/* Center the README hero (the <div align="center"> block).
   We hide the embedded logo because the sidebar already shows the
   bandit-stealth mark — the hero would just duplicate it. */
.content div[align="center"] {
  text-align: center;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
.content div[align="center"] > a:first-child,
.content div[align="center"] picture {
  display: none;
}
.content div[align="center"] h1 {
  font-size: 32px;
  margin: 8px 0 16px;
  letter-spacing: -0.02em;
}
.content div[align="center"] p {
  color: var(--text-muted);
  font-size: 17px;
  line-height: 1.55;
  max-width: 580px;
  margin: 0 auto 10px;
}
.content div[align="center"] strong {
  font-size: 19px;
  font-weight: 600;
  color: var(--text);
  display: block;
  margin-bottom: 10px;
  letter-spacing: -0.005em;
}

/* Landing-page card grid */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
  margin: 18px 0 32px;
}
.card {
  display: block;
  padding: 18px 20px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.card:hover {
  border-color: var(--accent);
  text-decoration: none;
  transform: translateY(-2px);
}
.card h3 { margin: 0 0 6px; font-size: 16px; color: var(--text); }
.card p { margin: 0; font-size: 13.5px; color: var(--text-muted); line-height: 1.5; }
.card p code { font-size: 0.85em; }

/* Landing demo (CLI + extension GIFs) */
.demo-grid { display: flex; flex-direction: column; gap: 28px; max-width: 920px; margin: 4px auto 36px; }
.demo { margin: 0; }
.demo-cli img { width: 100%; border-radius: 10px; border: 1px solid var(--border); box-shadow: 0 18px 48px rgba(0,0,0,0.4); display: block; }
.demo-cli figcaption { margin-top: 8px; font-size: 11.5px; color: var(--text-faint); text-align: center; letter-spacing: 0.06em; text-transform: uppercase; }
.demo-ext { display: flex; align-items: center; gap: 24px; }
.demo-ext img { height: 340px; width: auto; border-radius: 10px; border: 1px solid var(--border); box-shadow: 0 18px 48px rgba(0,0,0,0.4); display: block; flex-shrink: 0; }
.demo-ext-label { font-size: 11.5px; color: var(--text-faint); letter-spacing: 0.06em; text-transform: uppercase; }
.demo-ext-copy p { margin: 10px 0 0; color: var(--text-muted); line-height: 1.65; }
@media (max-width: 760px) { .demo-ext { flex-direction: column; align-items: flex-start; } .demo-ext img { height: auto; width: 100%; } }

/* "Why Bandit" grid */
.why-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin: 14px 0 36px; }
.why { padding: 16px 18px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 10px; }
.why strong { display: block; color: var(--text); font-size: 15px; margin-bottom: 6px; }
.why span { display: block; color: var(--text-muted); font-size: 13.5px; line-height: 1.55; }

/* "New to AI agents? Start here" learning path */
.path { list-style: none; counter-reset: step; padding: 0; margin: 14px 0 36px; display: grid; gap: 10px; }
.path li { counter-increment: step; position: relative; padding: 13px 18px 13px 54px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 10px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
.path li::before { content: counter(step); position: absolute; left: 14px; top: 13px; width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 700; }
.path li a { font-weight: 600; color: var(--text); }
.path li a:hover { color: var(--accent-strong); }

/* Inline glossary links: subtle dotted underline so definitions read as hints, not nav */
.content a.glossary-link { color: inherit; border-bottom: 1px dotted var(--border-strong); }
.content a.glossary-link:hover { color: var(--accent-strong); border-bottom-color: var(--accent-strong); text-decoration: none; }
/* Glossary term anchors (deep-linkable; offset so the term clears the top) */
.gloss-anchor { display: inline-block; width: 0; height: 0; scroll-margin-top: 90px; }

/* Copy button on code blocks */
.content pre { position: relative; }
.copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 9px;
  font-size: 11px;
  font-family: 'Inter', -apple-system, sans-serif;
  color: var(--text-muted);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.content pre:hover .copy-btn, .copy-btn:focus { opacity: 1; }
.copy-btn:hover { color: var(--text); border-color: var(--accent); }
.copy-btn.copied { color: var(--accent-strong); border-color: var(--accent); }

.footer {
  margin-top: 80px;
  padding-top: 32px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 13px;
}
.footer p { margin: 0 0 6px; }
.footer a { color: var(--text-muted); }

/* ── Tablet + Mobile ─────────────────────────────────────────────── */
/* ── "Test your knowledge" quiz ──────────────────────────────────── */
.quiz { margin: 8px 0 24px; }
.quiz-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 14px; padding: 28px; }
.quiz-card h2 { margin: 6px 0 12px; font-size: 22px; }
.quiz-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent-strong); margin: 0 0 6px; }
.quiz-best { color: var(--text-muted); }
.quiz-progress { height: 4px; background: var(--border); border-radius: 4px; overflow: hidden; margin: 0 0 18px; }
.quiz-progress span { display: block; height: 100%; background: linear-gradient(90deg, #a60ee5, #b842f0); transition: width 0.3s ease; }
.quiz-def { font-size: 19px; line-height: 1.5; font-weight: 500; color: var(--text); margin: 6px 0 20px; }
.quiz-def.quiz-term { font-size: 26px; font-weight: 700; }
.quiz-options { display: grid; gap: 10px; }
.quiz-opt { text-align: left; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font: inherit; font-size: 15px; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
.quiz-opt:hover:not(:disabled) { border-color: var(--accent); }
.quiz-opt:disabled { cursor: default; opacity: 0.9; }
.quiz-opt.right { border-color: #2ea043; background: rgba(46,160,67,0.14); color: #4ade80; }
.quiz-opt.wrong { border-color: #f85149; background: rgba(248,81,73,0.12); color: #ff7b72; }
.quiz-feedback { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.quiz-feedback p { margin: 0 0 14px; }
.quiz-ok { color: #4ade80; font-weight: 600; }
.quiz-no { color: #ff7b72; font-weight: 600; }
.quiz-btn { display: inline-block; padding: 11px 20px; border-radius: 10px; border: 0; background: var(--accent); color: #fff; font: inherit; font-weight: 600; font-size: 15px; cursor: pointer; text-decoration: none; transition: filter 0.15s ease; }
.quiz-btn:hover { filter: brightness(1.1); text-decoration: none; }
.quiz-btn.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
.quiz-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.quiz-summary h3 { font-size: 20px; margin: 24px 0 12px; }
.quiz-review-title { color: var(--text-muted); margin: 0 0 8px; }
.quiz-review { margin: 0 0 8px; padding-left: 18px; }
.quiz-review li { margin-bottom: 6px; }
.quiz-perfect { font-size: 17px; }
/* Certificate */
.certificate { margin: 8px auto 18px; max-width: 560px; border-radius: 16px; padding: 4px; background: linear-gradient(135deg, #a60ee5, #5b1e8f 45%, #1a1430 70%, #a60ee5); box-shadow: 0 24px 64px rgba(0,0,0,0.45); }
.cert-inner { background: radial-gradient(120% 140% at 50% 0%, #161226 0%, #0c0e15 70%); border-radius: 13px; padding: 34px 28px 26px; text-align: center; }
.cert-logo { width: 54px; height: 54px; opacity: 0.95; margin-bottom: 8px; }
.cert-kicker { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-faint); margin: 0; }
.cert-title { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; color: #fff; margin: 4px 0 18px; }
.cert-awarded { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); margin: 0; }
.cert-name { font-size: 25px; font-weight: 700; color: #fff; margin: 4px auto 16px; border-bottom: 1px solid var(--border); display: inline-block; padding: 0 18px 8px; min-width: 200px; }
.cert-seal { width: 76px; height: 76px; margin: 0 auto 14px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(#a60ee5, #b842f0, #a60ee5); color: #fff; font-weight: 800; box-shadow: 0 6px 20px rgba(166,14,229,0.4); }
.cert-pct { font-size: 22px; }
.cert-rating { font-size: 20px; font-weight: 700; color: var(--accent-strong); margin: 0 0 4px; }
.cert-note { color: var(--text-muted); margin: 0 0 18px; font-size: 14px; }
.cert-foot { display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 12px; font-size: 12px; color: var(--text-faint); letter-spacing: 0.04em; }
.cert-name-input { display: block; width: 100%; max-width: 560px; margin: 0 auto 8px; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--text); font: inherit; text-align: center; }
/* Landing CTA banner */
.quiz-cta { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 8px 0 36px; padding: 20px 24px; border-radius: 12px; border: 1px solid var(--accent); background: linear-gradient(120deg, rgba(166,14,229,0.16), rgba(166,14,229,0.04)); text-decoration: none; transition: transform 0.15s ease, border-color 0.15s ease; flex-wrap: wrap; }
.quiz-cta:hover { transform: translateY(-2px); text-decoration: none; border-color: var(--accent-strong); }
.quiz-cta strong { display: block; color: var(--text); font-size: 17px; }
.quiz-cta .sub { display: block; color: var(--text-muted); font-size: 14px; margin-top: 2px; }
.quiz-cta-go { white-space: nowrap; font-weight: 700; color: var(--accent-strong); }
.cert-name-label { display: block; text-align: center; font-size: 12px; color: var(--text-faint); letter-spacing: 0.04em; text-transform: uppercase; margin: 4px 0 6px; }
.quiz-unlocked-note { color: var(--text-muted); font-size: 14px; margin: 12px 0 0; }
.quiz-unlocked-note.quiz-locked { color: var(--text-faint); }
.quiz-unlock { margin: 16px 0 4px; padding: 14px 18px; border-radius: 10px; border: 1px solid #f5c542; background: linear-gradient(120deg, rgba(245,197,66,0.14), rgba(245,197,66,0.04)); }
.quiz-unlock strong { color: #f5c542; }
.quiz-unlock .quiz-btn { margin-top: 10px; }
.quiz-hard-card { border-color: rgba(245,197,66,0.5); }
.quiz-share-link { display: inline-block; margin-top: 14px; background: none; border: none; padding: 0; color: var(--text-muted); font-size: 14px; cursor: pointer; }
.quiz-share-link:hover { color: var(--accent-strong); text-decoration: underline; }
.licon { width: 1em; height: 1em; vertical-align: -0.14em; display: inline-block; flex: none; }
.quiz-unlock .licon, .quiz-perfect .licon { width: 1.1em; height: 1.1em; }
.certificate.expert { background: linear-gradient(135deg, #f5c542, #b8860b 45%, #1a1430 70%, #f5c542); }
.expert .cert-seal { background: conic-gradient(#f5c542, #ffe9a6, #d4a017, #f5c542); color: #1a1206; box-shadow: 0 6px 20px rgba(245,197,66,0.4); }
.expert .cert-rating { color: #f5c542; }

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
    max-width: 100%;
  }
  /* The pane scroll-fades are a desktop-only affordance. */
  .content-pane::before, .content-pane::after { display: none; }

  /* Sidebar becomes a sticky top bar: brand + search + a hamburger that
     reveals the full vertical nav. No more cramped horizontal scroll. */
  .sidebar {
    position: sticky;
    top: 0;
    align-self: start;
    z-index: 20;
    height: auto;
    max-height: 100vh;
    overflow-y: auto;
    padding: 12px 16px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    backdrop-filter: blur(8px);
  }
  .sidebar-top { justify-content: space-between; margin-bottom: 12px; }
  .sidebar-brand { margin-bottom: 0; text-align: left; }
  .sidebar-brand img { width: 60px; }
  .nav-toggle { display: flex; }
  .search { margin: 0; }
  /* Full nav hidden until the hamburger opens it. On mobile the whole dropdown
     scrolls (max-height: 100vh on .sidebar), so the nav itself must not. */
  .sidebar-nav { display: none; padding-top: 14px; flex: none; min-height: auto; overflow: visible; }
  .sidebar-nav.open { display: block; }
  .sidebar-intro { display: none; }
  .sidebar .cobrand { display: none; }
  .footer .cobrand {
    display: block;
    margin: 0 0 24px;
    padding-top: 0;
    border-top: 0;
  }
  .footer .cobrand-label { color: var(--text-faint); }

  .content {
    padding: 32px 20px 40px;
    max-width: 100%;
  }
  .content h1 { font-size: 26px; }
  .content h2 { font-size: 20px; margin: 36px 0 14px; padding-bottom: 6px; }
  .content h3 { font-size: 16px; margin: 24px 0 10px; }
  .content pre { padding: 12px 14px; font-size: 13px; border-radius: 6px; }
  .content code { font-size: 0.88em; }

  .content div[align="center"] h1 { font-size: 24px; }
  .content div[align="center"] strong { font-size: 16px; }
  .content div[align="center"] p { font-size: 15px; }

  .content table { font-size: 13px; }
  .content th, .content td { padding: 8px 10px; }

  .footer {
    margin-top: 56px;
    text-align: center;
  }
}

/* ── Phone ───────────────────────────────────────────────────────── */
@media (max-width: 480px) {
  .sidebar { padding: 10px 14px 0; }
  .sidebar-brand img { width: 56px; }
  .content { padding: 24px 16px 32px; }
  .content h1 { font-size: 22px; }
  .content div[align="center"] h1 { font-size: 20px; }
}
`;

// ── Landing page body ────────────────────────────────────────────────────────
// Hand-authored (not a README). The hero reuses the README `div[align="center"]`
// styling; the card grids link into the per-page docs the sidebar also lists.
const card = (href, title, desc) =>
  `  <a class="card" href="${href}"><h3>${title}</h3><p>${desc}</p></a>`;

const INDEX_BODY = `<div align="center">
  <h1>Bandit Agent Framework</h1>
  <p><strong>A local-first, model-agnostic agent stack you can run end to end on your own hardware.</strong></p>
  <p>A CLI, a VS Code / Cursor extension, an embeddable runtime, and the building blocks to assemble your own agent host. Off by default, no phone-home.</p>
</div>

<div class="demo-grid">
  <figure class="demo demo-cli"><img src="https://cdn.burtson.ai/images/cli-demo.gif" alt="Bandit CLI running a turn in the terminal" loading="lazy"><figcaption>Terminal CLI</figcaption></figure>
  <figure class="demo demo-ext"><img src="https://cdn.burtson.ai/images/ide-demo.gif" alt="Bandit Stealth in VS Code with diff approval" loading="lazy"><div class="demo-ext-copy"><span class="demo-ext-label">VS Code / Cursor extension</span><p>The same agent, docked in your editor — it reads and searches across the repo, plans its approach, and streams every tool call live, with each edit gated behind a diff you approve.</p></div></figure>
</div>

<h2>Why Bandit</h2>
<div class="why-grid">
  <div class="why"><strong>Runs on your hardware</strong><span>Local models via Ollama — your code never leaves the box, and there's no API meter ticking on every turn.</span></div>
  <div class="why"><strong>Model-agnostic</strong><span>Ollama, any OpenAI-compatible endpoint, or Bandit cloud — switch behind one contract. Never locked to a single vendor.</span></div>
  <div class="why"><strong>Private by design</strong><span>Off by default, no phone-home. Opt-in telemetry goes to a collector you control, and secrets are redacted first.</span></div>
  <div class="why"><strong>Yours to build on</strong><span>Apache 2.0 — fork it, embed the runtime, or assemble your own host from the same building blocks the products use.</span></div>
</div>

<h2>New to AI agents? Start here</h2>
<p>A short path from zero to building — each step links to a page.</p>
<ol class="path">
  <li><a href="./quickstart.html">Quickstart</a> — install and run your first agent in a couple of minutes.</li>
  <li><a href="./the-agent-loop.html">The agent loop</a> — the idea behind every agent, with cited sources.</li>
  <li><a href="./tools.html">Tools</a> and <a href="./memory.html">Memory</a> — what the agent can do, and what it carries between sessions.</li>
  <li><a href="./build-your-own-host.html">Build your own host</a> — assemble your own agent from the packages.</li>
  <li><a href="./glossary.html">Glossary</a> — look up any term as you go.</li>
</ol>

<a class="quiz-cta" href="./quiz.html">
  <div>
    <strong>Think you know your agents?</strong>
    <span class="sub">Take the 10-question glossary quiz and earn a certificate.</span>
  </div>
  <span class="quiz-cta-go">Test your knowledge →</span>
</a>

<h2>Bandit Stealth</h2>
<p>The shipping products — install and go.</p>
<div class="card-grid">
${card("./bandit-cli.html", "Bandit CLI", "The terminal agent. <code>npm i -g @burtson-labs/bandit-stealth-cli</code> and start a turn — local models via Ollama or any provider.")}
${card("./bandit-stealth.html", "VS Code / Cursor Extension", "The same agent docked into your editor — chat, approvals, diffs, and tool runs inside the IDE.")}
</div>

<h2>Build on it</h2>
<p>The reusable packages behind both products. Pull what you need, or assemble your own host — start with the <a href="./build-your-own-host.html">Build your own host</a> guide.</p>
<div class="card-grid">
${card("./agent-core.html", "agent-core", "Tool registry + the tool-use loop. The reasoning engine that drives a turn.")}
${card("./host-kit.html", "host-kit", "Host-agnostic building blocks: memory, hooks, the security guard, MCP, mentions.")}
${card("./stealth-core-runtime.html", "stealth-core-runtime", "The host-agnostic runtime that wires a provider, tools, and a host together.")}
${card("./agent-ui.html", "agent-ui", "React chat UI — the surface the extension and web hosts render.")}
${card("./core-chat.html", "core-chat", "ChatMessage types + model-output sanitization shared across hosts.")}
${card("./agent-adapters.html", "agent-adapters", "LLM providers + embeddings, with node / web / vscode / github environment adapters.")}
</div>

<h2>Install</h2>
<pre><code># Terminal agent
npm i -g @burtson-labs/bandit-stealth-cli

# Or build your own host on the packages
pnpm add @burtson-labs/agent-core @burtson-labs/host-kit</code></pre>

<p>Everything is <strong>Apache 2.0</strong> and on <a href="https://github.com/Burtson-Labs/bandit-agent-framework">GitHub</a>. Run a model locally and nothing leaves your machine.</p>`;

// ── Sidebar nav (grouped by section, + Overview link to the landing page) ─────
function renderNav(activeSlug) {
  const overview = `      <h3>Documentation</h3>
      <ul>
        <li><a href="./index.html"${activeSlug === "index" ? ' class="active"' : ""}>Overview</a></li>
      </ul>`;
  const groups = SECTIONS.map((section) => {
    const items = section.items
      .map(
        (p) =>
          `        <li><a href="./${p.slug}.html"${p.slug === activeSlug ? ' class="active"' : ""}>${p.name}</a></li>`
      )
      .join("\n");
    return `      <h3>${section.title}</h3>\n      <ul>\n${items}\n      </ul>`;
  }).join("\n");
  return `${overview}\n${groups}`;
}

// ── Shared page shell ────────────────────────────────────────────────────────
function renderShell({ title, description, activeSlug, body }) {
  const pageUrl = activeSlug === "index" ? `${BASE_URL}/` : `${BASE_URL}/${activeSlug}.html`;
  const ogType = activeSlug === "index" ? "website" : "article";
  const ogImg = `${BASE_URL}/og/${activeSlug}.png`;
  const srcReadme = PAGES.find((p) => p.slug === activeSlug)?.readme;
  const isPkg = !!srcReadme && srcReadme.endsWith("/README.md");
  const sourceUrl = !srcReadme ? REPO_URL
    : isPkg ? `${REPO_URL}/tree/main/${srcReadme.replace(/\/README\.md$/, "")}`
    : `${REPO_URL}/blob/main/${srcReadme}`;
  const sourceLabel = isPkg || !srcReadme ? "View source on GitHub" : "Edit this page on GitHub";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${pageUrl}">
  <meta name="robots" content="index, follow">
  <meta name="theme-color" content="#0a0c12">
  <meta property="og:type" content="${ogType}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:site_name" content="Bandit Agent Framework">
  <meta property="og:locale" content="en_US">
  <meta property="og:image" content="${ogImg}">
  <meta property="og:image:secure_url" content="${ogImg}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Bandit Agent Framework">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${ogImg}">
  <meta name="twitter:image:alt" content="Bandit Agent Framework">
  <meta name="twitter:site" content="@BurtsonLabs">
  <meta name="twitter:creator" content="@BurtsonLabs">
  <link rel="icon" href="https://cdn.burtson.ai/logos/bandit-stealth.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css" media="(prefers-color-scheme: dark)">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css" media="(prefers-color-scheme: light)">
  <style>${CSS}</style>
</head>
<body>
  <a href="#content" class="skip-link">Skip to content</a>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-top">
        <a href="./index.html" class="sidebar-brand">
          <img src="https://cdn.burtson.ai/logos/bandit-stealth.png" alt="Bandit Stealth">
        </a>
        <button class="nav-toggle" aria-label="Toggle navigation" aria-expanded="false" aria-controls="sidebar-nav">
          <span></span><span></span><span></span>
        </button>
      </div>
      <div class="search">
        <input type="search" id="docsearch" placeholder="Search docs…   /" autocomplete="off" spellcheck="false" aria-label="Search documentation">
        <div class="search-results" id="search-results" hidden></div>
      </div>
      <nav class="sidebar-nav" id="sidebar-nav" aria-label="Documentation">
        <div class="sidebar-intro">
          <p>The building blocks of <strong>Bandit Stealth</strong> — and a starting point for any agent product you want to build.</p>
        </div>
${renderNav(activeSlug)}
      </nav>
      <div class="cobrand">
        <div class="cobrand-label">Maintained by</div>
        <a href="https://burtson.ai" aria-label="Burtson Labs">
          <img class="logo-dark" src="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" alt="Burtson Labs">
          <img class="logo-light" src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs">
        </a>
      </div>
    </aside>
    <main id="content" class="content-pane">
      <div class="content">
${body}
      <footer class="footer">
        <div class="cobrand">
          <div class="cobrand-label">Maintained by</div>
          <a href="https://burtson.ai" aria-label="Burtson Labs">
            <img class="logo-dark" src="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" alt="Burtson Labs">
            <img class="logo-light" src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs">
          </a>
        </div>
        <p>Part of the <strong>Bandit Agent Framework</strong> — the same building blocks that power <a href="https://burtson.ai">Bandit Stealth</a>.</p>
        <p><a href="${sourceUrl}" target="_blank" rel="noopener">${sourceLabel} →</a></p>
        <p>Apache 2.0 — Copyright 2026 Burtson Labs.</p>
      </footer>
      </div>
    </main>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>document.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));</script>
  <script>
  // Desktop: the content scrolls in its own pane. Toggle the edge fades only when
  // there's more to scroll, and keep #hash deep links (e.g. glossary) landing inside it.
  (function () {
    var pane = document.getElementById("content");
    if (!pane) return;
    function update() {
      pane.classList.toggle("can-scroll-up", pane.scrollTop > 4);
      pane.classList.toggle("can-scroll-down", pane.scrollTop + pane.clientHeight < pane.scrollHeight - 4);
    }
    function jumpToHash() {
      if (!location.hash) return;
      var t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (t && t.scrollIntoView) t.scrollIntoView();
    }
    pane.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("hashchange", jumpToHash);
    window.addEventListener("load", function () { jumpToHash(); update(); });
    update();
  })();
  </script>
  <script>
  // Mobile nav toggle.
  (function () {
    var btn = document.querySelector(".nav-toggle");
    var nav = document.getElementById("sidebar-nav");
    if (!btn || !nav) return;
    btn.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
      btn.classList.toggle("open", open);
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) { nav.classList.remove("open"); btn.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
    });
  })();
  // Client-side docs search over search-index.json (lazy-loaded on first focus).
  (function () {
    var input = document.getElementById("docsearch");
    var box = document.getElementById("search-results");
    if (!input || !box) return;
    var index = null, loading = null;
    function esc(s) { return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
    function load() {
      if (index) return Promise.resolve();
      if (!loading) loading = fetch("./search-index.json").then(function (r) { return r.json(); }).then(function (d) { index = d; }).catch(function () { index = []; });
      return loading;
    }
    function snippet(text, terms) {
      var low = text.toLowerCase(), at = -1;
      for (var i = 0; i < terms.length; i++) { var p = low.indexOf(terms[i]); if (p >= 0) { at = p; break; } }
      if (at < 0) return text.slice(0, 130) + "…";
      var s = Math.max(0, at - 45);
      return (s > 0 ? "…" : "") + text.slice(s, s + 140) + "…";
    }
    function run() {
      var q = input.value.trim().toLowerCase();
      if (!q) { box.hidden = true; box.innerHTML = ""; return; }
      var terms = q.split(/\s+/);
      var hits = index.map(function (p) {
        var hay = (p.t + " " + p.c).toLowerCase(), score = 0;
        terms.forEach(function (t) {
          if (p.t.toLowerCase().indexOf(t) >= 0) score += 6;
          score += hay.split(t).length - 1;
        });
        return { p: p, score: score };
      }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
      if (!hits.length) { box.innerHTML = '<div class="search-empty">No matches</div>'; box.hidden = false; return; }
      box.innerHTML = hits.map(function (x) {
        return '<a class="search-hit" href="./' + x.p.u + '"><span class="search-hit-title">' + esc(x.p.t) + '</span><span class="search-hit-snip">' + esc(snippet(x.p.c, terms)) + "</span></a>";
      }).join("");
      box.hidden = false;
    }
    input.addEventListener("focus", load);
    input.addEventListener("input", function () { load().then(run); });
    input.addEventListener("keydown", function (e) { if (e.key === "Escape") { box.hidden = true; input.blur(); } });
    document.addEventListener("click", function (e) { if (!e.target.closest(".search")) box.hidden = true; });
  })();
  // Copy buttons on code blocks.
  (function () {
    document.querySelectorAll(".content pre").forEach(function (pre) {
      var code = pre.querySelector("code");
      if (!code) return;
      var btn = document.createElement("button");
      btn.className = "copy-btn"; btn.type = "button"; btn.textContent = "Copy";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(code.innerText.trim()).then(function () {
          btn.textContent = "Copied"; btn.classList.add("copied");
          setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
        });
      });
      pre.appendChild(btn);
    });
  })();
  // ⌘K / Ctrl-K / "/" focuses the search box.
  (function () {
    var input = document.getElementById("docsearch");
    if (!input) return;
    document.addEventListener("keydown", function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (((e.metaKey || e.ctrlKey) && e.key === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  })();
  </script>
</body>
</html>
`;
}

function renderPage(pkg) {
  const sourcePath = path.join(repoRoot, pkg.readme);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`README not found: ${sourcePath}`);
  }
  const body = md.render(fs.readFileSync(sourcePath, "utf8"), { glossaryLink: true, slug: pkg.slug, sourceDir: path.posix.dirname(pkg.readme) });
  return renderShell({
    title: `${pkg.name} — Bandit Agent Framework`,
    description: `Documentation for ${pkg.name}, part of the Bandit Agent Framework.`,
    activeSlug: pkg.slug,
    body
  });
}

function renderIndex() {
  return renderShell({
    title: "Bandit Agent Framework — Documentation",
    description: "Docs for the Bandit Agent Framework: the Bandit CLI, the VS Code / Cursor extension, and the open packages behind them.",
    activeSlug: "index",
    body: INDEX_BODY
  });
}

// Pull {anchor, term, def} from each glossary entry so the quiz can ask about
// real terms and cite the matching glossary anchor.
function parseGlossaryTerms() {
  const text = fs.readFileSync(path.join(repoRoot, "docs/reference/glossary.md"), "utf8");
  const terms = [];
  const re = /- <span id="([^"]+)"[^>]*><\/span>\*\*(.+?)\*\* [—–-] (.+)/g;
  let m;
  while ((m = re.exec(text))) {
    let def = m[3].split(/\s+→|\s+Source:/)[0].trim();           // drop the "→" / "Source:" tail
    def = def.split(/(?<=[.!?])\s+/)[0].trim();                       // keep the first sentence
    def = def.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim();  // strip markdown
    if (def.length > 8) terms.push({ anchor: m[1].trim(), term: m[2].trim(), def });
  }
  return terms;
}

// "Test your knowledge" — a client-side quiz page. The engine is a static file
// (quiz.js); we inject the glossary data as inline JSON so it has no dependencies.
function renderQuiz() {
  const data = JSON.stringify(parseGlossaryTerms()).replace(/</g, "\\u003c");
  const body = `<div align="center">
  <h1>Test your knowledge</h1>
  <p><strong>A quick quiz on AI &amp; agent terms, drawn straight from the glossary.</strong></p>
  <p>Match each definition to the right term, see the answer cited in the docs, then earn a certificate.</p>
</div>

<div id="quiz" class="quiz" aria-live="polite"></div>

<script>window.QUIZ_TERMS = ${data};
window.QUIZ_LOGO = "data:image/png;base64,${OG_LOGO_B64}";</script>
<script src="quiz.js"></script>`;
  return renderShell({
    title: "Test your AI fluency — Bandit Agent Framework quiz",
    description: "Can you ace it? A multiple-choice quiz on AI & agent terms, straight from the glossary. Earn a shareable certificate — and see if you can reach Bandit Sage.",
    activeSlug: "quiz",
    body
  });
}

// ── Build ──────────────────────────────────────────────────────────────────

const argSlug = process.argv[2];
const outDir = __dirname;

if (argSlug && argSlug !== "index" && !PAGES.some((p) => p.slug === argSlug)) {
  console.error(`No page matches slug "${argSlug}". Known slugs: index, ${PAGES.map((p) => p.slug).join(", ")}`);
  process.exit(1);
}

let built = 0;
// Landing page builds on a full run or an explicit `index`.
if (!argSlug || argSlug === "index") {
  fs.writeFileSync(path.join(outDir, "index.html"), renderIndex());
  console.log(`  index.html`);
  built++;
}
const targets = argSlug && argSlug !== "index" ? PAGES.filter((p) => p.slug === argSlug) : PAGES;
for (const pkg of targets) {
  const html = pkg.quiz ? renderQuiz() : renderPage(pkg);
  fs.writeFileSync(path.join(outDir, `${pkg.slug}.html`), html);
  console.log(`  ${pkg.slug}.html  (${(html.length / 1024).toFixed(1)} KB)`);
  built++;
}
// SEO: robots + sitemap so crawlers can discover and index every page.
const sitemapUrls = [`${BASE_URL}/`, ...PAGES.map((p) => `${BASE_URL}/${p.slug}.html`)];
fs.writeFileSync(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);
fs.writeFileSync(
  path.join(outDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    sitemapUrls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") +
    `\n</urlset>\n`
);
console.log("  robots.txt + sitemap.xml");

// Full-text search index for the client-side search box. Built from every
// page (the landing body + each README), HTML stripped to plain text.
const stripText = (h) => h.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const searchEntries = [
  { t: "Overview", u: "index.html", c: stripText(INDEX_BODY) },
  ...PAGES.map((p) => ({
    t: p.name,
    u: `${p.slug}.html`,
    c: p.quiz
      ? "Test your knowledge — a multiple-choice quiz on AI and agent terms drawn from the glossary, with a certificate at the end."
      : stripText(md.render(fs.readFileSync(path.join(repoRoot, p.readme), "utf8")))
  }))
];
fs.writeFileSync(path.join(outDir, "search-index.json"), JSON.stringify(searchEntries));
console.log("  search-index.json");

// Per-page Open Graph cards — Bandit-branded, with each page's kind + title +
// real tagline. So linking a specific package unfurls with that page's own card.
fs.mkdirSync(path.join(outDir, "og"), { recursive: true });
writeOgCard(outDir, "index", {
  kind: "Documentation",
  title: "Bandit Agent Framework",
  subtitle: "Local-first, model-agnostic agent stack you run on your own hardware."
});
for (const section of SECTIONS) {
  for (const item of section.items) {
    if (item.quiz) {
      const png = new Resvg(quizCardSvg(), { font: { loadSystemFonts: true } }).render().asPng();
      fs.writeFileSync(path.join(outDir, "og", `${item.slug}.png`), png);
      continue;
    }
    const src = item.readme ? path.join(repoRoot, item.readme) : null;
    const tagline = src && fs.existsSync(src) ? taglineFrom(fs.readFileSync(src, "utf8")) : "";
    writeOgCard(outDir, item.slug, {
      kind: KIND_LABEL[section.title] || section.title,
      title: item.name.replace(/^@burtson-labs\//, ""),
      // Prefer an explicit per-page tagline; fall back to the README hero heuristic.
      subtitle: item.tagline || tagline
    });
  }
}
console.log(`  og/ cards (${PAGES.length + 1})`);
console.log(`Done. ${built} page(s) generated in ${path.relative(process.cwd(), outDir)}.`);
