/**
 * Contract tests for extraTools — TodoStore + todo_write, remember,
 * web_fetch, web_search.
 *
 * Why pin: these are the four agent-facing tools the host layer adds
 * on top of agent-core's filesystem primitives. Each has a long bug
 * tail worth keeping pinned:
 *   - TodoStore:  status normalization (small models emit "complete"
 *                 / "in-progress" / "completed"); JSON-array-of-bare-
 *                 strings fallback (Qwen 2.5 Coder shipped that on a
 *                 real S3Api turn 2026-04-22).
 *   - remember:   round-trips through appendMemory; never edits
 *                 CLAUDE.md — that's a memory-module test but worth
 *                 pinning at the tool surface too.
 *   - web_fetch:  protocol allowlist (no file://, no ftp://), HTML
 *                 strip, 16 KB truncation, AbortSignal timeout.
 *   - web_search: clear "not configured" error when TAVILY_API_KEY is
 *                 unset (the model needs a usable signal so it falls
 *                 back to web_fetch instead of hallucinating).
 *
 * Network calls are stubbed via globalThis.fetch so the suite stays
 * hermetic. File system tests use a tmp workspace per case.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as dnsMod from 'node:dns';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TodoStore,
  buildTodoWriteTool,
  buildRememberTool,
  buildWebFetchTool,
  buildWebSearchTool,
  isPrivateHost
} from '../src/tools/extraTools';
import {
  normalizeIPv4Numeric,
  pinnedHttpTransport,
  type LookupAllFn,
  type PinnedAddress,
  type PinnedTransport,
  type TransportResponse
} from '../src/tools/ssrfGuard';
import { testCtx } from './_helpers';

/** One scripted hop of the pinned transport. */
interface HopSpec {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface TransportCall {
  url: string;
  pinned: PinnedAddress;
}

/**
 * A stand-in for the pinned-socket transport. Records the URL and the
 * address the guard pinned for every hop, so tests can assert "the
 * connection went to the IP we vetted" and "the redirect target was
 * re-vetted" without touching the network.
 */
function makeTransport(
  script: HopSpec[] | ((call: number) => HopSpec)
): { transport: PinnedTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  const transport: PinnedTransport = async (url, pinned) => {
    const index = calls.length;
    calls.push({ url: url.toString(), pinned });
    const hop = typeof script === 'function' ? script(index) : script[index];
    if (!hop) throw new Error(`transport called ${index + 1}x but only ${(script as HopSpec[]).length} hops scripted`);
    const res: TransportResponse = {
      status: hop.status ?? 200,
      statusText: hop.statusText ?? (hop.status === undefined || hop.status === 200 ? 'OK' : ''),
      headers: { 'content-type': 'text/plain', ...(hop.headers ?? {}) },
      body: hop.body ?? ''
    };
    return res;
  };
  return { transport, calls };
}

/** Every hostname resolves to one public address. */
function publicLookup(address = '93.184.215.14'): LookupAllFn {
  return async () => [{ address, family: 4 }];
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-extratools-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('TodoStore', () => {
  it('starts empty and renders "(no todos)"', () => {
    const s = new TodoStore();
    expect(s.snapshot()).toEqual([]);
    expect(s.render()).toBe('(no todos)');
    expect(s.summary()).toBe('');
  });

  it('replaces the list when given a JSON array of {content, status}', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify([
      { content: 'Read file', status: 'done' },
      { content: 'Edit file', status: 'in_progress' },
      { content: 'Verify', status: 'pending' }
    ]));
    const items = s.snapshot();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: 1, status: 'done', content: 'Read file' });
    expect(items[1]).toMatchObject({ id: 2, status: 'in_progress', content: 'Edit file' });
    expect(items[2]).toMatchObject({ id: 3, status: 'pending', content: 'Verify' });
  });

  it('treats a JSON array of bare strings as pending todos (small-model fallback)', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify(['Read X', 'Edit Y']));
    const items = s.snapshot();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 1, status: 'pending', content: 'Read X' });
    expect(items[1]).toMatchObject({ id: 2, status: 'pending', content: 'Edit Y' });
  });

  it('recovers when array entries are JSON-shaped strings (parser stringified each object)', () => {
    // Mark 2026-05-26 trace: the Plan disclosure rendered raw JSON
    // like `○ {"content":"Install TypeScript", "status":"done"}` because
    // each todo arrived as a stringified object and the bare-string
    // fallback dumped the whole JSON into the content field.
    const s = new TodoStore();
    const stringifiedEntries = [
      JSON.stringify({ content: 'Install TypeScript', status: 'done' }),
      JSON.stringify({ content: 'Update vite.config.js', status: 'in_progress' }),
      JSON.stringify({ content: 'Convert components', status: 'pending' }),
    ];
    s.upsert(JSON.stringify(stringifiedEntries));
    const items = s.snapshot();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ status: 'done', content: 'Install TypeScript' });
    expect(items[1]).toMatchObject({ status: 'in_progress', content: 'Update vite.config.js' });
    expect(items[2]).toMatchObject({ status: 'pending', content: 'Convert components' });
  });

  it('appends a single {content, status} object', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify({ content: 'first' }));
    s.upsert(JSON.stringify({ content: 'second', status: 'in_progress' }));
    const items = s.snapshot();
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ status: 'in_progress', content: 'second' });
  });

  it('treats unparseable text as a plain-text append', () => {
    const s = new TodoStore();
    s.upsert('not json — just text');
    expect(s.snapshot()).toHaveLength(1);
    expect(s.snapshot()[0].content).toBe('not json — just text');
    expect(s.snapshot()[0].status).toBe('pending');
  });

  it('normalizes alternative status vocab ("complete" / "completed" / "in-progress" / "active")', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify([
      { content: 'a', status: 'complete' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'finished' },
      { content: 'd', status: 'in-progress' },
      { content: 'e', status: 'inprogress' },
      { content: 'f', status: 'active' },
      { content: 'g', status: 'working' },
      { content: 'h', status: 'running' },
      { content: 'i', status: 'whatever' }
    ]));
    const items = s.snapshot();
    expect(items.slice(0, 3).every(i => i.status === 'done')).toBe(true);
    expect(items.slice(3, 8).every(i => i.status === 'in_progress')).toBe(true);
    // Unknown status falls back to pending so the UI tick is consistent.
    expect(items[8].status).toBe('pending');
  });

  it('renders [x] / [~] / [ ] markers in line order', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify([
      { content: 'one', status: 'done' },
      { content: 'two', status: 'in_progress' },
      { content: 'three', status: 'pending' }
    ]));
    const lines = s.render().split('\n');
    expect(lines[0]).toBe('[x] 1. one');
    expect(lines[1]).toBe('[~] 2. two');
    expect(lines[2]).toBe('[ ] 3. three');
  });

  it('summary() nudges the model to keep going while items are pending', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify([
      { content: 'one', status: 'done' },
      { content: 'two', status: 'pending' }
    ]));
    const summary = s.summary();
    expect(summary).toContain('1 of 2 complete');
    expect(summary).toContain('next:');
    expect(summary).toMatch(/Continue the task/);
  });

  it('summary() flips to a verification reminder when everything is done', () => {
    const s = new TodoStore();
    s.upsert(JSON.stringify([
      { content: 'one', status: 'done' },
      { content: 'two', status: 'done' }
    ]));
    const summary = s.summary();
    expect(summary).toContain('2 of 2 complete');
    expect(summary).toMatch(/verify the work is actually complete/i);
  });
});

describe('buildTodoWriteTool', () => {
  it('exposes name="todo_write" and a required items parameter', () => {
    const tool = buildTodoWriteTool(new TodoStore());
    expect(tool.name).toBe('todo_write');
    const items = tool.parameters.find(p => p.name === 'items');
    expect(items?.required).toBe(true);
  });

  it('updates the underlying store and returns header + render + summary', async () => {
    const store = new TodoStore();
    const tool = buildTodoWriteTool(store);
    const result = await tool.execute(
      { items: JSON.stringify([{ content: 'Step 1', status: 'pending' }]) },
      testCtx
    );
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/Todo list updated/);
    expect(result.output).toContain('[ ] 1. Step 1');
    expect(result.output).toMatch(/Continue the task/);
    expect(store.snapshot()).toHaveLength(1);
  });
});

describe('buildRememberTool', () => {
  it('returns an error when fact is empty', async () => {
    const tool = buildRememberTool();
    const r = await tool.execute(
      { fact: '   ' },
      { ...testCtx, workspaceRoot: tmpRoot }
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/non-empty string/);
  });

  it('writes the fact through appendMemory and reports the destination', async () => {
    const tool = buildRememberTool();
    const r = await tool.execute(
      { fact: 'prefer pnpm' },
      { ...testCtx, workspaceRoot: tmpRoot }
    );
    expect(r.isError).toBeFalsy();
    expect(r.output).toMatch(/Saved to project memory/);
    const banditMd = path.join(tmpRoot, 'BANDIT.md');
    expect(fs.existsSync(banditMd)).toBe(true);
    expect(fs.readFileSync(banditMd, 'utf-8')).toMatch(/- prefer pnpm/);
  });

  it('reports "Could not write" when appendMemory throws (read-only fs etc.)', async () => {
    const tool = buildRememberTool();
    // Pass a path inside a non-writable parent. We simulate by pointing
    // workspaceRoot at a file (not a directory) so mkdir/write fails.
    const fileAsRoot = path.join(tmpRoot, 'a-file');
    fs.writeFileSync(fileAsRoot, '');
    const r = await tool.execute(
      { fact: 'oops' },
      { ...testCtx, workspaceRoot: fileAsRoot }
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Could not write to BANDIT\.md/);
  });
});

describe('buildWebFetchTool', () => {
  // The guard resolves DNS and connects through a pinned transport. Both
  // are injected here so the public-flow tests stay hermetic — the
  // dedicated SSRF describe block below exercises the guard itself.
  const lookup = publicLookup();

  it('exposes name="web_fetch" with a required url parameter', () => {
    const tool = buildWebFetchTool();
    expect(tool.name).toBe('web_fetch');
    expect(tool.parameters.find(p => p.name === 'url')?.required).toBe(true);
  });

  it('returns an error when url is missing', async () => {
    const tool = buildWebFetchTool();
    const r = await tool.execute({}, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Missing url/);
  });

  it('rejects malformed URLs', async () => {
    const tool = buildWebFetchTool();
    const r = await tool.execute({ url: 'not a url' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Invalid URL/);
  });

  it('rejects non-http(s) protocols (no file://, no ftp://)', async () => {
    const tool = buildWebFetchTool();
    const r = await tool.execute({ url: 'file:///etc/passwd' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Unsupported protocol/);
  });

  it('returns the fetched body with HTTP status header on success', async () => {
    const { transport } = makeTransport([{ status: 200, body: 'plain text content here' }]);
    const tool = buildWebFetchTool({ lookup, transport });
    const r = await tool.execute({ url: 'https://example.com/x' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/HTTP 200 OK/);
    expect(r.output).toContain('plain text content here');
    expect(r.output).toContain('example.com');
  });

  it('strips HTML tags when content-type indicates HTML', async () => {
    const { transport } = makeTransport([
      {
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html><head><script>alert(1)</script><style>x{}</style></head><body><p>Hello <b>world</b></p></body></html>'
      }
    ]);
    const tool = buildWebFetchTool({ lookup, transport });
    const r = await tool.execute({ url: 'https://example.com/' }, testCtx);
    expect(r.output).toContain('Hello world');
    // Script + style content removed.
    expect(r.output).not.toContain('alert(1)');
    expect(r.output).not.toContain('x{}');
    // Tags themselves stripped.
    expect(r.output).not.toMatch(/<\/?p>/);
  });

  it('truncates bodies larger than 16 KB and marks them with an ellipsis', async () => {
    const { transport } = makeTransport([{ body: 'A'.repeat(20 * 1024) }]);
    const tool = buildWebFetchTool({ lookup, transport });
    const r = await tool.execute({ url: 'https://example.com/big' }, testCtx);
    expect(r.output).toMatch(/… \(truncated\)/);
  });

  it('flags non-2xx responses with isError=true so the model knows the call failed', async () => {
    const { transport } = makeTransport([{ status: 404, statusText: 'Not Found', body: 'not found' }]);
    const tool = buildWebFetchTool({ lookup, transport });
    const r = await tool.execute({ url: 'https://example.com/missing' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/HTTP 404 Not Found/);
  });

  it('returns isError when the transport throws (network failure / abort)', async () => {
    const transport: PinnedTransport = async () => { throw new Error('ECONNREFUSED'); };
    const tool = buildWebFetchTool({ lookup, transport });
    const r = await tool.execute({ url: 'https://example.com/down' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Fetch failed: ECONNREFUSED/);
  });

  it('surfaces a DNS failure as a normal fetch error, not a security block', async () => {
    const failing: LookupAllFn = async () => { throw new Error('getaddrinfo ENOTFOUND nope.example'); };
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ lookup: failing, transport });
    const r = await tool.execute({ url: 'https://nope.example/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Fetch failed: getaddrinfo ENOTFOUND/);
    expect(r.output).not.toMatch(/Blocked/);
    expect(calls).toHaveLength(0);
  });
});

describe('buildWebFetchTool SSRF guard', () => {
  // Each test sets its own DNS mock; clear the env override between tests
  // so a stray BANDIT_ALLOW_PRIVATE_WEB_FETCH=1 in the runner env doesn't
  // silently disable the guard.
  const ORIGINAL_OVERRIDE = process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH;
  beforeEach(() => { delete process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH; });
  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) delete process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH;
    else process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH = ORIGINAL_OVERRIDE;
  });

  it('blocks hostname literal "localhost" without resolving DNS', async () => {
    const lookupSpy = vi.spyOn(dnsMod.promises, 'lookup');
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'http://localhost:6443/api' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Blocked: localhost/);
    expect(calls).toHaveLength(0);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('blocks direct IPv4 loopback (127.0.0.1) without DNS', async () => {
    const lookupSpy = vi.spyOn(dnsMod.promises, 'lookup');
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'http://127.0.0.1:8080/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/127\.0\.0\.1.*private/);
    expect(calls).toHaveLength(0);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata link-local address 169.254.169.254', async () => {
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/169\.254\.169\.254/);
    expect(calls).toHaveLength(0);
  });

  it('blocks IPv6 loopback [::1]', async () => {
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'http://[::1]:9000/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Blocked/);
    expect(calls).toHaveLength(0);
  });

  it('blocks a public hostname that resolves to a private IP (DNS rebinding shape)', async () => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue(
      [{ address: '10.0.0.5', family: 4 }] as unknown as dnsMod.LookupAddress
    );
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'https://internal.example.com/admin' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/internal\.example\.com.*private/);
    expect(calls).toHaveLength(0);
  });

  it('blocks when the hostname resolves to multiple IPs and ANY of them is private', async () => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.10', family: 4 }
    ] as unknown as dnsMod.LookupAddress);
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'https://mixed.example.com/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('allows fetch when hostname resolves to a public IP', async () => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue(
      [{ address: '93.184.215.14', family: 4 }] as unknown as dnsMod.LookupAddress
    );
    const { transport, calls } = makeTransport([{ status: 200, body: 'ok' }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'https://example.com/' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/HTTP 200 OK/);
    expect(calls).toHaveLength(1);
    expect(calls[0].pinned.address).toBe('93.184.215.14');
  });

  it('allows fetch to private addresses when BANDIT_ALLOW_PRIVATE_WEB_FETCH=1', async () => {
    process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH = '1';
    const { transport, calls } = makeTransport([{ status: 200, body: 'internal' }]);
    const tool = buildWebFetchTool({ transport });
    const r = await tool.execute({ url: 'http://10.0.0.5/docs' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain('internal');
    expect(calls[0].pinned.address).toBe('10.0.0.5');
  });

  describe('numeric / alternate IPv4 encodings (SEC-004 class)', () => {
    it('blocks decimal-encoded loopback (http://2130706433/)', async () => {
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      const r = await tool.execute({ url: 'http://2130706433/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: 127\.0\.0\.1.*private/);
      expect(calls).toHaveLength(0);
    });

    it('blocks octal-encoded loopback (http://0177.0.0.1/)', async () => {
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      const r = await tool.execute({ url: 'http://0177.0.0.1/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: 127\.0\.0\.1.*private/);
      expect(calls).toHaveLength(0);
    });

    it('blocks hex-encoded loopback (http://0x7f000001/)', async () => {
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      const r = await tool.execute({ url: 'http://0x7f000001/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: 127\.0\.0\.1.*private/);
      expect(calls).toHaveLength(0);
    });

    it('blocks dotted-partial loopback (http://127.1/)', async () => {
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      const r = await tool.execute({ url: 'http://127.1/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: 127\.0\.0\.1.*private/);
      expect(calls).toHaveLength(0);
    });

    it('blocks hex-encoded cloud metadata (http://0xA9FEA9FE/)', async () => {
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      const r = await tool.execute({ url: 'http://0xA9FEA9FE/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/169\.254\.169\.254/);
      expect(calls).toHaveLength(0);
    });

    it('blocks IPv4-mapped IPv6 loopback, including the canonical hex form the URL parser emits', async () => {
      // new URL('http://[::ffff:127.0.0.1]/') canonicalizes the hostname to
      // [::ffff:7f00:1] — the pure-hex mapped form that defeated the old
      // dotted-only regex. Both spellings must be blocked.
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/']) {
        const r = await tool.execute({ url }, testCtx);
        expect(r.isError, `expected ${url} to be blocked`).toBe(true);
        expect(r.output).toMatch(/Blocked: \[::ffff:7f00:1\]/);
      }
      expect(calls).toHaveLength(0);
    });

    it('blocks IPv4-mapped IPv6 cloud metadata ([::ffff:169.254.169.254])', async () => {
      const { transport, calls } = makeTransport([{ status: 200 }]);
      const tool = buildWebFetchTool({ transport });
      const r = await tool.execute({ url: 'http://[::ffff:169.254.169.254]/latest/meta-data/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked/);
      expect(calls).toHaveLength(0);
    });

    it('normalizeIPv4Numeric canonicalizes every inet_aton form and rejects non-numeric hosts', () => {
      expect(normalizeIPv4Numeric('2130706433')).toBe('127.0.0.1');
      expect(normalizeIPv4Numeric('0x7f000001')).toBe('127.0.0.1');
      expect(normalizeIPv4Numeric('0177.0.0.1')).toBe('127.0.0.1');
      expect(normalizeIPv4Numeric('127.1')).toBe('127.0.0.1');
      expect(normalizeIPv4Numeric('0xA9FEA9FE')).toBe('169.254.169.254');
      expect(normalizeIPv4Numeric('192.168.1')).toBe('192.168.0.1');
      expect(normalizeIPv4Numeric('example.com')).toBeNull();
      expect(normalizeIPv4Numeric('999.1.1.1')).toBeNull();
      expect(normalizeIPv4Numeric('1.2.3.4.5')).toBeNull();
      expect(normalizeIPv4Numeric('09')).toBeNull();
    });
  });

  describe('redirect handling (SEC-003 class)', () => {
    it('follows public→public redirects, re-vetting and re-pinning every hop', async () => {
      const lookups: string[] = [];
      const lookup: LookupAllFn = async (hostname) => {
        lookups.push(hostname);
        return [{ address: hostname === 'a.example.com' ? '93.184.215.14' : '151.101.1.140', family: 4 }];
      };
      const { transport, calls } = makeTransport([
        { status: 302, headers: { location: 'https://b.example.com/final' } },
        { status: 200, body: 'landed' }
      ]);
      const tool = buildWebFetchTool({ lookup, transport });
      const r = await tool.execute({ url: 'https://a.example.com/start' }, testCtx);
      expect(r.isError).toBe(false);
      expect(r.output).toContain('landed');
      // Output header names the ORIGINAL host, matching pre-hardening UX.
      expect(r.output).toMatch(/• a\.example\.com/);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe('https://b.example.com/final');
      // Every hop got its own resolution and its own pinned address.
      expect(lookups).toEqual(['a.example.com', 'b.example.com']);
      expect(calls[0].pinned.address).toBe('93.184.215.14');
      expect(calls[1].pinned.address).toBe('151.101.1.140');
    });

    it('blocks a redirect from a public host to the cloud-metadata IP', async () => {
      const { transport, calls } = makeTransport([
        { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
      ]);
      const tool = buildWebFetchTool({ lookup: publicLookup(), transport });
      const r = await tool.execute({ url: 'https://public.example.com/redirect-me' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: redirect to 169\.254\.169\.254/);
      expect(calls).toHaveLength(1);
    });

    it('blocks a redirect to a hostname that resolves to a private address', async () => {
      const lookup: LookupAllFn = async (hostname) =>
        hostname === 'internal.example.com'
          ? [{ address: '10.0.0.5', family: 4 }]
          : [{ address: '93.184.215.14', family: 4 }];
      const { transport, calls } = makeTransport([
        { status: 301, headers: { location: 'https://internal.example.com/admin' } }
      ]);
      const tool = buildWebFetchTool({ lookup, transport });
      const r = await tool.execute({ url: 'https://public.example.com/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: redirect to internal\.example\.com/);
      expect(r.output).toMatch(/10\.0\.0\.5/);
      expect(calls).toHaveLength(1);
    });

    it('blocks a redirect whose target hides the internal address in a numeric encoding', async () => {
      // SEC-003 × SEC-004: the redirect hop gets the SAME normalization the
      // first hop gets, so "302 → http://2130706433/" is still loopback.
      for (const location of ['http://2130706433/', 'http://0xA9FEA9FE/latest/meta-data/', 'http://127.1/']) {
        const { transport, calls } = makeTransport([{ status: 302, headers: { location } }]);
        const tool = buildWebFetchTool({ lookup: publicLookup(), transport });
        const r = await tool.execute({ url: 'https://public.example.com/' }, testCtx);
        expect(r.isError, `expected redirect to ${location} to be blocked`).toBe(true);
        expect(r.output).toMatch(/Blocked: redirect to/);
        expect(calls).toHaveLength(1);
      }
    });

    it('blocks a redirect to an IPv4-mapped IPv6 internal address', async () => {
      const { transport, calls } = makeTransport([
        { status: 307, headers: { location: 'http://[::ffff:169.254.169.254]/latest/meta-data/' } }
      ]);
      const tool = buildWebFetchTool({ lookup: publicLookup(), transport });
      const r = await tool.execute({ url: 'https://public.example.com/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/Blocked: redirect to \[::ffff:a9fe:a9fe\]/);
      expect(calls).toHaveLength(1);
    });

    it('blocks redirects that downgrade to non-http protocols (file:, data:)', async () => {
      for (const location of ['file:///etc/passwd', 'data:text/html,<script>x</script>']) {
        const { transport, calls } = makeTransport([{ status: 302, headers: { location } }]);
        const tool = buildWebFetchTool({ lookup: publicLookup(), transport });
        const r = await tool.execute({ url: 'https://public.example.com/' }, testCtx);
        expect(r.isError, `expected redirect to ${location} to be blocked`).toBe(true);
        expect(r.output).toMatch(/Blocked: redirect to unsupported protocol/);
        expect(calls).toHaveLength(1);
      }
    });

    it('gives up after 5 redirect hops', async () => {
      const { transport, calls } = makeTransport((call) => ({
        status: 302,
        headers: { location: `https://pub.example.com/r${call + 1}` }
      }));
      const tool = buildWebFetchTool({ lookup: publicLookup(), transport });
      const r = await tool.execute({ url: 'https://pub.example.com/r0' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/too many redirects \(limit 5\)/);
      expect(calls).toHaveLength(6); // original request + 5 followed hops
    });

    it('treats a 3xx without a Location header as a final response', async () => {
      const { transport, calls } = makeTransport([{ status: 302, statusText: 'Found', body: 'no location' }]);
      const tool = buildWebFetchTool({ lookup: publicLookup(), transport });
      const r = await tool.execute({ url: 'https://pub.example.com/' }, testCtx);
      expect(r.isError).toBe(true);
      expect(r.output).toMatch(/HTTP 302 Found/);
      expect(calls).toHaveLength(1);
    });
  });

  describe('DNS rebinding / pinned connection (SEC-003 class)', () => {
    it('connects to the vetted IP — a re-resolving name cannot swap in a private address after the check', async () => {
      // Attacker DNS answers public on the first resolution and loopback on
      // the second. Pre-hardening, check (#1) and fetch (#2) each resolved
      // independently — the TOCTOU window. Now one resolution feeds both
      // the check and the pinned connection.
      let resolutions = 0;
      const lookup: LookupAllFn = async () => {
        resolutions += 1;
        return resolutions === 1
          ? [{ address: '93.184.215.14', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      };
      const { transport, calls } = makeTransport([{ status: 200, body: 'ok' }]);
      const tool = buildWebFetchTool({ lookup, transport });

      const first = await tool.execute({ url: 'https://rebind.example.com/' }, testCtx);
      expect(first.isError).toBe(false);
      expect(resolutions).toBe(1); // exactly one resolution serves check AND connect
      expect(calls).toHaveLength(1);
      expect(calls[0].pinned.address).toBe('93.184.215.14'); // connected IP === checked IP

      // A later fetch re-resolves from scratch and catches the flipped record.
      const second = await tool.execute({ url: 'https://rebind.example.com/' }, testCtx);
      expect(second.isError).toBe(true);
      expect(second.output).toMatch(/127\.0\.0\.1/);
      expect(calls).toHaveLength(1); // no connection was attempted
    });

    it('pinnedHttpTransport connects the socket to the pinned address, not the URL hostname', async () => {
      // Real loopback server; the URL hostname is unresolvable on purpose.
      // If the transport re-resolved the name instead of honoring the pin,
      // this request could never succeed.
      const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.end(`host-header=${req.headers.host ?? ''}`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await pinnedHttpTransport(
          new URL(`http://pinned-target.invalid:${port}/x`),
          { address: '127.0.0.1', family: 4 },
          { headers: { Accept: 'text/plain' }, deadlineAt: Date.now() + 5000 }
        );
        expect(res.status).toBe(200);
        // Host header (and for TLS, SNI) still carries the hostname.
        expect(res.body).toBe(`host-header=pinned-target.invalid:${port}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('pins IPv6 addresses too (a v6-only resolution must still connect)', async () => {
      const server = http.createServer((_req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.end('v6');
      });
      await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await pinnedHttpTransport(
          new URL(`http://v6-target.invalid:${port}/`),
          { address: '::1', family: 6 },
          { headers: {}, deadlineAt: Date.now() + 5000 }
        );
        expect(res.status).toBe(200);
        expect(res.body).toBe('v6');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('isPrivateHost classifier', () => {
    it('treats every RFC1918 / loopback / link-local literal as private', async () => {
      const privates = [
        'localhost', 'ip6-localhost', 'ip6-loopback', 'foo.localhost',
        '127.0.0.1', '127.5.5.5', '0.0.0.0',
        '10.0.0.1', '10.255.255.255',
        '172.16.0.1', '172.20.5.5', '172.31.255.255',
        '192.168.0.1', '192.168.100.100',
        '169.254.169.254', '169.254.0.1',
        '100.64.0.1', '100.127.255.255',                       // CGNAT
        '255.255.255.255', '224.0.0.1',                        // broadcast / multicast
        '2130706433', '0x7f000001', '0177.0.0.1', '127.1',     // numeric loopback encodings
        '2852039166', '0xA9FEA9FE',                            // numeric metadata encodings
        '::1', '::',
        '::ffff:10.0.0.1',                                     // IPv4-mapped private (dotted)
        '::ffff:7f00:1', '::ffff:a9fe:a9fe',                   // IPv4-mapped private (hex form)
        '0:0:0:0:0:ffff:a00:1',                                // IPv4-mapped, uncompressed
        '64:ff9b::7f00:1',                                     // NAT64-embedded loopback
        'fc00::1', 'fd12:3456:789a::1',                        // Unique Local
        'fe80::1', 'fe9a::dead'                                // link-local
      ];
      for (const h of privates) {
        expect(await isPrivateHost(h), `expected ${h} to be private`).toBe(true);
      }
    });

    it('does NOT classify public IPv4 / IPv6 literals as private', async () => {
      const publics = [
        '8.8.8.8',
        '1.1.1.1',
        '93.184.215.14',
        '172.15.0.1',                                          // just below 172.16/12
        '172.32.0.1',                                          // just above 172.16/12
        '192.167.0.1',
        '::ffff:8.8.8.8',                                      // IPv4-mapped public stays public
        '2606:4700:4700::1111'                                 // Cloudflare DNS v6
      ];
      for (const h of publics) {
        expect(await isPrivateHost(h), `expected ${h} to be public`).toBe(false);
      }
    });
  });
});

describe('buildWebSearchTool', () => {
  const ORIGINAL_TAVILY = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL_TAVILY === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = ORIGINAL_TAVILY;
  });

  it('exposes name="web_search" with required query and optional num_results', () => {
    const tool = buildWebSearchTool();
    expect(tool.name).toBe('web_search');
    expect(tool.parameters.find(p => p.name === 'query')?.required).toBe(true);
    expect(tool.parameters.find(p => p.name === 'num_results')?.required).toBe(false);
  });

  it('errors clearly when no API key is configured (model can fall back to web_fetch)', async () => {
    const tool = buildWebSearchTool();
    const r = await tool.execute({ query: 'whatever' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/web_search is not configured/);
    expect(r.output).toMatch(/web_fetch/);
  });

  it('errors when query is missing', async () => {
    process.env.TAVILY_API_KEY = 'set';
    const tool = buildWebSearchTool();
    const r = await tool.execute({}, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Missing query/);
  });

  it('uses options.apiKey over the env var', async () => {
    process.env.TAVILY_API_KEY = 'env-key';
    const tool = buildWebSearchTool({ apiKey: 'opt-key' });
    let receivedBody: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      receivedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    });
    await tool.execute({ query: 'hi' }, testCtx);
    expect((receivedBody as { api_key: string }).api_key).toBe('opt-key');
  });

  it('clamps num_results to a max of 10 and a sensible default of 5', async () => {
    process.env.TAVILY_API_KEY = 'k';
    const tool = buildWebSearchTool();
    let body1: unknown, body2: unknown;
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      const parsed = JSON.parse((init as RequestInit).body as string);
      if (calls === 1) body1 = parsed;
      else body2 = parsed;
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      });
    });
    await tool.execute({ query: 'a' }, testCtx); // default
    await tool.execute({ query: 'b', num_results: '99' }, testCtx); // clamp
    expect((body1 as { max_results: number }).max_results).toBe(5);
    expect((body2 as { max_results: number }).max_results).toBe(10);
  });

  it('formats results with optional Direct answer, numbered titles, URLs, and trimmed snippets', async () => {
    process.env.TAVILY_API_KEY = 'k';
    const tool = buildWebSearchTool();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          answer: 'short llm summary',
          results: [
            { title: 'TS Paths', url: 'https://example.com/a', content: 'about paths' },
            { title: 'Docs', url: 'https://example.com/b', content: 'long '.repeat(200) }
          ]
        }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }
      )
    );
    const r = await tool.execute({ query: 'typescript paths' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/Direct answer: short llm summary/);
    expect(r.output).toMatch(/1\. TS Paths/);
    expect(r.output).toContain('https://example.com/a');
    expect(r.output).toMatch(/2\. Docs/);
    // Long snippet is truncated with an ellipsis (single-char Unicode).
    expect(r.output).toContain('…');
  });

  it('returns "No results" with isError=false when the search yields nothing', async () => {
    process.env.TAVILY_API_KEY = 'k';
    const tool = buildWebSearchTool();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      })
    );
    const r = await tool.execute({ query: 'nothing' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/No results for "nothing"/);
  });

  it('flags HTTP errors with isError=true and includes the upstream status', async () => {
    process.env.TAVILY_API_KEY = 'k';
    const tool = buildWebSearchTool();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
    );
    const r = await tool.execute({ query: 'q' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Search failed: HTTP 429/);
  });

  it('returns isError when fetch throws (timeout / network)', async () => {
    process.env.TAVILY_API_KEY = 'k';
    const tool = buildWebSearchTool();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const r = await tool.execute({ query: 'q' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Search failed: boom/);
  });
});
