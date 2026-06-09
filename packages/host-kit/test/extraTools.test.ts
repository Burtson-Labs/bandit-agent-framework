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
import {
  TodoStore,
  buildTodoWriteTool,
  buildRememberTool,
  buildWebFetchTool,
  buildWebSearchTool,
  isPrivateHost
} from '../src/tools/extraTools';
import { testCtx } from './_helpers';

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
  // SSRF guard resolves DNS before fetch. Stub it for the public-flow tests
  // so they stay hermetic and fast — the dedicated SSRF describe block
  // below exercises the resolver behavior end-to-end.
  beforeEach(() => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue(
      [{ address: '93.184.215.14', family: 4 }] as unknown as dnsMod.LookupAddress
    );
  });

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
    const tool = buildWebFetchTool();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('plain text content here', {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/plain' }
      })
    );
    const r = await tool.execute({ url: 'https://example.com/x' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/HTTP 200 OK/);
    expect(r.output).toContain('plain text content here');
    expect(r.output).toContain('example.com');
  });

  it('strips HTML tags when content-type indicates HTML', async () => {
    const tool = buildWebFetchTool();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<html><head><script>alert(1)</script><style>x{}</style></head><body><p>Hello <b>world</b></p></body></html>',
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    );
    const r = await tool.execute({ url: 'https://example.com/' }, testCtx);
    expect(r.output).toContain('Hello world');
    // Script + style content removed.
    expect(r.output).not.toContain('alert(1)');
    expect(r.output).not.toContain('x{}');
    // Tags themselves stripped.
    expect(r.output).not.toMatch(/<\/?p>/);
  });

  it('truncates bodies larger than 16 KB and marks them with an ellipsis', async () => {
    const tool = buildWebFetchTool();
    const big = 'A'.repeat(20 * 1024);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(big, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/plain' }
      })
    );
    const r = await tool.execute({ url: 'https://example.com/big' }, testCtx);
    expect(r.output).toMatch(/… \(truncated\)/);
  });

  it('flags non-2xx responses with isError=true so the model knows the call failed', async () => {
    const tool = buildWebFetchTool();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'text/plain' }
      })
    );
    const r = await tool.execute({ url: 'https://example.com/missing' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/HTTP 404 Not Found/);
  });

  it('returns isError when fetch throws (network failure / abort)', async () => {
    const tool = buildWebFetchTool();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await tool.execute({ url: 'https://example.com/down' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Fetch failed: ECONNREFUSED/);
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
    const tool = buildWebFetchTool();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await tool.execute({ url: 'http://localhost:6443/api' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Blocked: localhost/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks direct IPv4 loopback (127.0.0.1) without DNS', async () => {
    const tool = buildWebFetchTool();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await tool.execute({ url: 'http://127.0.0.1:8080/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/127\.0\.0\.1.*private/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata link-local address 169.254.169.254', async () => {
    const tool = buildWebFetchTool();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/169\.254\.169\.254/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks IPv6 loopback [::1]', async () => {
    const tool = buildWebFetchTool();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await tool.execute({ url: 'http://[::1]:9000/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks a public hostname that resolves to a private IP (DNS rebinding shape)', async () => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue(
      [{ address: '10.0.0.5', family: 4 }] as unknown as dnsMod.LookupAddress
    );
    const tool = buildWebFetchTool();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await tool.execute({ url: 'https://internal.example.com/admin' }, testCtx);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/internal\.example\.com.*private/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks when the hostname resolves to multiple IPs and ANY of them is private', async () => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.10', family: 4 }
    ] as unknown as dnsMod.LookupAddress);
    const tool = buildWebFetchTool();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await tool.execute({ url: 'https://mixed.example.com/' }, testCtx);
    expect(r.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows fetch when hostname resolves to a public IP', async () => {
    vi.spyOn(dnsMod.promises, 'lookup').mockResolvedValue(
      [{ address: '93.184.215.14', family: 4 }] as unknown as dnsMod.LookupAddress
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain' } })
    );
    const tool = buildWebFetchTool();
    const r = await tool.execute({ url: 'https://example.com/' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/HTTP 200 OK/);
  });

  it('allows fetch to private addresses when BANDIT_ALLOW_PRIVATE_WEB_FETCH=1', async () => {
    process.env.BANDIT_ALLOW_PRIVATE_WEB_FETCH = '1';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('internal', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain' } })
    );
    const tool = buildWebFetchTool();
    const r = await tool.execute({ url: 'http://10.0.0.5/docs' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain('internal');
  });

  describe('isPrivateHost classifier', () => {
    it('treats every RFC1918 / loopback / link-local literal as private', async () => {
      const privates = [
        'localhost', 'ip6-localhost', 'ip6-loopback',
        '127.0.0.1', '127.5.5.5', '0.0.0.0',
        '10.0.0.1', '10.255.255.255',
        '172.16.0.1', '172.20.5.5', '172.31.255.255',
        '192.168.0.1', '192.168.100.100',
        '169.254.169.254', '169.254.0.1',
        '100.64.0.1', '100.127.255.255',                       // CGNAT
        '::1', '::',
        '::ffff:10.0.0.1',                                     // IPv4-mapped private
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
