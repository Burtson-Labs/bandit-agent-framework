/**
 * Egress policy for user-supplied provider endpoints (SEC-002, SSRF).
 *
 * A provider marked `egress: 'public-only'` points at a URL a USER typed
 * (the web Providers tab's custom Ollama URL). The runner sits inside the
 * cluster, next to things a user must never be able to make it talk to:
 * pod and service networks, the node, loopback (the gateway's own
 * container shares this network namespace), and cloud metadata endpoints.
 *
 * Two layers, both needed:
 *
 *  1. `assertPublicEgress` — at the HTTP boundary, before a turn starts:
 *     resolve the host and refuse unless every address is public. This is
 *     what produces a clear 400 for the caller.
 *  2. `createPublicOnlyFetch` — the fetch the provider actually uses. Its
 *     connector re-checks the address it is about to CONNECT to, in the
 *     DNS lookup undici performs for that connection. A name that resolved
 *     public at step 1 and private a second later (DNS rebinding) is caught
 *     here; step 1 alone would have a time-of-check/time-of-use gap.
 *     Redirects are refused outright — a public host answering 302 to
 *     169.254.169.254 is the oldest trick there is.
 *
 * Operators can let specific private targets through with
 * `AGENT_RUNNER_EGRESS_ALLOW_PRIVATE`: comma-separated CIDRs (an address in
 * one is allowed) and hostnames (that name is trusted, whatever it
 * resolves to). Nothing is allowed by default.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ContractError, type TurnProvider } from './contract.js';

/** Parsed `AGENT_RUNNER_EGRESS_ALLOW_PRIVATE`. */
export interface EgressAllowance {
  hostnames: Set<string>;
  cidrs: BlockList;
  /** True when at least one CIDR was configured. */
  hasCidrs: boolean;
}

export function parseEgressAllowance(raw: string | undefined): EgressAllowance {
  const hostnames = new Set<string>();
  const cidrs = new BlockList();
  let hasCidrs = false;
  for (const entry of (raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    const slash = entry.indexOf('/');
    if (slash > 0) {
      const net = entry.slice(0, slash).replace(/^\[|\]$/g, '');
      const prefix = Number(entry.slice(slash + 1));
      const family = isIP(net);
      if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
        throw new Error(`AGENT_RUNNER_EGRESS_ALLOW_PRIVATE: '${entry}' is not a valid CIDR`);
      }
      cidrs.addSubnet(net, prefix, family === 4 ? 'ipv4' : 'ipv6');
      hasCidrs = true;
    } else if (isIP(entry.replace(/^\[|\]$/g, ''))) {
      const ip = entry.replace(/^\[|\]$/g, '');
      const family = isIP(ip);
      cidrs.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
      hasCidrs = true;
    } else {
      hostnames.add(entry);
    }
  }
  return { hostnames, cidrs, hasCidrs };
}

export const NO_ALLOWANCE: EgressAllowance = parseEgressAllowance(undefined);

/**
 * Every range that is not ordinary public unicast. Deliberately broad:
 * a user's Ollama endpoint is a public host; anything else needs the
 * operator's explicit allowance.
 */
const NON_PUBLIC = (() => {
  const b = new BlockList();
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // carrier-grade NAT (also common for cluster pod nets)
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local — includes 169.254.169.254 metadata
    ['172.16.0.0', 12], // private
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // 6to4 relay anycast
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved + broadcast
  ];
  for (const [net, prefix] of v4) {b.addSubnet(net, prefix, 'ipv4');}
  const v6: Array<[string, number]> = [
    ['::', 128], // unspecified
    ['::1', 128], // loopback
    // IPv4-mapped (::ffff:0:0/96) is NOT listed: BlockList matches every
    // IPv4 address against it. canonicalIp unwraps mapped addresses and
    // they are judged as the IPv4 they carry.
    ['64:ff9b::', 96], // NAT64 — can reach any v4, including private
    ['64:ff9b:1::', 48], // local-use NAT64
    ['100::', 64], // discard
    ['2001::', 32], // Teredo
    ['2001:db8::', 32], // documentation
    ['2002::', 16], // 6to4 — embeds an arbitrary v4
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
  ];
  for (const [net, prefix] of v6) {b.addSubnet(net, prefix, 'ipv6');}
  return b;
})();

/** Strip brackets and an IPv6 zone id; unwrap IPv4-mapped IPv6. */
function canonicalIp(raw: string): { ip: string; family: 4 | 6 } | null {
  let ip = raw.trim().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) {ip = ip.slice(0, zone);}
  const family = isIP(ip);
  if (family === 0) {return null;}
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) {
      return { ip: mapped[1], family: 4 };
    }
    // The hex spelling WHATWG URL normalises to: [::ffff:7f00:1].
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return { ip: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 4 };
    }
  }
  return { ip, family: family as 4 | 6 };
}

/** Whether an address is ordinary public unicast. Non-IPs are not. */
export function isPublicAddress(raw: string): boolean {
  const c = canonicalIp(raw);
  if (!c) {return false;}
  return !NON_PUBLIC.check(c.ip, c.family === 4 ? 'ipv4' : 'ipv6');
}

function addressAllowed(raw: string, allowance: EgressAllowance): boolean {
  if (isPublicAddress(raw)) {return true;}
  const c = canonicalIp(raw);
  if (!c || !allowance.hasCidrs) {return false;}
  return allowance.cidrs.check(c.ip, c.family === 4 ? 'ipv4' : 'ipv6');
}

const normalizeHost = (hostname: string): string =>
  hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {reject(err);}
      else {resolve((addresses as LookupAddress[]).map((a) => a.address));}
    });
  });

/**
 * The verdict for one host: allowed, or the reason it is not. An IP
 * literal is judged directly; a name is resolved and EVERY address must be
 * allowed — one private answer among public ones is how split-horizon and
 * rebinding attacks get in.
 */
export async function checkEgressHost(
  hostname: string,
  allowance: EgressAllowance,
  resolve: Resolver = systemResolver,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = normalizeHost(hostname);
  if (!host) {return { ok: false, reason: 'empty host' };}
  if (allowance.hostnames.has(host)) {return { ok: true };}

  if (isIP(canonicalIp(host)?.ip ?? '')) {
    return addressAllowed(host, allowance)
      ? { ok: true }
      : { ok: false, reason: `${host} is not a public address` };
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `${host} did not resolve (${err instanceof Error ? err.message : String(err)})` };
  }
  if (addresses.length === 0) {return { ok: false, reason: `${host} did not resolve` };}
  const blocked = addresses.find((a) => !addressAllowed(a, allowance));
  return blocked
    ? { ok: false, reason: `${host} resolves to ${blocked}, which is not a public address` }
    : { ok: true };
}

/**
 * HTTP-boundary check for a provider whose endpoint a user chose. Throws a
 * `ContractError` (400) with a reason the gateway can show; providers
 * without `egress: 'public-only'` are operator-configured and pass.
 */
export async function assertPublicEgress(
  provider: TurnProvider,
  allowance: EgressAllowance,
  resolve?: Resolver,
): Promise<void> {
  if (provider.kind === 'deterministic' || provider.egress !== 'public-only') {return;}
  const url = new URL(provider.baseUrl);
  if (url.username || url.password) {
    throw new ContractError('EGRESS_BLOCKED', 'provider.baseUrl must not carry credentials');
  }
  const verdict = await checkEgressHost(url.hostname, allowance, resolve);
  if (!verdict.ok) {
    throw new ContractError('EGRESS_BLOCKED', `provider endpoint refused: ${verdict.reason}`);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for the connector: resolves exactly as Node would, then
 * refuses the connection unless every address is allowed. Exported for
 * tests.
 */
export function guardedLookup(allowance: EgressAllowance, resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean } | undefined, callback: LookupCallback): void => {
    const host = normalizeHost(hostname);
    const trusted = allowance.hostnames.has(host);
    resolve(host)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`${host} did not resolve`), { code: 'ENOTFOUND' }), '');
          return;
        }
        const blocked = trusted ? undefined : addresses.find((a) => !addressAllowed(a, allowance));
        if (blocked) {
          callback(
            Object.assign(new EgressBlockedError(`egress to ${host} (${blocked}) blocked: not a public address`), {
              errno: undefined,
            }) as NodeJS.ErrnoException,
            '',
          );
          return;
        }
        const entries: LookupAddress[] = addresses.map((address) => ({
          address,
          family: isIP(address) === 6 ? 6 : 4,
        }));
        if (options?.all) {callback(null, entries);}
        else {callback(null, entries[0].address, entries[0].family);}
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, ''));
  };
}

/**
 * The fetch a `public-only` provider uses. IP-literal hosts never reach a
 * DNS lookup, so they are checked here per request; names are checked by
 * the connector's lookup at connect time. Redirects are an error.
 */
export function createPublicOnlyFetch(allowance: EgressAllowance, resolve?: Resolver): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowance, resolve) } });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const host = normalizeHost(url.hostname);
    if (!allowance.hostnames.has(host) && isIP(canonicalIp(host)?.ip ?? '') && !addressAllowed(host, allowance)) {
      throw new EgressBlockedError(`egress to ${host} blocked: not a public address`);
    }
    return undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: 'error',
      dispatcher,
    }) as unknown as Response;
  }) as typeof fetch;
}
