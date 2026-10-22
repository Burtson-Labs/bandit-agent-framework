/**
 * Click-to-load images: the host fetches the one URL the user clicked through
 * the SSRF guard and returns a data: URI; the webview CSP allows no remote
 * images at all.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PinnedTransport } from '@burtson-labs/host-kit';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') })
  }
}));

import { fetchRemoteImageAsDataUri } from '../../src/helpers/remoteImage';
import { buildWebviewHtml } from '../../src/helpers/webviewHtml';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const transport = (status: number, type: string, seen: string[] = [], location?: string): PinnedTransport =>
  async (url) => {
    seen.push(url.href);
    return { status, statusText: '', headers: { 'content-type': type, ...(location ? { location } : {}) }, body: png.toString('base64'), bytes: png.length };
  };

describe('fetchRemoteImageAsDataUri', () => {
  it('returns a data: URI for a public image', async () => {
    const r = await fetchRemoteImageAsDataUri('https://img.example/a.png', { lookup: publicLookup, transport: transport(200, 'image/png') });
    expect(r).toEqual({ ok: true, dataUri: `data:image/png;base64,${png.toString('base64')}` });
  });

  it('refuses private, loopback and link-local targets without connecting', async () => {
    for (const url of ['http://127.0.0.1:11555/probe.png?leak=x', 'http://192.168.1.2/a.png', 'http://169.254.169.254/x']) {
      const seen: string[] = [];
      const r = await fetchRemoteImageAsDataUri(url, { allowPrivate: false, lookup: publicLookup, transport: transport(200, 'image/png', seen) });
      expect(r.ok, url).toBe(false);
      expect(seen, url).toEqual([]);
    }
  });

  it('re-checks redirects', async () => {
    const r = await fetchRemoteImageAsDataUri('https://img.example/a.png', {
      allowPrivate: false, lookup: publicLookup, transport: transport(302, 'text/html', [], 'http://10.0.0.1/a.png')
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/Blocked: redirect/);
  });

  it('refuses SVG and non-images', async () => {
    expect((await fetchRemoteImageAsDataUri('https://img.example/a.svg', { lookup: publicLookup, transport: transport(200, 'image/svg+xml') })).ok).toBe(false);
    expect((await fetchRemoteImageAsDataUri('https://img.example/a', { lookup: publicLookup, transport: transport(200, 'text/html') })).ok).toBe(false);
  });

  it('makes no request in offline mode', async () => {
    const seen: string[] = [];
    const r = await fetchRemoteImageAsDataUri('https://img.example/a.png', { offline: true, offlineReason: 'offline', lookup: publicLookup, transport: transport(200, 'image/png', seen) });
    expect(r).toEqual({ ok: false, error: 'offline' });
    expect(seen).toEqual([]);
  });
});

describe('webview CSP', () => {
  it('allows images only from the extension and data: URIs', () => {
    const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u: { fsPath: string }) => ({ with: () => u.fsPath, toString: () => u.fsPath }) };
    const html = buildWebviewHtml({ webview: webview as never, extensionUri: { fsPath: '/ext' } as never, packageVersion: '1' });
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const img = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src'));
    expect(img).toBe('img-src vscode-resource: data:');
    expect(csp).not.toMatch(/https:/);
  });
});
