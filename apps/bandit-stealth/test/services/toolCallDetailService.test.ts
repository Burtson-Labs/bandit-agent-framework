/**
 * Contract tests for `ToolCallDetailService` — the per-runId cache
 * behind click-to-open on bandit-tl / bandit-run cards.
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) the in-memory Map evicts FIFO at the cap so memory stays flat
 *     across long sessions,
 * (2) capture-then-get is a round trip and the disk-write side-effect
 *     doesn't break the in-memory path,
 * (3) openInEditor opens a markdown doc on hit and surfaces an info
 *     toast on miss, with no exceptions either way.
 *
 * The disk-store helpers (`saveToolDetail` / `loadToolDetail`) are not
 * mocked — they no-op when workspaceRoot is empty, which is how each
 * test scopes the disk side-effect away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCallDetail } from '../../src/helpers/toolDetail';

const vscodeMock = vi.hoisted(() => ({
  workspaceRoot: undefined as string | undefined,
  openTextDocumentCalls: [] as Array<{ language: string; content: string }>,
  showTextDocumentCalls: 0,
  infoToasts: [] as string[]
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return vscodeMock.workspaceRoot
        ? [{ uri: { fsPath: vscodeMock.workspaceRoot } }]
        : undefined;
    },
    openTextDocument: vi.fn(async (opts: { language: string; content: string }) => {
      vscodeMock.openTextDocumentCalls.push(opts);
      return { uri: { fsPath: 'inmem' } };
    })
  },
  window: {
    showTextDocument: vi.fn(async () => {
      vscodeMock.showTextDocumentCalls += 1;
      return {};
    }),
    showInformationMessage: vi.fn(async (msg: string) => {
      vscodeMock.infoToasts.push(msg);
      return undefined;
    })
  },
  ViewColumn: { Active: -1 }
}));

import { ToolCallDetailService } from '../../src/provider/services/toolCallDetailService';

function makeDetail(overrides: Partial<ToolCallDetail> = {}): ToolCallDetail {
  return {
    tool: 'run_command',
    params: { cmd: 'echo', args: 'hi' },
    cmd: 'echo hi',
    output: 'hi',
    outputLength: 2,
    isError: false,
    durationMs: 12,
    at: 1_700_000_000_000,
    ...overrides
  };
}

beforeEach(() => {
  vscodeMock.workspaceRoot = undefined;
  vscodeMock.openTextDocumentCalls.length = 0;
  vscodeMock.showTextDocumentCalls = 0;
  vscodeMock.infoToasts.length = 0;
});

describe('ToolCallDetailService', () => {
  it('evicts the oldest entry once size reaches the cap (FIFO)', () => {
    const svc = new ToolCallDetailService({ cap: 3 });
    svc.capture('a', makeDetail({ tool: 'a' }), '');
    svc.capture('b', makeDetail({ tool: 'b' }), '');
    svc.capture('c', makeDetail({ tool: 'c' }), '');
    expect(svc.size).toBe(3);
    expect(svc.get('a')?.tool).toBe('a');

    // Insert a 4th — the oldest ('a') must be dropped, the new entry held.
    svc.capture('d', makeDetail({ tool: 'd' }), '');
    expect(svc.size).toBe(3);
    expect(svc.get('a')).toBeUndefined();
    expect(svc.get('b')?.tool).toBe('b');
    expect(svc.get('c')?.tool).toBe('c');
    expect(svc.get('d')?.tool).toBe('d');
  });

  it('round-trips a captured detail via get() (in-memory hot path)', () => {
    const svc = new ToolCallDetailService({ cap: 10 });
    const detail = makeDetail({ output: 'multi\nline\nresult', outputLength: 17 });
    svc.capture('run-42', detail, '');
    const retrieved = svc.get('run-42');
    expect(retrieved).toBeDefined();
    expect(retrieved?.output).toBe('multi\nline\nresult');
    expect(retrieved?.outputLength).toBe(17);
    // Empty runId must not pollute the Map — that key would always be
    // first in line for the next eviction.
    svc.capture('', makeDetail(), '');
    expect(svc.size).toBe(1);
  });

  it('openInEditor opens a markdown doc on hit and shows an info toast on miss', async () => {
    const svc = new ToolCallDetailService({ cap: 10 });
    svc.capture('hit', makeDetail({ tool: 'grep', output: 'matched' }), '');

    // Hit path — markdown doc opened, no toast.
    await svc.openInEditor('hit');
    expect(vscodeMock.openTextDocumentCalls).toHaveLength(1);
    expect(vscodeMock.openTextDocumentCalls[0].language).toBe('markdown');
    expect(vscodeMock.openTextDocumentCalls[0].content).toContain('grep');
    expect(vscodeMock.openTextDocumentCalls[0].content).toContain('matched');
    expect(vscodeMock.showTextDocumentCalls).toBe(1);
    expect(vscodeMock.infoToasts).toHaveLength(0);

    // Miss path — no doc opened, info toast shown (workspaceRoot is
    // undefined so the disk fallback also misses).
    await svc.openInEditor('missing');
    expect(vscodeMock.openTextDocumentCalls).toHaveLength(1);
    expect(vscodeMock.showTextDocumentCalls).toBe(1);
    expect(vscodeMock.infoToasts).toHaveLength(1);
    expect(vscodeMock.infoToasts[0]).toContain('expired');
  });
});
