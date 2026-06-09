/**
 * Contract tests for `planMessages` — `handleReplayPlanStep`,
 * `handleRefinePlanStep`, `handleDiffPreviewAction`,
 * `handleUndoAgentChange`.
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `handleReplayPlanStep` forwards (id, 'replay') to the deps
 *     callback and `handleRefinePlanStep` forwards (id, 'refine') —
 *     a swap here would silently demote a refine into a replay or
 *     vice-versa, leaving the user wondering why their refinement
 *     note had no effect.
 * (2) `handleUndoAgentChange` with NO snapshot returned (stack empty
 *     or last entry was a no-op): no information message fires
 *     (silent — the button has already disabled itself), but the
 *     undoSnapshotsAvailable flag still updates via the `finally`
 *     and syncState fires so the disabled state propagates.
 * (3) `handleUndoAgentChange` with a snapshot: information message
 *     reflects the existed-before vs created path
 *     ('Reverted changes in X' vs 'Removed X'), and the flag still
 *     refreshes from `hasSnapshots()` AFTER the undo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';
import type { PlanMessageDeps } from '../../src/provider/messageHandlers/planMessages';

const vscodeMock = vi.hoisted(() => ({
  errors: [] as string[],
  infos: [] as string[]
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(async (msg: string) => { vscodeMock.errors.push(msg); return undefined; }),
    showInformationMessage: vi.fn(async (msg: string) => { vscodeMock.infos.push(msg); return undefined; })
  }
}));

import {
  handleDiffPreviewAction,
  handleRefinePlanStep,
  handleReplayPlanStep,
  handleUndoAgentChange
} from '../../src/provider/messageHandlers/planMessages';

function makeCtx(options: {
  undoLastChange?: () => Promise<unknown>;
  hasSnapshots?: () => boolean;
  diffPreviewHandle?: (m: unknown) => Promise<void>;
} = {}): {
  ctx: ProviderContext;
  posted: Array<Record<string, unknown>>;
  syncCalls: number;
  diffActionCalls: unknown[];
} {
  const posted: Array<Record<string, unknown>> = [];
  let syncCalls = 0;
  const diffActionCalls: unknown[] = [];

  const ctx = {
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); },
    syncState: async () => { syncCalls += 1; },
    undo: {
      undoLastChange: options.undoLastChange ?? (async () => null),
      hasSnapshots: options.hasSnapshots ?? (() => false)
    },
    diffPreviews: {
      handleAction: options.diffPreviewHandle ?? (async (m: unknown) => { diffActionCalls.push(m); })
    }
  } as unknown as ProviderContext;

  return {
    ctx,
    posted,
    get syncCalls() { return syncCalls; },
    diffActionCalls
  } as never;
}

function makeDeps(): { deps: PlanMessageDeps; replayCalls: Array<{ id: string; mode: string }>; undoFlagWrites: boolean[] } {
  const replayCalls: Array<{ id: string; mode: string }> = [];
  const undoFlagWrites: boolean[] = [];
  const deps: PlanMessageDeps = {
    replayPlanStep: async (stepId, mode) => { replayCalls.push({ id: stepId, mode }); },
    setUndoSnapshotsAvailable: (v) => { undoFlagWrites.push(v); }
  };
  return { deps, replayCalls, undoFlagWrites };
}

beforeEach(() => {
  vscodeMock.errors.length = 0;
  vscodeMock.infos.length = 0;
});

describe('handleReplayPlanStep / handleRefinePlanStep', () => {
  it("forwards (id, 'replay') for replay and (id, 'refine') for refine — a mode swap here silently demotes user intent", async () => {
    const { ctx } = makeCtx();
    const { deps, replayCalls } = makeDeps();

    await handleReplayPlanStep(ctx, 'step-42', deps);
    await handleRefinePlanStep(ctx, 'step-7', deps);

    expect(replayCalls).toEqual([
      { id: 'step-42', mode: 'replay' },
      { id: 'step-7', mode: 'refine' }
    ]);
  });
});

describe('handleDiffPreviewAction', () => {
  it('forwards the full message (path + action) into ctx.diffPreviews.handleAction', async () => {
    const { ctx, diffActionCalls } = makeCtx();

    await handleDiffPreviewAction(
      { type: 'diffPreviewAction', path: 'src/foo.ts', action: 'apply' },
      ctx
    );

    expect(diffActionCalls).toHaveLength(1);
    expect(diffActionCalls[0]).toEqual({ type: 'diffPreviewAction', path: 'src/foo.ts', action: 'apply' });
  });
});

describe('handleUndoAgentChange', () => {
  it('no-snapshot path: silent (no info toast), still refreshes the undoSnapshotsAvailable flag from hasSnapshots() and syncs', async () => {
    const wrap = makeCtx({
      undoLastChange: async () => null,
      hasSnapshots: () => false
    });
    const { deps, undoFlagWrites } = makeDeps();

    await handleUndoAgentChange(wrap.ctx, deps);

    expect(wrap.posted).toHaveLength(0);
    expect(vscodeMock.infos).toHaveLength(0);
    expect(vscodeMock.errors).toHaveLength(0);
    // flag still refreshed via the `finally` even though the undo
    // returned null — the button must re-disable when the stack drains.
    expect(undoFlagWrites).toEqual([false]);
    // syncState fires so the disabled state propagates to the webview.
    expect(wrap.syncCalls).toBe(1);
  });

  it("with-snapshot path: shows 'Reverted changes in X' when existedBefore, 'Removed X' when not — and flag refreshes from hasSnapshots() AFTER the undo", async () => {
    // existedBefore=true path
    {
      const { ctx } = makeCtx({
        undoLastChange: async () => ({ path: 'src/x.ts', absolutePath: '/repo/src/x.ts', existedBefore: true }),
        hasSnapshots: () => true
      });
      const { deps, undoFlagWrites } = makeDeps();

      await handleUndoAgentChange(ctx, deps);

      expect(vscodeMock.infos).toEqual(['Reverted changes in src/x.ts']);
      expect(undoFlagWrites).toEqual([true]);
    }
    // existedBefore=false path (file was newly created by the agent)
    {
      vscodeMock.infos.length = 0;
      const { ctx } = makeCtx({
        undoLastChange: async () => ({ path: '', absolutePath: '/repo/src/new-file.ts', existedBefore: false }),
        hasSnapshots: () => false
      });
      const { deps, undoFlagWrites } = makeDeps();

      await handleUndoAgentChange(ctx, deps);

      // path was empty so label falls back to basename(absolutePath).
      expect(vscodeMock.infos).toEqual(['Removed new-file.ts']);
      // flag refreshed from hasSnapshots() — now empty, so false.
      expect(undoFlagWrites).toEqual([false]);
    }
  });

  it('undo failure path: posts the error to the webview AND the VS Code error host AND still updates the flag via finally', async () => {
    const { ctx, posted } = makeCtx({
      undoLastChange: async () => { throw new Error('locked'); },
      hasSnapshots: () => true
    });
    const { deps, undoFlagWrites } = makeDeps();

    await handleUndoAgentChange(ctx, deps);

    expect(vscodeMock.errors).toEqual(['Undo failed: locked']);
    expect(posted).toEqual([{ type: 'notification', message: 'Undo failed: locked' }]);
    // even on failure, the flag is refreshed (finally) — undo
    // failure doesn't mean snapshots became unavailable.
    expect(undoFlagWrites).toEqual([true]);
  });
});
