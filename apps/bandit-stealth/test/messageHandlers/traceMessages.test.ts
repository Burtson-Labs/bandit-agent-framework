/**
 * Contract tests for `traceMessages` — `handleRequestTraceList`,
 * `handleRequestTraceDetail`, `handleOpenTraceFile`.
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `handleRequestTraceList` switches `listTurnTraces` options on
 *     mode — `failed` mode bumps the limit to 50 AND filters by
 *     status array `['failed','blocked','cancelled']`; `all` mode
 *     uses limit 30 and undefined status. A regression here breaks
 *     the failed-only tab in the trace viewer silently (still posts
 *     a traceList, just the wrong contents).
 * (2) `handleRequestTraceDetail` short-circuits on empty/whitespace
 *     id with `traceError: 'Trace id is empty.'` and never invokes
 *     `readTurnTraceById` — the no-empty-id guard avoids a confusing
 *     "trace not found: " error when the webview omits the id.
 * (3) `handleOpenTraceFile` short-circuits on empty path with a
 *     `notification` (not `traceError`) and never invokes
 *     `vscode.workspace.openTextDocument` — the empty-path guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';

const hostKitMock = vi.hoisted(() => ({
  listCalls: [] as Array<{ root: string; options: unknown }>,
  listReturns: [] as unknown[],
  readCalls: [] as Array<{ root: string; id: string }>,
  readReturns: undefined as unknown,
  formatCalls: 0
}));

vi.mock('@burtson-labs/host-kit', () => ({
  listTurnTraces: vi.fn(async (root: string, options: unknown) => {
    hostKitMock.listCalls.push({ root, options });
    return hostKitMock.listReturns;
  }),
  readTurnTraceById: vi.fn(async (root: string, id: string) => {
    hostKitMock.readCalls.push({ root, id });
    return hostKitMock.readReturns;
  }),
  formatTurnTraceMarkdown: vi.fn(() => { hostKitMock.formatCalls += 1; return '# trace md'; }),
  previewText: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))
}));

const vscodeMock = vi.hoisted(() => ({
  openTextDocumentCalls: [] as string[],
  showTextDocumentCalls: 0
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/ws-trace' } }],
    openTextDocument: vi.fn(async (uri: { fsPath: string }) => {
      vscodeMock.openTextDocumentCalls.push(uri.fsPath);
      return { uri };
    })
  },
  window: {
    showTextDocument: vi.fn(async () => { vscodeMock.showTextDocumentCalls += 1; })
  },
  Uri: {
    file: (p: string) => ({ fsPath: p })
  },
  ViewColumn: { Beside: 'beside' }
}));

import {
  handleOpenTraceFile,
  handleRequestTraceDetail,
  handleRequestTraceList
} from '../../src/provider/messageHandlers/traceMessages';

function makeCtx(): { ctx: ProviderContext; posted: Array<Record<string, unknown>> } {
  const posted: Array<Record<string, unknown>> = [];
  const ctx = {
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); }
  } as unknown as ProviderContext;
  return { ctx, posted };
}

beforeEach(() => {
  hostKitMock.listCalls.length = 0;
  hostKitMock.listReturns = [];
  hostKitMock.readCalls.length = 0;
  hostKitMock.readReturns = undefined;
  hostKitMock.formatCalls = 0;
  vscodeMock.openTextDocumentCalls.length = 0;
  vscodeMock.showTextDocumentCalls = 0;
});

describe('handleRequestTraceList', () => {
  it("switches limit + status filter on mode — 'failed' uses limit 50 and the failed-status array, 'all' uses limit 30 and undefined status", async () => {
    const { ctx, posted } = makeCtx();

    await handleRequestTraceList(ctx, 'failed');
    await handleRequestTraceList(ctx, 'all');

    expect(hostKitMock.listCalls).toHaveLength(2);
    expect(hostKitMock.listCalls[0].options).toEqual({
      limit: 50,
      includeGlobal: true,
      status: ['failed', 'blocked', 'cancelled']
    });
    expect(hostKitMock.listCalls[1].options).toEqual({
      limit: 30,
      includeGlobal: true,
      status: undefined
    });
    // Both posts are traceList with the requested mode.
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({ type: 'traceList', mode: 'failed', selectedId: null, traces: [] });
    expect(posted[1]).toMatchObject({ type: 'traceList', mode: 'all', selectedId: null, traces: [] });
  });

  it('posts traceError on failure and never posts traceList — the failure path stays inside the trace viewer surface', async () => {
    const { ctx, posted } = makeCtx();
    // make listTurnTraces throw on the next call by swapping the
    // hoisted impl shim — the mock recipe captures into listCalls so
    // we override via a one-shot rejection in the spy.
    const mod = await import('@burtson-labs/host-kit');
    (mod.listTurnTraces as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error('disk full'));

    await handleRequestTraceList(ctx, 'all');

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'traceError' });
    expect((posted[0] as { message: string }).message).toContain('Unable to read traces');
    expect((posted[0] as { message: string }).message).toContain('disk full');
  });
});

describe('handleRequestTraceDetail', () => {
  it("short-circuits on empty/whitespace id with traceError 'Trace id is empty.' and never calls readTurnTraceById", async () => {
    const { ctx, posted } = makeCtx();

    for (const id of ['', '   ', '\t\n']) {
      posted.length = 0;
      hostKitMock.readCalls.length = 0;
      await handleRequestTraceDetail(ctx, id);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toEqual({ type: 'traceError', message: 'Trace id is empty.' });
      expect(hostKitMock.readCalls).toHaveLength(0);
    }
  });

  it('posts traceDetail with summary + serialized events + markdown when the trace is found', async () => {
    const { ctx, posted } = makeCtx();
    hostKitMock.readReturns = {
      summary: {
        id: 't-1',
        filePath: '/x/t-1.jsonl',
        scope: 'workspace',
        workspace: '/ws-trace',
        iterations: 3,
        hitLimit: false,
        toolCalls: 5,
        tools: ['write_file'],
        blockedTools: 0,
        errors: 1,
        retries: 0,
        nativeFallbacks: 0,
        permissionRequests: 1,
        permissionDecisions: 1,
        permissionDenials: 0,
        compactions: 0,
        checkpoints: 1,
        status: 'completed',
        prompt: 'do a thing',
        finalPreview: 'did the thing'
      },
      events: [
        { t: '12:00', type: 'tool-execute', iteration: 1, name: 'write_file', primary: '/tmp/x' },
        { t: '12:01', type: 'tool-error', iteration: 1, name: 'write_file', error: 'EACCES' }
      ]
    };

    await handleRequestTraceDetail(ctx, ' t-1 ');

    expect(hostKitMock.readCalls).toEqual([{ root: '/ws-trace', id: 't-1' }]);
    expect(hostKitMock.formatCalls).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'traceDetail' });
    const detail = (posted[0] as { trace: { summary: { id: string; status: string }; events: Array<{ type: string; isError?: boolean }>; markdown: string } }).trace;
    expect(detail.summary.id).toBe('t-1');
    expect(detail.summary.status).toBe('completed');
    expect(detail.markdown).toBe('# trace md');
    expect(detail.events).toHaveLength(2);
    // serializeTraceEvent flips isError on for any type that includes 'error'.
    expect(detail.events[1].isError).toBe(true);
  });
});

describe('handleOpenTraceFile', () => {
  it("short-circuits on empty/whitespace path with a 'notification' (NOT traceError — preserves pre-extraction wire shape) and never opens a document", async () => {
    const { ctx, posted } = makeCtx();

    for (const path of ['', '   ', '\t']) {
      posted.length = 0;
      vscodeMock.openTextDocumentCalls.length = 0;
      await handleOpenTraceFile(ctx, path);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ type: 'notification' });
      expect((posted[0] as { message: string }).message).toContain('Trace file path unavailable');
      expect(vscodeMock.openTextDocumentCalls).toHaveLength(0);
    }
  });
});
