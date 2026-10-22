/**
 * Fetch one remote image the user clicked in the chat (click-to-load) and
 * return it as a `data:image/…` URI for the webview, whose CSP allows no
 * remote images.
 *
 * Goes through host-kit's guardedGet, the same SSRF guard as web_fetch:
 * private, loopback and link-local targets are refused (unless
 * BANDIT_ALLOW_PRIVATE_WEB_FETCH=1), the connection is pinned to the vetted
 * address, and every redirect is re-checked. The transport here differs from
 * host-kit's default only in keeping the body as bytes (an image is binary).
 * Refused in offline mode.
 */
import * as http from 'http';
import * as https from 'https';
import { guardedGet, type LookupAllFn, type PinnedTransport } from '@burtson-labs/host-kit';

export const MAX_REMOTE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Pinned http(s) GET that returns the body base64-encoded in `body`. */
export const pinnedBinaryTransport: PinnedTransport = (url, pinned, opts) =>
  new Promise((resolve, reject) => {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new Error('The operation was aborted due to timeout'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const lookup = ((_host: string, lookupOpts: unknown, cb?: unknown): void => {
      const callback = (typeof lookupOpts === 'function' ? lookupOpts : cb) as (
        err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number
      ) => void;
      const all = typeof lookupOpts === 'object' && lookupOpts !== null && (lookupOpts as { all?: boolean }).all === true;
      if (all) {callback(null, [{ address: pinned.address, family: pinned.family }]);}
      else {callback(null, pinned.address, pinned.family);}
    }) as unknown as NonNullable<http.RequestOptions['lookup']>;
    let settled = false;
    const req = mod.request(url, { method: 'GET', headers: opts.headers, lookup, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_REMOTE_IMAGE_BYTES) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`image is larger than ${MAX_REMOTE_IMAGE_BYTES / (1024 * 1024)} MB`));
          }
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks).toString('base64'),
          bytes: received
        });
      });
      res.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('The operation was aborted due to timeout')), remaining);
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    req.end();
  });

export interface RemoteImageOptions {
  offline?: boolean;
  offlineReason?: string;
  allowPrivate?: boolean;
  lookup?: LookupAllFn;
  /** Must return the body base64-encoded, like pinnedBinaryTransport. */
  transport?: PinnedTransport;
  timeoutMs?: number;
}

export type RemoteImageResult = { ok: true; dataUri: string } | { ok: false; error: string };

const ALLOWED_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;

export async function fetchRemoteImageAsDataUri(rawUrl: string, opts: RemoteImageOptions = {}): Promise<RemoteImageResult> {
  if (opts.offline) {return { ok: false, error: opts.offlineReason ?? 'offline mode is on' };}
  if (!/^https?:\/\//i.test(rawUrl)) {return { ok: false, error: 'only http(s) image URLs can be loaded' };}
  const got = await guardedGet(rawUrl, {
    allowPrivate: opts.allowPrivate ?? process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH === '1',
    lookup: opts.lookup,
    transport: opts.transport ?? pinnedBinaryTransport,
    timeoutMs: opts.timeoutMs ?? 15_000,
    headers: { 'User-Agent': 'bandit-stealth', Accept: 'image/*' }
  });
  if (!got.ok) {return { ok: false, error: got.output };}
  const res = got.response;
  if (res.status < 200 || res.status >= 300) {return { ok: false, error: `HTTP ${res.status}` };}
  const header = res.headers['content-type'];
  const type = String(Array.isArray(header) ? header[0] : header ?? '').split(';')[0].trim().toLowerCase();
  // SVG is excluded: it is a document that can carry its own references.
  if (!ALLOWED_TYPES.test(type)) {return { ok: false, error: `not a supported image (${type || 'unknown type'})` };}
  if ((res.bytes ?? 0) > MAX_REMOTE_IMAGE_BYTES) {return { ok: false, error: 'image is larger than 4 MB' };}
  return { ok: true, dataUri: `data:${type};base64,${res.body}` };
}
