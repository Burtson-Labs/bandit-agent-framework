/**
 * inlineHtmlImages + fetch_image. Properties: <img> sources (remote + local) are
 * rewritten to data URIs so an HTML artifact is self-contained; non-image /
 * unreachable / oversized / already-inline sources are left untouched; the
 * fetch_image tool reports whether a URL is a usable image.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inlineHtmlImages } from '../src/imageInline';
import { buildFetchImageTool } from '../src/tools/fetchImageTool';

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const imageResponse = (bytes: Buffer, type = 'image/png') => ({
  ok: true, status: 200,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
} as unknown as Response);

describe('inlineHtmlImages', () => {
  it('inlines a remote image src as a data URI', async () => {
    const fetchImpl = (async () => imageResponse(pngBytes)) as unknown as typeof fetch;
    const html = '<img src="https://example.com/raphael.png" alt="r">';
    const r = await inlineHtmlImages(html, { fetchImpl });
    expect(r.inlined).toBe(1);
    expect(r.html).toContain('src="data:image/png;base64,');
    expect(r.html).not.toContain('https://example.com/raphael.png');
  });

  it('leaves a non-image response untouched (and counts it skipped)', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)) as unknown as typeof fetch;
    const html = '<img src="https://example.com/page.html">';
    const r = await inlineHtmlImages(html, { fetchImpl });
    expect(r.inlined).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.html).toContain('https://example.com/page.html');
  });

  it('leaves an existing data: URI alone', async () => {
    const html = '<img src="data:image/gif;base64,AAAA">';
    const r = await inlineHtmlImages(html, {});
    expect(r.inlined).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.html).toBe(html);
  });

  it('inlines a local file resolved against baseDir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-'));
    fs.writeFileSync(path.join(dir, 'avatar.png'), pngBytes);
    const r = await inlineHtmlImages('<img src="avatar.png">', { baseDir: dir });
    expect(r.inlined).toBe(1);
    expect(r.html).toContain('data:image/png;base64,');
  });

  it('skips an image over the per-image cap', async () => {
    const big = Buffer.alloc(2048, 7);
    const fetchImpl = (async () => imageResponse(big)) as unknown as typeof fetch;
    const r = await inlineHtmlImages('<img src="https://x/big.png">', { fetchImpl, maxImageBytes: 1024 });
    expect(r.inlined).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe('buildFetchImageTool', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  type Reply = { status: number; type?: string; bytes?: number; location?: string };
  const transportFrom = (reply: (url: URL) => Reply, seen: string[] = []) =>
    (async (url: URL, pinned: { address: string }) => {
      seen.push(`${url.href}@${pinned.address}`);
      const r = reply(url);
      const headers: Record<string, string> = {};
      if (r.type) headers['content-type'] = r.type;
      if (r.location) headers.location = r.location;
      return { status: r.status, statusText: '', headers, body: '', bytes: r.bytes ?? 0 };
    });

  it('reports a usable image', async () => {
    const res = await buildFetchImageTool({ lookup: publicLookup, transport: transportFrom(() => ({ status: 200, type: 'image/png', bytes: pngBytes.length })) })
      .execute({ url: 'https://x.example/a.png' }, {} as never);
    expect(res.output).toMatch(/Usable: image\/png, 12 B/);
  });

  it('rejects a non-image', async () => {
    const res = await buildFetchImageTool({ lookup: publicLookup, transport: transportFrom(() => ({ status: 200, type: 'text/html' })) })
      .execute({ url: 'https://x.example/p.html' }, {} as never);
    expect(res.output).toMatch(/Not an image/);
  });

  it('rejects an http error', async () => {
    const res = await buildFetchImageTool({ lookup: publicLookup, transport: transportFrom(() => ({ status: 404 })) })
      .execute({ url: 'https://x.example/missing.png' }, {} as never);
    expect(res.output).toMatch(/Not usable|HTTP 404/);
  });

  it('errors on a missing url with no network', async () => {
    const seen: string[] = [];
    const res = await buildFetchImageTool({ lookup: publicLookup, transport: transportFrom(() => ({ status: 200 }), seen) }).execute({}, {} as never);
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it('refuses loopback, LAN and link-local targets without connecting', async () => {
    for (const url of [
      'http://127.0.0.1:11555/probe.png?leak=SECRET',
      'http://localhost/a.png',
      'http://192.168.1.10/a.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/a.png'
    ]) {
      const seen: string[] = [];
      const res = await buildFetchImageTool({ allowPrivate: false, lookup: publicLookup, transport: transportFrom(() => ({ status: 200, type: 'image/png' }), seen) })
        .execute({ url }, {} as never);
      expect(res.output, url).toMatch(/Blocked/);
      expect(res.isError, url).toBe(true);
      expect(seen, url).toEqual([]);
    }
  });

  it('refuses a public name that resolves to a private address', async () => {
    const seen: string[] = [];
    const res = await buildFetchImageTool({
      allowPrivate: false,
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      transport: transportFrom(() => ({ status: 200, type: 'image/png' }), seen)
    }).execute({ url: 'https://rebind.example/a.png' }, {} as never);
    expect(res.output).toMatch(/Blocked/);
    expect(seen).toEqual([]);
  });

  it('re-checks every redirect hop', async () => {
    const seen: string[] = [];
    const res = await buildFetchImageTool({
      allowPrivate: false,
      lookup: publicLookup,
      transport: transportFrom(() => ({ status: 302, location: 'http://127.0.0.1/a.png' }), seen)
    }).execute({ url: 'https://x.example/a.png' }, {} as never);
    expect(res.output).toMatch(/Blocked: redirect to 127\.0\.0\.1/);
    expect(seen).toHaveLength(1);
  });

  it('connects to the vetted address', async () => {
    const seen: string[] = [];
    await buildFetchImageTool({ lookup: publicLookup, transport: transportFrom(() => ({ status: 200, type: 'image/png' }), seen) })
      .execute({ url: 'https://x.example/a.png' }, {} as never);
    expect(seen).toEqual(['https://x.example/a.png@93.184.216.34']);
  });

  it('still vets the host when a fetchImpl test seam is passed', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return imageResponse(pngBytes); }) as unknown as typeof fetch;
    const res = await buildFetchImageTool({ allowPrivate: false, fetchImpl }).execute({ url: 'http://127.0.0.1/a.png' }, {} as never);
    expect(res.output).toMatch(/Blocked/);
    expect(called).toBe(false);
  });
});
