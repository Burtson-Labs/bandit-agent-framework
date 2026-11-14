/**
 * Link-preview fallbacks for a published artifact. When the model (or a host) does
 * not give publish_artifact a title/description, derive them from the content so a
 * pasted share link still shows something meaningful in Slack, Teams, iMessage etc.
 *
 * S3Api applies the same kind of fallback server-side, so this is belt-and-braces:
 * pure, bounded, and it never throws — any failure just yields `{}`.
 */
import { ARTIFACT_DESCRIPTION_MAX, ARTIFACT_TITLE_MAX, guessContentType } from './artifacts';

export interface PreviewMeta {
  title?: string;
  description?: string;
}

/** Only the start of a document matters for a title/summary; bounding the scan keeps
 *  the regexes cheap on a multi-megabyte artifact. */
const SCAN_LIMIT = 256 * 1024;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  times: '×', rarr: '→', larr: '←',
};

/** Decode HTML character references (named subset + numeric). Unknown names stay as-is. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {return whole;}
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Collapse whitespace/control characters and cap at `max` code points, cutting at a
 *  word boundary when one is reasonably close and marking the cut with an ellipsis. */
function clean(text: string | undefined, max: number): string | undefined {
  if (!text) {return undefined;}
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) {return undefined;}
  const chars = Array.from(flat);
  if (chars.length <= max) {return flat;}
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const base = space >= Math.floor(max * 0.6) ? cut.slice(0, space) : cut;
  return base.replace(/[\s,;:.—–-]+$/, '') + '…';
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '));
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function fromHtml(html: string): PreviewMeta {
  // Drop comments, scripts, styles, templates and SVG text so they can't leak into a summary.
  const doc = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc)?.[1];
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(doc)?.[1];
  const title = clean(titleTag ? stripTags(titleTag) : undefined, ARTIFACT_TITLE_MAX)
    ?? clean(h1 ? stripTags(h1) : undefined, ARTIFACT_TITLE_MAX);

  let description: string | undefined;
  for (const m of doc.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], 'name') ?? attr(m[0], 'property') ?? '').toLowerCase();
    if (name === 'description' || name === 'og:description' || name === 'twitter:description') {
      description = clean(decodeHtmlEntities(attr(m[0], 'content') ?? ''), ARTIFACT_DESCRIPTION_MAX);
      if (description) {break;}
    }
  }
  if (!description) {
    for (const m of doc.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
      description = clean(stripTags(m[1]), ARTIFACT_DESCRIPTION_MAX);
      if (description) {break;}
    }
  }
  return { title, description };
}

/** Inline markdown → plain text: images/links keep their label, code/emphasis marks go. */
function mdInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/<[^>]*>/g, ' ');
}

function fromMarkdown(md: string): PreviewMeta {
  let text = md.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let fmTitle: string | undefined;
  let fmDescription: string | undefined;
  const fm = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/.exec(text);
  if (fm) {
    const unquote = (v?: string) => v?.trim().replace(/^(['"])(.*)\1$/, '$2');
    fmTitle = unquote(/^title:\s*(.+)$/m.exec(fm[1])?.[1]);
    fmDescription = unquote(/^(?:description|summary):\s*(.+)$/m.exec(fm[1])?.[1]);
    text = text.slice(fm[0].length);
  }

  const lines = text.split('\n');
  let h1: string | undefined;
  let anyHeading: string | undefined;
  let paragraph: string | undefined;
  let inFence = false;
  let para: string[] = [];
  const flush = () => {
    if (!paragraph && para.length) {paragraph = para.join(' ');}
    para = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); inFence = !inFence; continue; }
    if (inFence) {continue;}
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      if (heading[1].length === 1 && !h1) {h1 = heading[2];}
      if (!anyHeading) {anyHeading = heading[2];}
      continue;
    }
    // Paragraph text: skip blank lines, lists, quotes, tables, rules, HTML blocks, images.
    if (!line.trim() || /^\s*([-*+]\s|\d+[.)]\s|>|\||<|!\[|([-*_]\s*){3,}$)/.test(line) || /^\s*[=-]+\s*$/.test(line)) {
      flush();
      continue;
    }
    if (!paragraph) {para.push(line.trim());}
    if (h1 && paragraph) {break;}
  }
  flush();

  const title = clean(fmTitle ? decodeHtmlEntities(fmTitle) : undefined, ARTIFACT_TITLE_MAX)
    ?? clean(h1 ? decodeHtmlEntities(mdInline(h1)) : undefined, ARTIFACT_TITLE_MAX)
    ?? clean(anyHeading ? decodeHtmlEntities(mdInline(anyHeading)) : undefined, ARTIFACT_TITLE_MAX);
  const description = clean(fmDescription ? decodeHtmlEntities(fmDescription) : undefined, ARTIFACT_DESCRIPTION_MAX)
    ?? clean(paragraph ? decodeHtmlEntities(mdInline(paragraph)) : undefined, ARTIFACT_DESCRIPTION_MAX);
  return { title, description };
}

/**
 * Derive a link-preview title/description from an artifact's content.
 * - HTML: `<title>`, else the first `<h1>`; description from `<meta name="description">`
 *   (or og:/twitter:description), else the first non-empty `<p>`.
 * - Markdown: front-matter `title:`, else the first `# ` heading (else any heading);
 *   description from front-matter, else the first paragraph.
 * Other types (PDF, images, JSON, …) yield `{}` — the server falls back to the filename.
 * Results are entity-decoded, whitespace-collapsed and capped (90 / 200). Never throws.
 */
export function derivePreviewMeta(
  content: string | Uint8Array | null | undefined,
  contentType?: string,
  filename?: string
): PreviewMeta {
  try {
    const type = (contentType || (filename ? guessContentType(filename) : '') || '').toLowerCase();
    const isHtml = /html/.test(type);
    const isMarkdown = /markdown/.test(type) || /\.(md|markdown)$/i.test(filename ?? '');
    if (!isHtml && !isMarkdown) {return {};}
    if (content == null) {return {};}
    let text: string;
    if (typeof content === 'string') {
      text = content.slice(0, SCAN_LIMIT);
    } else if (content instanceof Uint8Array) {
      text = new TextDecoder('utf-8', { fatal: false }).decode(content.subarray(0, SCAN_LIMIT));
    } else {
      return {};
    }
    const meta = isHtml ? fromHtml(text) : fromMarkdown(text);
    const out: PreviewMeta = {};
    if (meta.title) {out.title = meta.title;}
    if (meta.description && meta.description !== meta.title) {out.description = meta.description;}
    return out;
  } catch {
    return {};
  }
}
