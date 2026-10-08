/**
 * Egress policy for user-supplied provider endpoints (SSRF). A user's
 * custom Ollama URL is fetched from inside the cluster, so every way to
 * point it at something internal gets a case: private and special ranges,
 * IPv4-mapped/NAT64 spellings, a name that resolves private, a mixed
 * answer, DNS rebinding between the check and the connect, IP literals
 * (which never hit DNS), and redirects.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertPublicEgress,
  checkEgressHost,
  createPublicOnlyFetch,
  isPublicAddress,
  NO_ALLOWANCE,
  parseEgressAllowance,
  type Resolver,
} from '../src/egress';
import { ContractError } from '../src/contract';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

async function localServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const fixed =
  (map: Record<string, string[]>): Resolver =>
  async (host) => {
    const hit = map[host];
    if (!hit) {
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    }
    return hit;
  };

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.43.0.10', // k3s service CIDR
    '10.42.1.7', // k3s pod CIDR
    '172.16.5.4',
    '192.168.1.51', // the Pi cluster master
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1', // mapped loopback in hex form, as WHATWG URL normalises it
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '2002:a9fe:a9fe::1', // 6to4 embedding the metadata address
    'fe80::1%eth0',
    'not-an-ip',
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['1.1.1.1', '34.117.59.81', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe('parseEgressAllowance', () => {
  it('reads CIDRs, single addresses and hostnames', () => {
    const a = parseEgressAllowance('192.168.1.0/24, gpu.lan , 10.0.0.5, fd00::/8');
    expect(a.hostnames.has('gpu.lan')).toBe(true);
    expect(a.cidrs.check('192.168.1.60', 'ipv4')).toBe(true);
    expect(a.cidrs.check('10.0.0.5', 'ipv4')).toBe(true);
    expect(a.cidrs.check('10.0.0.6', 'ipv4')).toBe(false);
  });

  it('refuses a malformed CIDR at startup rather than allowing everything', () => {
    expect(() => parseEgressAllowance('10.0.0.0/99')).toThrow(/not a valid CIDR/);
  });
});

describe('checkEgressHost', () => {
  it('allows a name whose every address is public', async () => {
    const v = await checkEgressHost('ollama.example.com', NO_ALLOWANCE, fixed({ 'ollama.example.com': ['34.1.2.3'] }));
    expect(v.ok).toBe(true);
  });

  it('refuses a name that resolves into the cluster', async () => {
    const v = await checkEgressHost(
      'ollama-k8s.ollama.svc.cluster.local',
      NO_ALLOWANCE,
      fixed({ 'ollama-k8s.ollama.svc.cluster.local': ['10.43.12.9'] }),
    );
    expect(v).toEqual({ ok: false, reason: expect.stringContaining('10.43.12.9') });
  });

  it('refuses a mixed answer — one private address is enough', async () => {
    const v = await checkEgressHost('split.example', NO_ALLOWANCE, fixed({ 'split.example': ['34.1.2.3', '127.0.0.1'] }));
    expect(v.ok).toBe(false);
  });

  it('refuses a name that does not resolve', async () => {
    const v = await checkEgressHost('nope.invalid', NO_ALLOWANCE, fixed({}));
    expect(v.ok).toBe(false);
  });

  it('judges an IP literal without DNS', async () => {
    const neverCalled: Resolver = () => Promise.reject(new Error('resolver must not run'));
    expect((await checkEgressHost('169.254.169.254', NO_ALLOWANCE, neverCalled)).ok).toBe(false);
    expect((await checkEgressHost('[::1]', NO_ALLOWANCE, neverCalled)).ok).toBe(false);
    expect((await checkEgressHost('8.8.8.8', NO_ALLOWANCE, neverCalled)).ok).toBe(true);
  });

  it('lets an operator allowance through, and nothing else', async () => {
    const allowance = parseEgressAllowance('192.168.1.0/24,gpu.lan');
    const resolve = fixed({ 'gpu.lan': ['10.9.9.9'], 'box.lan': ['192.168.1.60'], 'other.lan': ['192.168.2.1'] });
    expect((await checkEgressHost('gpu.lan', allowance, resolve)).ok).toBe(true);
    expect((await checkEgressHost('box.lan', allowance, resolve)).ok).toBe(true);
    expect((await checkEgressHost('other.lan', allowance, resolve)).ok).toBe(false);
  });
});

describe('assertPublicEgress', () => {
  it('ignores operator-configured providers', async () => {
    await expect(
      assertPublicEgress({ kind: 'ollama', baseUrl: 'http://10.43.0.1:11434', model: 'm' }, NO_ALLOWANCE),
    ).resolves.toBeUndefined();
  });

  it('refuses a user endpoint pointing inside, with a reason', async () => {
    const err = await assertPublicEgress(
      { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'm', egress: 'public-only' },
      NO_ALLOWANCE,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).code).toBe('EGRESS_BLOCKED');
  });

  it('refuses credentials embedded in the URL', async () => {
    const err = await assertPublicEgress(
      { kind: 'ollama', baseUrl: 'http://user:pw@8.8.8.8:11434', model: 'm', egress: 'public-only' },
      NO_ALLOWANCE,
    ).catch((e: unknown) => e);
    expect((err as ContractError).code).toBe('EGRESS_BLOCKED');
  });
});

describe('createPublicOnlyFetch (connect-time enforcement)', () => {
  it('refuses an IP-literal private target before any request is made', async () => {
    let hits = 0;
    const port = await localServer((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    const guarded = createPublicOnlyFetch(NO_ALLOWANCE);
    await expect(guarded(`http://127.0.0.1:${port}/api/chat`)).rejects.toThrow(/not a public address/);
    expect(hits).toBe(0);
  });

  it('catches DNS rebinding: public at check time, private at connect time', async () => {
    let hits = 0;
    const port = await localServer((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return calls === 1 ? ['34.1.2.3'] : ['127.0.0.1'];
    };
    // Step 1 (the boundary check) sees a public address…
    expect((await checkEgressHost('rebind.example', NO_ALLOWANCE, rebinding)).ok).toBe(true);
    // …the connection it would actually open does not.
    const guarded = createPublicOnlyFetch(NO_ALLOWANCE, rebinding);
    const err = (await guarded(`http://rebind.example:${port}/api/chat`).catch((e: unknown) => e)) as Error & {
      cause?: Error;
    };
    expect(String(err.cause?.message ?? err.message)).toMatch(/blocked: not a public address/);
    expect(hits).toBe(0);
  });

  it('connects to an allowed target and refuses its redirects', async () => {
    const port = await localServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.end('ok');
    });
    // An operator allowance for loopback, purely so a test server is reachable.
    const allowance = parseEgressAllowance('127.0.0.1/32');
    const guarded = createPublicOnlyFetch(allowance, async () => ['127.0.0.1']);
    const res = await guarded(`http://allowed.test:${port}/ok`);
    expect(await res.text()).toBe('ok');
    const err = (await guarded(`http://allowed.test:${port}/redirect`).catch((e: unknown) => e)) as Error & {
      cause?: Error;
    };
    expect(String(err.cause?.message ?? err.message)).toMatch(/redirect/i);
  });
});
