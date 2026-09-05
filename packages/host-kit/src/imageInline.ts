/**
 * Inline `<img>` sources into a standalone HTML artifact. This is what makes
 * "put an image in an artifact" actually work: the agent references any image
 * (a local path, the user's pasted screenshot, or a remote URL), and at publish
 * time we fetch/read each one and rewrite its `src` to a base64 `data:` URI —
 * so the single HTML file renders the image anywhere, with no hotlink protection
 * or missing-file surprises (a server-side GET usually succeeds where a browser
 * hotlink is blocked).
 *
 * Bounded: per-image + total byte caps (the artifact limit is 25 MB), a fetch
 * timeout, and non-image / oversized / unreachable sources are left untouched.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface InlineImagesOptions {
  /** Resolve relative local `src` paths against this directory (default cwd). */
  baseDir?: string;
  fetchImpl?: typeof fetch;
  /** Skip any single image larger than this (default 4 MB). */
  maxImageBytes?: number;
  /** Stop inlining once the running total passes this (default 20 MB; artifact cap is 25 MB). */
  maxTotalBytes?: number;
  /** Per-remote-fetch timeout, ms (default 15000). */
  timeoutMs?: number;
}

export interface InlineImagesResult {
  html: string;
  inlined: number;
  skipped: number;
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif'
};

function mimeFromPath(p: string): string {
  return EXT_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve one `src` to a data URI, or null to leave it as-is. */
async function resolveOne(
  src: string,
  opts: Required<Pick<InlineImagesOptions, 'baseDir' | 'fetchImpl' | 'maxImageBytes' | 'timeoutMs'>>,
  budgetLeft: number
): Promise<string | null> {
  if (!src || src.startsWith('data:')) return null;
  try {
    let bytes: Buffer;
    let mime: string;
    if (/^https?:\/\//i.test(src)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      let res: Response;
      try {
        res = await opts.fetchImpl(src, { signal: ctl.signal, redirect: 'follow' } as RequestInit);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!/^image\//i.test(mime)) return null;
      bytes = Buffer.from(await res.arrayBuffer());
    } else {
      const abs = path.isAbsolute(src) ? src : path.join(opts.baseDir, src);
      bytes = await fs.promises.readFile(abs);
      mime = mimeFromPath(abs);
      if (!mime.startsWith('image/')) return null;
    }
    if (bytes.byteLength > opts.maxImageBytes || bytes.byteLength > budgetLeft) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Rewrite every inlinable `<img src>` in the HTML to a base64 data URI. Returns
 * the new HTML plus counts. Non-HTML callers should skip this.
 */
export async function inlineHtmlImages(html: string, options: InlineImagesOptions = {}): Promise<InlineImagesResult> {
  const opts = {
    baseDir: options.baseDir ?? process.cwd(),
    fetchImpl: options.fetchImpl ?? fetch,
    maxImageBytes: options.maxImageBytes ?? 4 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 15000
  };
  const maxTotal = options.maxTotalBytes ?? 20 * 1024 * 1024;

  // Match <img ... src="X" ...>; capture the quote + value so we can rewrite in place.
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
  const matches = [...html.matchAll(imgRe)];
  if (matches.length === 0) return { html, inlined: 0, skipped: 0 };

  let total = 0;
  let inlined = 0;
  let skipped = 0;
  // Resolve sequentially so the running budget is honored deterministically.
  const rewrites: Array<{ index: number; length: number; text: string }> = [];
  for (const m of matches) {
    const full = m[0];
    const quote = m[1];
    const src = m[2];
    const dataUri = await resolveOne(src, opts, maxTotal - total);
    if (dataUri == null) {
      if (src && !src.startsWith('data:')) skipped++;
      continue;
    }
    total += Math.ceil((dataUri.length - 'data:;base64,'.length) * 0.75); // approx original bytes
    const newTag = full.replace(`=${quote}${src}${quote}`, `=${quote}${dataUri}${quote}`);
    rewrites.push({ index: m.index ?? 0, length: full.length, text: newTag });
    inlined++;
  }
  if (rewrites.length === 0) return { html, inlined: 0, skipped };

  // Rebuild by index so duplicate identical tags each get replaced correctly.
  let out = '';
  let last = 0;
  for (const r of rewrites) {
    out += html.slice(last, r.index) + r.text;
    last = r.index + r.length;
  }
  out += html.slice(last);
  return { html: out, inlined, skipped };
}
