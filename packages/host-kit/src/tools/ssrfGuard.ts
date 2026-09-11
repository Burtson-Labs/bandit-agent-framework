/**
 * SSRF guard + pinned-connection fetch for the `web_fetch` tool.
 *
 * This is the difference between "agent can read public docs" and
 * "attacker prompt tricks the agent into hitting
 * http://169.254.169.254/latest/meta-data/ or http://localhost:6443 on
 * the user's box." The guard has to survive the classic filter bypasses,
 * each of which defeated the previous check-then-fetch implementation:
 *
 * 1. DNS rebinding (TOCTOU): the old guard resolved the hostname once
 *    for the check, then `fetch()` resolved it AGAIN for the connection.
 *    A short-TTL attacker domain answers public for the check and
 *    127.0.0.1 for the fetch. Fix: resolve exactly once, vet EVERY
 *    returned A/AAAA record, then pin the connection to the vetted
 *    address via the `lookup` option on http(s).request — the checked
 *    IP is by construction the connected IP. TLS SNI + certificate
 *    validation still run against the hostname, so https keeps working.
 *
 * 2. Open redirects: `redirect: 'follow'` let a public URL 302 to an
 *    internal target without the guard ever seeing it. Fix: manual
 *    redirect handling — every hop re-runs the FULL guard (scheme +
 *    resolution + private-range checks), capped at MAX_REDIRECTS hops,
 *    and non-http(s) targets (file:, data:, ...) are refused.
 *
 * 3. Numeric/alternate IPv4 encodings: `2130706433`, `0x7f000001`,
 *    `0177.0.0.1`, `127.1` are all 127.0.0.1 to inet_aton. WHATWG URL
 *    parsing canonicalizes most of these, but the guard cannot rely on
 *    every caller routing through `new URL()` — normalize them here too.
 *
 * 4. IPv4-mapped IPv6: `[::ffff:127.0.0.1]` is loopback. Worse, the URL
 *    parser canonicalizes it to the pure-hex form `[::ffff:7f00:1]`,
 *    which a dotted-only regex never matches — this was a live bypass.
 *    Fix: parse IPv6 into bytes and classify the embedded IPv4 for the
 *    mapped (::ffff:0:0/96), compatible (::/96), and NAT64
 *    (64:ff9b::/96) prefixes.
 *
 * Set BANDIT_ALLOW_PRIVATE_WEB_FETCH=1 to opt out of the private-range
 * blocking — appropriate when the user intentionally points the agent
 * at internal docs. Resolution + pinning still happen; only the
 * "is this private?" rejection is skipped.
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';

/** Hostname → every resolved A/AAAA record. Injectable for tests. */
export type LookupAllFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export interface TransportResponse {
  status: number;
  statusText: string;
  /** Lower-cased header names (Node's IncomingHttpHeaders shape). */
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A transport that MUST connect to `pinned.address` (never re-resolve
 * `url.hostname`) while preserving the hostname for Host/SNI/cert
 * validation. Injectable for tests.
 */
export type PinnedTransport = (
  url: URL,
  pinned: PinnedAddress,
  opts: { headers: Record<string, string>; deadlineAt: number }
) => Promise<TransportResponse>;

export interface GuardedFetchOptions {
  /** Skip the private-range rejection (BANDIT_ALLOW_PRIVATE_WEB_FETCH=1). */
  allowPrivate?: boolean;
  lookup?: LookupAllFn;
  transport?: PinnedTransport;
  maxRedirects?: number;
  timeoutMs?: number;
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
/** Stop buffering a response beyond this — output is trimmed to 16 KB anyway. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ENV_HINT = 'Set BANDIT_ALLOW_PRIVATE_WEB_FETCH=1 to allow fetches against internal networks.';

const PRIVATE_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/**
 * inet_aton-style normalization: decimal (`2130706433`), hex
 * (`0x7f000001`), octal (`0177.0.0.1`), and dotted-partial (`127.1`)
 * forms all canonicalize to a dotted quad. Returns null when the host
 * is not a numeric IPv4 form (i.e. a real DNS name).
 */
export function normalizeIPv4Numeric(host: string): string | null {
  if (!host || /[^0-9a-fA-Fx.]/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    let v: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) v = parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) v = part.length === 1 ? 0 : parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) v = parseInt(part, 10);
    else return null; // leading-zero decimals ("09") and anything else: not inet_aton
    if (!Number.isFinite(v)) return null;
    values.push(v);
  }
  const last = values[values.length - 1];
  const heads = values.slice(0, -1);
  if (heads.some((v) => v > 255)) return null;
  const tailBytes = 4 - heads.length; // the last value spans the remaining bytes
  if (last < 0 || last >= 256 ** tailBytes) return null;
  const bytes = [...heads];
  for (let i = tailBytes - 1; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes.join('.');
}

/** Valid IPv6 literal → 16 bytes (zone index stripped). Null if not IPv6. */
export function ipv6ToBytes(ip: string): number[] | null {
  const zoneIdx = ip.indexOf('%');
  const bare = zoneIdx === -1 ? ip : ip.slice(0, zoneIdx);
  if (isIP(bare) !== 6) return null;
  let head = bare;
  let tail = '';
  const dc = bare.indexOf('::');
  if (dc !== -1) {
    head = bare.slice(0, dc);
    tail = bare.slice(dc + 2);
  }
  const toGroups = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        // Embedded IPv4 tail (::ffff:1.2.3.4) — expands to two groups.
        const quad = normalizeIPv4Numeric(part);
        if (!quad) return null;
        const b = quad.split('.').map(Number);
        out.push((b[0] << 8) | b[1], (b[2] << 8) | b[3]);
      } else {
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };
  const h = toGroups(head);
  const t = toGroups(tail);
  if (!h || !t) return null;
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (dc === -1 && missing !== 0)) return null;
  const groups = [...h, ...Array<number>(missing).fill(0), ...t];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!Number.isFinite(g) || g < 0 || g > 0xffff) return null;
    bytes.push(g >> 8, g & 0xff);
  }
  return bytes;
}

/**
 * Private/reserved IPv4 check (RFC 6890 flavored). Accepts numeric
 * alternate encodings — they normalize before classification.
 */
export function isPrivateIPv4(ip: string): boolean {
  const canon = normalizeIPv4Numeric(ip);
  if (!canon) return false;
  const [a, b, c] = canon.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + broadcast
  return false;
}

/** Private/reserved IPv6 check over parsed bytes (never trusts regexes). */
export function isPrivateIPv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true; // callers only pass isIP===6 strings; fail closed
  const allZero = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
    return true;
  };
  const embeddedV4 = (): string => `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  if (allZero(0, 16)) return true; // :: unspecified
  if (allZero(0, 15) && bytes[15] === 1) return true; // ::1 loopback
  if (allZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIPv4(embeddedV4()); // ::ffff:0:0/96 IPv4-mapped
  }
  if (allZero(0, 12)) return isPrivateIPv4(embeddedV4()); // ::/96 IPv4-compatible (deprecated)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && allZero(4, 12)) {
    return isPrivateIPv4(embeddedV4()); // 64:ff9b::/96 NAT64
  }
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 doc
  return false;
}

/** Classify a resolved/literal address of either family (zone-id tolerant). */
export function isPrivateAddress(address: string): boolean {
  const zoneIdx = address.indexOf('%');
  const bare = zoneIdx === -1 ? address : address.slice(0, zoneIdx);
  const family = isIP(bare);
  if (family === 4) return isPrivateIPv4(bare);
  if (family === 6) return isPrivateIPv6(address);
  const numeric = normalizeIPv4Numeric(bare);
  if (numeric) return isPrivateIPv4(numeric);
  return false;
}

const defaultLookupAll: LookupAllFn = async (hostname) => {
  // dns.promises.lookup is what fetch/net would consult (honors /etc/hosts,
  // unlike dns.resolve) — vetting anything else would vet the wrong answer.
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return Array.isArray(records) ? records : [records];
};

export type VetOutcome =
  | { kind: 'ok'; pinned: PinnedAddress }
  | { kind: 'blocked'; detail: string }
  | { kind: 'unresolvable'; message: string };

/**
 * Full host vetting: literal-IP classification, numeric-encoding
 * normalization, reserved hostnames, then a single DNS resolution where
 * EVERY returned record must be public. On success returns the address
 * the connection must be pinned to.
 */
export async function vetHost(
  hostname: string,
  opts: { allowPrivate?: boolean; lookup?: LookupAllFn } = {}
): Promise<VetOutcome> {
  // URL.hostname returns IPv6 literals WITH brackets ("[::1]") — strip
  // them so isIP() classifies the address and DNS never sees brackets.
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const lower = stripped.toLowerCase();
  const allowPrivate = opts.allowPrivate === true;
  const lookup = opts.lookup ?? defaultLookupAll;

  const family = isIP(stripped);
  if (family === 4 || family === 6) {
    const priv = family === 4 ? isPrivateIPv4(stripped) : isPrivateIPv6(stripped);
    if (priv && !allowPrivate) return { kind: 'blocked', detail: 'is a private/loopback/link-local address' };
    return { kind: 'ok', pinned: { address: stripped, family } };
  }

  const numeric = normalizeIPv4Numeric(stripped);
  if (numeric) {
    if (isPrivateIPv4(numeric) && !allowPrivate) {
      return { kind: 'blocked', detail: `is a numeric alias for the private address ${numeric}` };
    }
    return { kind: 'ok', pinned: { address: numeric, family: 4 } };
  }

  if (!allowPrivate && (PRIVATE_HOSTNAMES.has(lower) || lower.endsWith('.localhost'))) {
    return { kind: 'blocked', detail: 'resolves to a private/loopback/link-local address' };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(stripped);
  } catch (err) {
    // Can't resolve ⇒ can't connect. Surface as a normal network failure
    // (matches the old flow where fetch reported the DNS error).
    return { kind: 'unresolvable', message: err instanceof Error ? err.message : String(err) };
  }
  const list = (Array.isArray(records) ? records : [records]).filter(
    (r): r is { address: string; family: number } => !!r && typeof r.address === 'string'
  );
  if (list.length === 0) {
    return { kind: 'unresolvable', message: `DNS lookup for ${stripped} returned no addresses` };
  }
  if (!allowPrivate) {
    for (const rec of list) {
      if (isPrivateAddress(rec.address)) {
        return { kind: 'blocked', detail: `resolves to the private/loopback/link-local address ${rec.address}` };
      }
    }
  }
  const first = list[0];
  return { kind: 'ok', pinned: { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 } };
}

/**
 * Back-compat classifier used by tests and hosts: "would the guard block
 * this hostname?" DNS failure is not a security signal (nothing to
 * connect to), so it reports false there — same as the original.
 */
export async function isPrivateHost(hostname: string): Promise<boolean> {
  const vet = await vetHost(hostname);
  return vet.kind === 'blocked';
}

/**
 * Default transport: node http/https with the socket `lookup` overridden
 * to hand back the vetted address — the connection CANNOT go anywhere
 * the guard didn't check, while Host/SNI/cert validation still use the
 * hostname. `agent: false` so no keep-alive socket from an earlier
 * resolution can be reused.
 */
export const pinnedHttpTransport: PinnedTransport = (url, pinned, opts) => {
  return new Promise<TransportResponse>((resolve, reject) => {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new Error('The operation was aborted due to timeout'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const pinnedLookup = ((_hostname: string, lookupOpts: unknown, cb?: unknown): void => {
      const callback = (typeof lookupOpts === 'function' ? lookupOpts : cb) as (
        err: Error | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void;
      const wantAll = typeof lookupOpts === 'object' && lookupOpts !== null && (lookupOpts as { all?: boolean }).all === true;
      if (wantAll) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as unknown as NonNullable<http.RequestOptions['lookup']>;

    let settled = false;
    const req = mod.request(url, { method: 'GET', headers: opts.headers, lookup: pinnedLookup, agent: false }, (res) => {
      const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
      let stream: NodeJS.ReadableStream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'deflate') {
        stream = res.pipe(zlib.createUnzip());
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      // When a decompressor is spliced in, `res` still needs its own error
      // handler — an unhandled 'error' on it would take down the process.
      if (stream !== res) res.on('error', (err: Error) => stream.emit('error', err));
      const chunks: Buffer[] = [];
      let received = 0;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8')
        });
      };
      stream.on('data', (chunk: Buffer) => {
        received += chunk.length;
        chunks.push(chunk);
        if (received > MAX_RESPONSE_BYTES) {
          finish(); // use what we have — output trims to 16 KB anyway
          req.destroy();
        }
      });
      stream.on('end', finish);
      stream.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('The operation was aborted due to timeout'));
    }, remaining);
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    req.end();
  });
};

function headerValue(headers: TransportResponse['headers'], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The full guarded fetch: parse → vet → pinned connect, with manual
 * redirect handling where every hop re-runs the whole guard. Returns the
 * tool-shaped { output, isError } — output format is identical to the
 * pre-hardening tool (HTTP status header line, 16 KB trim, HTML strip).
 */
export async function runGuardedWebFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {}
): Promise<{ output: string; isError: boolean }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { output: `Invalid URL: ${rawUrl}`, isError: true };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { output: `Unsupported protocol: ${url.protocol}`, isError: true };
  }

  const allowPrivate = options.allowPrivate === true;
  const transport = options.transport ?? pinnedHttpTransport;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const deadlineAt = Date.now() + (options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const originalHost = url.host;
  const headers = {
    'User-Agent': 'bandit-cli/0.1',
    Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br'
  };

  let current = url;
  for (let redirects = 0; ; redirects++) {
    // Full guard on EVERY hop — scheme first (a redirect must never
    // downgrade to file:/data:/etc.), then resolution + private checks.
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return {
        output: `Blocked: redirect to unsupported protocol ${current.protocol} — only http/https targets are allowed.`,
        isError: true
      };
    }
    const vet = await vetHost(current.hostname, { allowPrivate, lookup: options.lookup });
    if (vet.kind === 'blocked') {
      const subject = redirects === 0 ? `Blocked: ${current.hostname}` : `Blocked: redirect to ${current.hostname}`;
      return { output: `${subject} ${vet.detail}. ${ENV_HINT}`, isError: true };
    }
    if (vet.kind === 'unresolvable') {
      return { output: `Fetch failed: ${vet.message}`, isError: true };
    }

    let res: TransportResponse;
    try {
      res = await transport(current, vet.pinned, { headers, deadlineAt });
    } catch (err) {
      return { output: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    const location = headerValue(res.headers, 'location');
    if (REDIRECT_STATUSES.has(res.status) && location) {
      if (redirects >= maxRedirects) {
        return { output: `Fetch failed: too many redirects (limit ${maxRedirects}) — last hop ${current.host}`, isError: true };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { output: `Fetch failed: invalid redirect location "${location}" from ${current.host}`, isError: true };
      }
      current = next;
      continue;
    }

    const ct = headerValue(res.headers, 'content-type') ?? '';
    const ok = res.status >= 200 && res.status < 300;
    const body = ct.includes('html') ? stripHtml(res.body) : res.body;
    const trimmed = body.length > 16 * 1024 ? body.slice(0, 16 * 1024) + '\n… (truncated)' : body;
    return {
      output: `HTTP ${res.status} ${res.statusText} • ${originalHost}\nContent-Type: ${ct || '(unknown)'}\n\n${trimmed}`,
      isError: !ok
    };
  }
}
