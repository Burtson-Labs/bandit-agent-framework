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
  it('reports a usable image', async () => {
    const fetchImpl = (async () => imageResponse(pngBytes)) as unknown as typeof fetch;
    const res = await buildFetchImageTool({ fetchImpl }).execute({ url: 'https://x/a.png' }, {} as never);
    expect(res.output).toMatch(/Usable/);
  });

  it('rejects a non-image', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)) as unknown as typeof fetch;
    const res = await buildFetchImageTool({ fetchImpl }).execute({ url: 'https://x/p.html' }, {} as never);
    expect(res.output).toMatch(/Not an image/);
  });

  it('rejects an http error', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)) as unknown as typeof fetch;
    const res = await buildFetchImageTool({ fetchImpl }).execute({ url: 'https://x/missing.png' }, {} as never);
    expect(res.output).toMatch(/Not usable|HTTP 404/);
  });

  it('errors on a missing url with no network', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return imageResponse(pngBytes); }) as unknown as typeof fetch;
    const res = await buildFetchImageTool({ fetchImpl }).execute({}, {} as never);
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });
});
