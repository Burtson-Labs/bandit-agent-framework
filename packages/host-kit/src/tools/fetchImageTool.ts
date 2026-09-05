/**
 * `fetch_image` — let the AGENT confirm an image URL is usable in an artifact
 * BEFORE embedding it, instead of flailing through dozens of dead/hotlink-blocked
 * URLs. It fetches the URL server-side (which bypasses the browser hotlink
 * protection that blocks most direct image links) and reports whether it's a
 * reachable image and its size. On publish, usable images are auto-inlined
 * (see inlineHtmlImages), so the artifact ends up self-contained.
 */
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function buildFetchImageTool(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AgentTool {
  return {
    name: 'fetch_image',
    description:
      'Check whether an image URL is usable in an artifact. Fetches it server-side (this bypasses the browser ' +
      'hotlink protection that blocks most direct image links), and reports if it is a reachable image and its size. ' +
      'Use this to pick a working image before writing <img src="URL"> — do NOT keep web-searching for a "hotlinkable" ' +
      'URL. On publish, usable images are automatically inlined into the artifact, so any URL that passes here will ' +
      'render. After ~2 failed images, fall back to an SVG/initial-based avatar instead of searching more.',
    parameters: [
      { name: 'url', description: 'A direct image URL (jpg/png/webp/gif/svg) to verify.', required: true }
    ],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      const url = (params.url ?? '').trim();
      if (!url) return { output: 'Error: the `url` parameter is required.', isError: true };
      if (!/^https?:\/\//i.test(url)) return { output: 'Error: url must be an http(s) URL.', isError: true };
      const fetchImpl = opts.fetchImpl ?? fetch;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
      try {
        const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'follow' } as RequestInit);
        if (!res.ok) return { output: `Not usable: ${url} returned HTTP ${res.status}. Pick a different image.` };
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        if (!/^image\//i.test(type)) return { output: `Not an image: ${url} is "${type || 'unknown'}". Pick a direct image URL.` };
        const bytes = (await res.arrayBuffer()).byteLength;
        if (bytes > 4 * 1024 * 1024) return { output: `Reachable but large (${humanSize(bytes)}, ${type}) — it won't inline (cap 4 MB). Use a smaller/thumbnail image.` };
        return { output: `Usable: ${type}, ${humanSize(bytes)}. Embed it with <img src="${url}"> — it will be inlined into the artifact on publish.` };
      } catch (err) {
        const aborted = (err as Error)?.name === 'AbortError';
        return { output: aborted ? `Timed out fetching ${url}. Pick a different image.` : `Couldn't fetch ${url}: ${err instanceof Error ? err.message : String(err)}. Pick a different image.` };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
