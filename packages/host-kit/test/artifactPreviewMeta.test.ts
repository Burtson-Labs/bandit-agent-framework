/**
 * Link-preview metadata for artifacts. Properties: Title/Description travel as
 * multipart text parts next to the file part only when given; a CR/LF in a value
 * can't open a new header or part; PUT clears with ''; setArtifactMeta POSTs the
 * JSON contract and maps 404; the publish/update tools pass the model's values
 * through (publish derives missing ones from the content); derivePreviewMeta is
 * pure, capped and never throws.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildMultipartBody,
  publishArtifact,
  updateArtifact,
  setArtifactMeta,
  normalizeArtifactMetaField,
  listArtifacts
} from '../src/artifacts';
import { derivePreviewMeta, decodeHtmlEntities } from '../src/previewMeta';
import { buildPublishArtifactTool } from '../src/tools/publishArtifactTool';
import { buildUpdateArtifactTool } from '../src/tools/updateArtifactTool';

interface Part { headers: string[]; body: string }

/** Minimal multipart parser: split on the boundary from the content-type header. */
function parseMultipart(body: Uint8Array, contentType: string): Part[] {
  const boundary = /boundary=(.+)$/.exec(contentType)![1];
  const text = new TextDecoder().decode(body);
  expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  const chunks = text.split(`--${boundary}`);
  // chunks[0] is the (empty) preamble; the last is "--\r\n".
  expect(chunks[0]).toBe('');
  return chunks.slice(1, -1).map((chunk) => {
    expect(chunk.startsWith('\r\n')).toBe(true);
    expect(chunk.endsWith('\r\n')).toBe(true);
    const inner = chunk.slice(2, -2);
    const sep = inner.indexOf('\r\n\r\n');
    return { headers: inner.slice(0, sep).split('\r\n'), body: inner.slice(sep + 4) };
  });
}

function nameOf(part: Part): string | undefined {
  return /name="([^"]*)"/.exec(part.headers[0])?.[1];
}

type Captured = { url: string; method?: string; contentType?: string; body?: unknown };

function capture(response: { ok?: boolean; status?: number; body?: unknown } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    calls.push({ url, method: init?.method, contentType: init?.headers?.['content-type'], body: init?.body });
    const ok = response.ok ?? true;
    return {
      ok,
      status: response.status ?? (ok ? 200 : 500),
      json: async () => response.body ?? { url: 'https://s3/api/artifact/owner-1/a.html', key: 'owner-1/a.html', size: 1 },
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function partsOf(call: Captured): Part[] {
  return parseMultipart(call.body as Uint8Array, call.contentType!);
}

describe('buildMultipartBody', () => {
  const file = { fieldName: 'File', filename: 'report.html', contentType: 'text/html', bytes: new TextEncoder().encode('<h1>hi</h1>') };

  it('emits text parts ahead of the file part, file part unchanged', () => {
    const { body, contentType } = buildMultipartBody(file, [['Title', 'Q3 review'], ['Description', 'Latency by region.']]);
    const parts = parseMultipart(body, contentType);
    expect(parts.map(nameOf)).toEqual(['Title', 'Description', 'File']);
    expect(parts[0].headers).toEqual(['Content-Disposition: form-data; name="Title"']);
    expect(parts[0].body).toBe('Q3 review');
    expect(parts[1].body).toBe('Latency by region.');
    expect(parts[2].headers).toEqual([
      'Content-Disposition: form-data; name="File"; filename="report.html"',
      'Content-Type: text/html',
    ]);
    expect(parts[2].body).toBe('<h1>hi</h1>');
  });

  it('with no fields, is just the file part (backwards compatible)', () => {
    const { body, contentType } = buildMultipartBody(file);
    const parts = parseMultipart(body, contentType);
    expect(parts.map(nameOf)).toEqual(['File']);
  });

  it('CR/LF/NUL in a value cannot add headers or parts', () => {
    const evil = 'x\r\n--fake\r\nContent-Disposition: form-data; name="Scope"\r\n\r\nteam\u0000';
    const { body, contentType } = buildMultipartBody(file, [['Title', evil]]);
    const parts = parseMultipart(body, contentType);
    expect(parts.map(nameOf)).toEqual(['Title', 'File']);
    expect(parts[0].headers).toHaveLength(1);
    // eslint-disable-next-line no-control-regex
    expect(parts[0].body).not.toMatch(/[\r\n\u0000]/);
  });

  it('escapes quotes/CR/LF in field names and filenames', () => {
    const { body, contentType } = buildMultipartBody(
      { ...file, filename: 'a"b\r\nc.html' },
      [['Ti"tle\r\nX-Evil: 1', 'v']]
    );
    const parts = parseMultipart(body, contentType);
    expect(parts).toHaveLength(2);
    expect(parts[0].headers).toEqual(['Content-Disposition: form-data; name="Ti%22tle%0D%0AX-Evil: 1"']);
    expect(parts[1].headers[0]).toBe('Content-Disposition: form-data; name="File"; filename="a_b__c.html"');
  });

  it('encodes non-ASCII values as UTF-8', () => {
    const { body, contentType } = buildMultipartBody(file, [['Title', 'Résumé — 東京']]);
    expect(parseMultipart(body, contentType)[0].body).toBe('Résumé — 東京');
  });
});

describe('normalizeArtifactMetaField', () => {
  it('flattens control characters, collapses whitespace, trims, caps by code point', () => {
    expect(normalizeArtifactMetaField('  a\r\n\tb\u0000c  ', 90)).toBe('a b c');
    expect(Array.from(normalizeArtifactMetaField('😀'.repeat(100), 90))).toHaveLength(90);
    expect(normalizeArtifactMetaField('x'.repeat(250), 200)).toHaveLength(200);
  });
});

describe('publishArtifact link-preview fields', () => {
  it('sends trimmed Title/Description when given', async () => {
    const { calls, fetchImpl } = capture();
    await publishArtifact({
      s3ApiBaseUrl: 'https://s3', token: 'jwt', content: '<p>x</p>', filename: 'a.html',
      title: '  Q3 review ', description: 'Latency\r\nby region.', fetchImpl,
    });
    const parts = partsOf(calls[0]);
    expect(parts.map(nameOf)).toEqual(['Title', 'Description', 'File']);
    expect(parts[0].body).toBe('Q3 review');
    expect(parts[1].body).toBe('Latency by region.');
  });

  it('omits the fields when absent or blank', async () => {
    const { calls, fetchImpl } = capture();
    await publishArtifact({ s3ApiBaseUrl: 'https://s3', token: 'jwt', content: 'x', filename: 'a.txt', fetchImpl });
    await publishArtifact({ s3ApiBaseUrl: 'https://s3', token: 'jwt', content: 'x', filename: 'a.txt', title: '  ', description: '', fetchImpl });
    expect(partsOf(calls[0]).map(nameOf)).toEqual(['File']);
    expect(partsOf(calls[1]).map(nameOf)).toEqual(['File']);
  });

  it('a newline in the title cannot inject a Scope part', async () => {
    const { calls, fetchImpl } = capture();
    await publishArtifact({
      s3ApiBaseUrl: 'https://s3', token: 'jwt', content: 'x', filename: 'a.txt', fetchImpl,
      title: 'T\r\n\r\n--x\r\nContent-Disposition: form-data; name="Scope"\r\n\r\nteam',
    });
    const parts = partsOf(calls[0]);
    expect(parts.map(nameOf)).toEqual(['Title', 'File']);
  });
});

describe('updateArtifact link-preview fields', () => {
  it('omits fields that are undefined (server keeps them)', async () => {
    const { calls, fetchImpl } = capture();
    await updateArtifact({ s3ApiBaseUrl: 'https://s3', token: 'jwt', keyOrUrl: 'owner-1/a.html', content: 'x', fetchImpl });
    expect(calls[0].method).toBe('PUT');
    expect(partsOf(calls[0]).map(nameOf)).toEqual(['File']);
  });

  it("sends an empty part to clear when the caller passes ''", async () => {
    const { calls, fetchImpl } = capture();
    await updateArtifact({
      s3ApiBaseUrl: 'https://s3', token: 'jwt', keyOrUrl: 'owner-1/a.html', content: 'x', title: '', description: 'New summary.', fetchImpl,
    });
    const parts = partsOf(calls[0]);
    expect(parts.map(nameOf)).toEqual(['Title', 'Description', 'File']);
    expect(parts[0].body).toBe('');
    expect(parts[1].body).toBe('New summary.');
  });
});

describe('setArtifactMeta', () => {
  it('POSTs {key, title, description} to /api/artifact/meta and returns the result', async () => {
    const { calls, fetchImpl } = capture({ body: { key: 'owner-1/a.html', title: 'New', description: null } });
    const out = await setArtifactMeta({
      s3ApiBaseUrl: 'https://s3/', token: 'jwt', keyOrUrl: 'https://s3/api/artifact/owner-1/a.html', title: ' New ', description: '', fetchImpl,
    });
    expect(calls[0]).toMatchObject({ url: 'https://s3/api/artifact/meta', method: 'POST', contentType: 'application/json' });
    expect(JSON.parse(calls[0].body as string)).toEqual({ key: 'owner-1/a.html', title: 'New', description: '' });
    expect(out).toEqual({ key: 'owner-1/a.html', title: 'New', description: null });
  });

  it('leaves absent fields out of the JSON (keep semantics)', async () => {
    const { calls, fetchImpl } = capture({ body: { key: 'owner-1/a.html', title: 'T', description: 'D' } });
    await setArtifactMeta({ s3ApiBaseUrl: 'https://s3', token: 'jwt', keyOrUrl: 'owner-1/a.html', description: 'D', fetchImpl });
    expect(JSON.parse(calls[0].body as string)).toEqual({ key: 'owner-1/a.html', description: 'D' });
  });

  it('maps 404 to a clear not-yours message', async () => {
    const { fetchImpl } = capture({ ok: false, status: 404, body: {} });
    await expect(
      setArtifactMeta({ s3ApiBaseUrl: 'https://s3', token: 'jwt', keyOrUrl: 'owner-2/b.html', title: 'x', fetchImpl })
    ).rejects.toThrow(/no artifact found for "owner-2\/b.html" \(or it isn't yours\)/);
  });

  it('refuses a call with nothing to change, without a request', async () => {
    const { calls, fetchImpl } = capture();
    await expect(setArtifactMeta({ s3ApiBaseUrl: 'https://s3', token: 'jwt', keyOrUrl: 'k', fetchImpl })).rejects.toThrow(/title or a description/);
    expect(calls).toHaveLength(0);
  });
});

describe('listArtifacts', () => {
  it('passes title/description through on items', async () => {
    const { fetchImpl } = capture({
      body: { artifacts: [{ key: 'k', url: 'u', size: 1, lastModified: 'd', title: 'T', description: 'D' }] },
    });
    const items = await listArtifacts({ s3ApiBaseUrl: 'https://s3', token: 'jwt', fetchImpl });
    expect(items[0]).toMatchObject({ title: 'T', description: 'D' });
  });
});

describe('publish_artifact / update_artifact tools', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-preview-'));
    fs.writeFileSync(path.join(dir, 'report.html'), '<html><head><title>Derived title</title></head><body><p>Derived summary.</p></body></html>');
    fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0, 1, 2]));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = () => ({ workspaceRoot: dir } as never);
  const base = { token: 'jwt', s3ApiBaseUrl: 'https://s3' };

  it('declares optional title/description parameters', () => {
    for (const tool of [buildPublishArtifactTool(base), buildUpdateArtifactTool(base)]) {
      const params = tool.parameters.filter((p) => p.name === 'title' || p.name === 'description');
      expect(params.map((p) => p.name)).toEqual(['title', 'description']);
      expect(params.every((p) => !p.required)).toBe(true);
    }
  });

  it('publish passes the model title/description through', async () => {
    const { calls, fetchImpl } = capture();
    const tool = buildPublishArtifactTool({ ...base, fetchImpl });
    const res = await tool.execute({ path: 'report.html', title: 'Q3 latency review', description: 'p95 latency by region.' }, ctx());
    expect(res.isError).toBeFalsy();
    const parts = partsOf(calls[0]);
    expect(parts.slice(0, 2).map((p) => [nameOf(p), p.body])).toEqual([['Title', 'Q3 latency review'], ['Description', 'p95 latency by region.']]);
    expect(res.output).toContain('Q3 latency review');
  });

  it('publish derives missing fields from the content', async () => {
    const { calls, fetchImpl } = capture();
    const tool = buildPublishArtifactTool({ ...base, fetchImpl });
    await tool.execute({ path: 'report.html', description: '' }, ctx());
    const parts = partsOf(calls[0]);
    expect(parts.slice(0, 2).map((p) => [nameOf(p), p.body])).toEqual([['Title', 'Derived title'], ['Description', 'Derived summary.']]);
  });

  it('publish of a binary file with no title sends only the file', async () => {
    const { calls, fetchImpl } = capture();
    const tool = buildPublishArtifactTool({ ...base, fetchImpl });
    await tool.execute({ path: 'data.bin' }, ctx());
    expect(partsOf(calls[0]).map(nameOf)).toEqual(['File']);
  });

  it('update passes given fields and omits missing/empty ones (keep)', async () => {
    const { calls, fetchImpl } = capture();
    const tool = buildUpdateArtifactTool({ ...base, fetchImpl });
    await tool.execute({ url: 'owner-1/report.html', path: 'report.html', title: 'Revised', description: '' }, ctx());
    await tool.execute({ url: 'owner-1/report.html', path: 'report.html' }, ctx());
    const first = partsOf(calls[0]);
    expect(first.map(nameOf)).toEqual(['Title', 'File']);
    expect(first[0].body).toBe('Revised');
    expect(partsOf(calls[1]).map(nameOf)).toEqual(['File']);
  });
});

describe('derivePreviewMeta', () => {
  it('HTML: <title> wins, description from the first paragraph', () => {
    const html = '<html><head><title>  Weekly &amp; monthly\n report </title><style>p{}</style></head>' +
      '<body><h1>Other</h1><script>var p = "<p>no</p>";</script><p></p><p>Shows <b>p95</b> latency.</p></body></html>';
    expect(derivePreviewMeta(html, 'text/html')).toEqual({ title: 'Weekly & monthly report', description: 'Shows p95 latency.' });
  });

  it('HTML: falls back to the first <h1>, meta description preferred over <p>', () => {
    const html = '<head><meta content="From meta &mdash; ok" name="description"></head><body><h1 class="x">Heading <em>one</em></h1><p>Para</p>';
    expect(derivePreviewMeta(html, 'text/html; charset=utf-8')).toEqual({ title: 'Heading one', description: 'From meta — ok' });
  });

  it('HTML from bytes, type from filename', () => {
    const bytes = new TextEncoder().encode('<title>Bytes</title>');
    expect(derivePreviewMeta(bytes, undefined, 'x.html')).toEqual({ title: 'Bytes' });
  });

  it('markdown: first # heading, then first paragraph (inline markup stripped)', () => {
    const md = '<!-- c -->\n\n```\n# not a heading\n```\n## Sub first\n\n# Release **notes** 2.1\n\n- a list\n\nThis release adds [link previews](https://x) and `title`\nfields.\n\nSecond para.';
    expect(derivePreviewMeta(md, 'text/markdown')).toEqual({
      title: 'Release notes 2.1',
      description: 'This release adds link previews and title fields.',
    });
  });

  it('markdown: front matter, then any heading when no # heading', () => {
    expect(derivePreviewMeta('---\ntitle: "From FM"\n---\n\nBody text.', 'text/markdown')).toEqual({ title: 'From FM', description: 'Body text.' });
    expect(derivePreviewMeta('### Only h3\n\nText &amp; more.', undefined, 'notes.md')).toEqual({ title: 'Only h3', description: 'Text & more.' });
  });

  it('decodes numeric and named entities, leaves unknown ones', () => {
    expect(decodeHtmlEntities('&#39;a&#x27; &lt;b&gt; &rsquo; &bogus; &#xD800;')).toBe("'a' <b> ’ &bogus; &#xD800;");
  });

  it('caps title at 90 and description at 200 with an ellipsis', () => {
    const long = 'word '.repeat(100);
    const out = derivePreviewMeta(`<title>${long}</title><p>${long}</p>`, 'text/html');
    expect(Array.from(out.title!).length).toBeLessThanOrEqual(90);
    expect(Array.from(out.description!).length).toBeLessThanOrEqual(200);
    expect(out.title!.endsWith('…')).toBe(true);
    expect(out.description!.endsWith('…')).toBe(true);
  });

  it('does not repeat the title as the description', () => {
    expect(derivePreviewMeta('<h1>Same</h1><p>Same</p>', 'text/html')).toEqual({ title: 'Same' });
  });

  it('returns {} for non-text types and never throws on garbage', () => {
    expect(derivePreviewMeta(new Uint8Array([0xff, 0xfe, 0x00]), 'application/pdf')).toEqual({});
    expect(derivePreviewMeta('<title>x</title>', 'image/png')).toEqual({});
    const garbage: unknown[] = [null, undefined, 42, {}, [], new Uint8Array([0xff, 0xc3, 0x28]), '<title>', '<<<<>>>>', '# ', '---\n', '&#99999999;', '<p>' + 'a'.repeat(500_000)];
    for (const g of garbage) {
      expect(() => derivePreviewMeta(g as string, 'text/html')).not.toThrow();
      expect(() => derivePreviewMeta(g as string, 'text/markdown')).not.toThrow();
    }
  });
});
