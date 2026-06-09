/**
 * Contract tests for `DiffPreviewService` — agent-edit diff preview
 * lifecycle (extract → present → apply / explain / discard).
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `presentFromReport()` filters the report to entries that carry
 *     both `diff` and `path`, plus surfaces `additionalWrites` as
 *     follow-on previews; posts one `diffPreviewCard` per preview,
 *     (2) `handleAction()` on an unknown path posts a graceful error
 *     `diffPreviewResult` and never throws,
 * (3) `handleAction({ action: 'explain' })` primes the composer via
 *     `ctx.setPendingPrompt` AND posts the feedback decision —
 *     the explain path is the one that touches the most surfaces.
 *
 * The vscode workspace surface (`workspaceFolders`, `openTextDocument`,
 * etc.) is stubbed minimally — the goal is to assert the service's
 * own side-effects, not to integration-test VS Code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentReport } from '@burtson-labs/stealth-core-runtime';
import type { FeedbackRequest } from '../../src/agentTypes';
import type { ProviderContext } from '../../src/provider/context';

const vscodeMock = vi.hoisted(() => ({
  workspaceRoot: '/tmp/bandit-diff-test' as string | undefined
}));

vi.mock('vscode', () => {
  const stubUri = (fsPath: string) => ({
    fsPath,
    toString: () => `file://${fsPath}`,
    scheme: 'file'
  });
  return {
    workspace: {
      get workspaceFolders() {
        return vscodeMock.workspaceRoot ? [{ uri: stubUri(vscodeMock.workspaceRoot) }] : undefined;
      },
      getConfiguration: () => ({
        get: <T,>(_: string, fallback?: T) => fallback as T
      }),
      openTextDocument: vi.fn(async () => ({
        lineCount: 0,
        lineAt: () => ({ range: { end: { line: 0, character: 0 } } }),
        save: async () => true
      })),
      fs: {
        stat: vi.fn(async () => ({})),
        readFile: vi.fn(async () => new Uint8Array()),
        writeFile: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined)
      },
      applyEdit: vi.fn(async () => true)
    },
    languages: {
      setTextDocumentLanguage: vi.fn(async () => undefined)
    },
    window: {
      showTextDocument: vi.fn(async () => ({})),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      activeTextEditor: undefined,
      visibleTextEditors: [],
      tabGroups: { all: [], close: vi.fn(async () => undefined) }
    },
    commands: { executeCommand: vi.fn(async () => undefined) },
    Uri: { file: (fsPath: string) => stubUri(fsPath) },
    ViewColumn: { Active: -1, Beside: -2 },
    Range: class {
      constructor(public start: unknown, public end: unknown) {}
    },
    Position: class {
      constructor(public line: number, public character: number) {}
    },
    WorkspaceEdit: class {
      replace = vi.fn();
    },
    TabInputText: class {},
    TabInputTextDiff: class {}
  };
});

import { DiffPreviewService } from '../../src/provider/services/diffPreviewService';

function makeCtx(): { ctx: ProviderContext; posted: Array<Record<string, unknown>>; pendingPrompts: string[] } {
  const posted: Array<Record<string, unknown>> = [];
  const pendingPrompts: string[] = [];
  const ctx = {
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); },
    syncState: async () => undefined,
    setPendingPrompt: async (prompt: string) => { pendingPrompts.push(prompt); },
    conversations: { currentId: 'conv-1' },
    diffContentProvider: {
      registerDiff: vi.fn(() => ({ fsPath: '/inline', toString: () => 'inline://x' })),
      release: vi.fn()
    }
  } as unknown as ProviderContext;
  return { ctx, posted, pendingPrompts };
}

function makeReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    results: [
      {
        tool: 'apply_edit',
        ok: true,
        output: 'Wrote /a/b.ts',
        data: {
          path: 'src/a.ts',
          diff: '--- a\n+++ b\n@@\n-old\n+new',
          backupPath: undefined,
          backupContent: undefined,
          additionalWrites: [
            { path: 'src/follow.ts', diff: '--- a\n+++ b\n@@\n-x\n+y' }
          ]
        }
      },
      {
        tool: 'run_command',
        ok: true,
        output: 'no diff here',
        data: undefined
      }
    ],
    ...overrides
  } as unknown as AgentReport;
}

beforeEach(() => {
  vscodeMock.workspaceRoot = '/tmp/bandit-diff-test';
});

describe('DiffPreviewService', () => {
  it('presentFromReport() filters report results to entries with diff+path and surfaces additionalWrites', async () => {
    const { ctx, posted } = makeCtx();
    const feedbackCalls: Array<{ payload: FeedbackRequest }> = [];
    const svc = new DiffPreviewService(ctx, {
      sendFeedback: async (payload) => { feedbackCalls.push({ payload }); }
    });

    await svc.presentFromReport(makeReport());

    // Two previews: the primary apply_edit + the additionalWrite.
    // The run_command result (no diff) is filtered out.
    expect(svc.pendingPreviews).toHaveLength(2);
    expect(svc.pendingPreviews[0].path).toBe('src/a.ts');
    expect(svc.pendingPreviews[1].path).toBe('src/follow.ts');

    // One diffPreviewClear (from the initial clearSessions) plus a
    // diffPreviewCard per preview.
    const cards = posted.filter((m) => m.type === 'diffPreviewCard');
    expect(cards).toHaveLength(2);
    expect((cards[0] as { preview: { path: string } }).preview.path).toBe('src/a.ts');
    expect((cards[1] as { preview: { path: string } }).preview.path).toBe('src/follow.ts');

    // Sessions tracked for both previews.
    expect(svc.sessionCount).toBe(2);
  });

  it('handleAction() on an unknown path posts a graceful diffPreviewResult error and never throws', async () => {
    const { ctx, posted } = makeCtx();
    const svc = new DiffPreviewService(ctx, { sendFeedback: async () => undefined });

    await expect(svc.handleAction({ path: 'unseen.ts', action: 'apply' })).resolves.toBeUndefined();

    const errors = posted.filter((m) => m.type === 'diffPreviewResult' && m.status === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('no longer available');
  });

  it("handleAction({ action: 'explain' }) primes the composer via setPendingPrompt and posts the explain feedback decision", async () => {
    const { ctx, posted, pendingPrompts } = makeCtx();
    const feedbackCalls: FeedbackRequest[] = [];
    const svc = new DiffPreviewService(ctx, {
      sendFeedback: async (payload) => { feedbackCalls.push(payload); }
    });

    await svc.presentFromReport(makeReport());

    await svc.handleAction({ path: 'src/a.ts', action: 'explain' });

    // Composer was primed with the explain prompt.
    expect(pendingPrompts).toHaveLength(1);
    expect(pendingPrompts[0]).toContain('Explain the proposed updates made to src/a.ts');

    // Feedback was submitted with the explain decision.
    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0].title).toBe('Diff review — explain');
    expect(feedbackCalls[0].category).toBe('improvement');

    // diffPreviewResult posted with status=explain.
    const result = posted.find((m) => m.type === 'diffPreviewResult' && m.path === 'src/a.ts');
    expect((result as { status: string }).status).toBe('explain');

    // Session was disposed.
    expect(svc.sessionCount).toBe(1); // (other preview still pending)
  });
});
