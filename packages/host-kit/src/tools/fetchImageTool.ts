/**
 * `fetch_image` — let the AGENT confirm an image URL is usable in an artifact
 * BEFORE embedding it, instead of flailing through dozens of dead/hotlink-blocked
 * URLs. It fetches the URL server-side (which bypasses the browser hotlink
 * protection that blocks most direct image links) and reports whether it's a
 * reachable image and its size. On publish, usable images are auto-inlined
 * (see inlineHtmlImages), so the artifact ends up self-contained.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { guardedGet, responseHeader, type LookupAllFn, type PinnedTransport } from './ssrfGuard';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FetchImageToolOptions {
  timeoutMs?: number;
  /** Allow private/loopback/link-local targets. Default: BANDIT_ALLOW_PRIVATE_WEB_FETCH=1. */
  allowPrivate?: boolean;
  /** DNS resolution, injectable for tests. */
  lookup?: LookupAllFn;
  /** Pinned-connection transport, injectable for tests. */
  transport?: PinnedTransport;
  /**
   * Test seam kept for compatibility: performs the request instead of the
   * pinned transport. The host is still vetted (private addresses refused,
   * every redirect re-checked) before it is called.
   */
  fetchImpl?: typeof fetch;
}

/** Adapt a fetch implementation to the guard's transport (tests only). */
function fetchTransport(fetchImpl: typeof fetch): PinnedTransport {
  return async (url, _pinned, opts) => {
    const res = await fetchImpl(url.href, { headers: opts.headers, redirect: 'manual' } as RequestInit);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const buf = await res.arrayBuffer();
    return { status: res.status, statusText: res.statusText, headers, body: '', bytes: buf.byteLength };
  };
}

/**
 * fetch_image goes through the same SSRF guard as web_fetch: private,
 * loopback and link-local targets are refused (BANDIT_ALLOW_PRIVATE_WEB_FETCH=1
 * opts out), the connection is pinned to the vetted address, and every
 * redirect is re-checked. Before 2026-10-21 it fetched any URL, including the
 * LAN and loopback.
 */
export function buildFetchImageTool(opts: FetchImageToolOptions = {}): AgentTool {
  return {
    name: 'fetch_image',
    description:
      'Check whether an image URL is usable in an artifact. Fetches it server-side (this bypasses the browser ' +
      'hotlink protection that blocks most direct image links), and reports if it is a reachable image and its size. ' +
      'Use this to pick a working image before writing <img src="URL"> — do NOT keep web-searching for a "hotlinkable" ' +
      'URL. On publish, usable images are automatically inlined into the artifact, so any URL that passes here will ' +
      'render. After ~2 failed images, fall back to an SVG/initial-based avatar instead of searching more. ' +
      'Private, loopback and link-local addresses are refused.',
    parameters: [
      { name: 'url', description: 'A direct image URL (jpg/png/webp/gif/svg) to verify.', required: true }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const url = (params.url ?? '').trim();
      if (!url) return { output: 'Error: the `url` parameter is required.', isError: true };
      if (!/^https?:\/\//i.test(url)) return { output: 'Error: url must be an http(s) URL.', isError: true };
      const got = await guardedGet(url, {
        allowPrivate: opts.allowPrivate ?? process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH === '1',
        lookup: opts.lookup,
        transport: opts.transport ?? (opts.fetchImpl ? fetchTransport(opts.fetchImpl) : undefined),
        timeoutMs: opts.timeoutMs ?? 15000,
        headers: { 'User-Agent': 'bandit-cli/0.1', Accept: 'image/*;q=0.9,*/*;q=0.5' }
      });
      if (!got.ok) {
        const aborted = /aborted due to timeout/i.test(got.output);
        return { output: aborted ? `Timed out fetching ${url}. Pick a different image.` : `Couldn't fetch ${url}: ${got.output}. Pick a different image.` };
      }
      const res = got.response;
      if (res.status < 200 || res.status >= 300) return { output: `Not usable: ${url} returned HTTP ${res.status}. Pick a different image.` };
      const type = (responseHeader(res.headers, 'content-type') ?? '').split(';')[0].trim();
      if (!/^image\//i.test(type)) return { output: `Not an image: ${url} is "${type || 'unknown'}". Pick a direct image URL.` };
      const bytes = res.bytes ?? Buffer.byteLength(res.body);
      if (bytes > 4 * 1024 * 1024) return { output: `Reachable but large (${humanSize(bytes)}, ${type}) — it won't inline (cap 4 MB). Use a smaller/thumbnail image.` };
      return { output: `Usable: ${type}, ${humanSize(bytes)}. Embed it with <img src="${url}"> — it will be inlined into the artifact on publish.` };
    }
  };
}
