/**
 * Contract tests for createDiffManager — the pending-diff registry that
 * sits between "agent edited a file" and "user approves the diff card."
 * Zero coverage before . A regression here would mean:
 * - wrong diff displayed (user approves change they didn't see)
 * - snapshot history overflow (memory growth)
 * - transaction state leaks (one turn's diffs bleed into the next)
 * - review-mode bypass (diffs auto-apply when user wanted approval)
 *
 * The whole module is dependency-injected (postSnapshot / postStream /
 * computeDiff / summarizeDiff are passed in), so these tests don't
 * shell out — they pin contracts on the in-memory state machine.
 */
import { describe, expect, it } from 'vitest';
import { createDiffManager } from '../src/runtime/diffManager';
import type {
  DiffStreamUpdate,
  FileChangeSnapshot,
  PendingDiff
} from '../src/runtime/types';

interface CallLog {
  snapshots: Array<{ path: string; diff: string; summary?: { added: number; removed: number }; confidence?: number }>;
  streams: DiffStreamUpdate[];
}

function buildManager(opts?: {
  computeDiff?: (before: string, after: string, path: string) => Promise<string | undefined>;
  summarizeDiff?: (diff: string) => { added: number; removed: number };
}) {
  const calls: CallLog = { snapshots: [], streams: [] };
  const mgr = createDiffManager({
    async postSnapshot(p) { calls.snapshots.push(p); },
    async postStream(u) { calls.streams.push(u); },
    computeDiff: opts?.computeDiff ?? (async (b, a) => (b === a ? '' : `--- before\n+++ after\n@@ ${a} @@`)),
    summarizeDiff: opts?.summarizeDiff ?? ((d) => ({ added: d ? 1 : 0, removed: 0 }))
  });
  return { mgr, calls };
}

function buildSnapshot(path: string, extra: Partial<FileChangeSnapshot> = {}): FileChangeSnapshot {
  return {
    path,
    absolutePath: `/abs/${path}`,
    before: 'before',
    after: 'after',
    encoding: 'utf-8',
    timestamp: Date.now(),
    existedBefore: true,
    ...extra
  };
}

describe('createDiffManager — registerPendingDiff', () => {
  it('computes the diff, stores the pending entry, and posts a snapshot', async () => {
    const { mgr, calls } = buildManager();
    const r = await mgr.registerPendingDiff('src/foo.ts', 'old', 'new', 0.9);
    expect(r.original).toBe('old');
    expect(r.updated).toBe('new');
    expect(r.diff).toBeTruthy();
    expect(r.summary).toEqual({ added: 1, removed: 0 });
    expect(r.changed).toBe(true);
    expect(r.confidence).toBe(0.9);
    expect(calls.snapshots).toHaveLength(1);
    expect(calls.snapshots[0].path).toBe('src/foo.ts');
  });

  it('does NOT post a snapshot when computed diff is empty (no real change)', async () => {
    const { mgr, calls } = buildManager({ computeDiff: async () => '' });
    const r = await mgr.registerPendingDiff('src/foo.ts', 'same', 'same');
    expect(r.changed).toBe(false);
    expect(r.diff).toBe('');
    expect(calls.snapshots).toHaveLength(0);
  });

  it('preserves existing diff/summary when updated is not provided (refresh of confidence only)', async () => {
    const { mgr } = buildManager();
    await mgr.registerPendingDiff('src/foo.ts', 'old', 'new', 0.5);
    // Re-call with only original (updated undefined) — should keep the
    // prior diff and just refresh confidence.
    const r = await mgr.registerPendingDiff('src/foo.ts', 'old-but-new-orig', undefined, 0.95);
    expect(r.confidence).toBe(0.95);
    expect(r.original).toBe('old-but-new-orig');
    // Existing updated/diff/summary stays.
    expect(r.updated).toBe('new');
    expect(r.diff).toBeTruthy();
  });

  it('survives a thrown computeDiff and returns the pre-computation pending entry', async () => {
    const { mgr, calls } = buildManager({
      computeDiff: async () => { throw new Error('boom'); }
    });
    const r = await mgr.registerPendingDiff('src/foo.ts', 'old', 'new');
    // Returned object has the inputs but no diff/summary.
    expect(r.original).toBe('old');
    expect(r.updated).toBe('new');
    expect(r.diff).toBeUndefined();
    expect(calls.snapshots).toHaveLength(0);
  });

  it('subsequent registerPendingDiff with same path replaces the prior entry (last-write-wins)', async () => {
    const { mgr } = buildManager();
    await mgr.registerPendingDiff('src/foo.ts', 'v1', 'v1-edit');
    await mgr.registerPendingDiff('src/foo.ts', 'v1', 'v2-edit');
    const current = mgr.getPendingDiff('src/foo.ts');
    expect(current?.updated).toBe('v2-edit');
  });
});

describe('createDiffManager — transactions', () => {
  it('beginTransaction returns an opaque tx id; concurrent begin throws', () => {
    const { mgr } = buildManager();
    const tx = mgr.beginTransaction();
    expect(tx.id).toBeTruthy();
    expect(tx.pending).toBeInstanceOf(Map);
    expect(() => mgr.beginTransaction()).toThrow(/already active/);
    mgr.rollbackTransaction(tx); // clean up so other tests can begin
  });

  it('registerPendingDiff routes into the active transaction instead of the global map', async () => {
    const { mgr, calls } = buildManager();
    const tx = mgr.beginTransaction();
    await mgr.registerPendingDiff('src/x.ts', 'a', 'b');
    // Inside the transaction, snapshot post is deferred until commit.
    expect(calls.snapshots).toHaveLength(0);
    // getPendingDiff sees the in-transaction entry.
    expect(mgr.getPendingDiff('src/x.ts')?.updated).toBe('b');
    mgr.rollbackTransaction(tx);
  });

  it('commitTransaction merges transaction entries into pendingDiffs AND posts snapshots', async () => {
    const { mgr, calls } = buildManager();
    const tx = mgr.beginTransaction();
    await mgr.registerPendingDiff('src/a.ts', '', 'a');
    await mgr.registerPendingDiff('src/b.ts', '', 'b');
    expect(calls.snapshots).toHaveLength(0);
    await mgr.commitTransaction(tx);
    expect(calls.snapshots).toHaveLength(2);
    expect(calls.snapshots.map((s) => s.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    // Post-commit, the global map has the entries.
    expect(mgr.getPendingDiff('src/a.ts')?.updated).toBe('a');
    // Future begin should succeed (transaction closed).
    const tx2 = mgr.beginTransaction();
    mgr.rollbackTransaction(tx2);
  });

  it('rollbackTransaction discards the transaction\'s computed entry and posts NO snapshots', async () => {
    // Subtle contract: registerPendingDiff writes a pre-compute STUB
    // (input fields only, no diff/summary/changed) into the global
    // pendingDiffs map even when a transaction is active. The diff
    // computation result routes into the transaction's map. On
    // rollback, the transaction map is cleared but the pre-compute
    // stub remains in the global map. So getPendingDiff returns the
    // input fields without the computed diff data. This is the actual
    // behavior — pinning it so a refactor doesn't quietly change the
    // routing semantics. Not great UX (the stub could mislead a
    // consumer) but no caller has hit it as a bug yet.
    const { mgr, calls } = buildManager();
    const tx = mgr.beginTransaction();
    await mgr.registerPendingDiff('src/discarded.ts', '', 'never-applied');
    mgr.rollbackTransaction(tx);
    expect(calls.snapshots).toHaveLength(0);
    const stub = mgr.getPendingDiff('src/discarded.ts');
    expect(stub).toBeDefined();
    // The pre-compute stub has the inputs but NO diff data — proving
    // the rollback at least kept the computed diff from leaking.
    expect(stub?.updated).toBe('never-applied');
    expect(stub?.diff).toBeUndefined();
    expect(stub?.summary).toBeUndefined();
    expect(stub?.changed).toBeUndefined();
  });

  it('applyInTransaction with a stale tx id throws (defends against tx reuse after commit)', async () => {
    const { mgr } = buildManager();
    const tx = mgr.beginTransaction();
    await mgr.commitTransaction(tx);
    const stale: PendingDiff = { original: 'x', updated: 'y' };
    expect(() => mgr.applyInTransaction(tx, 'src/foo.ts', stale)).toThrow(/mismatch/);
  });

  it('commitTransaction with a stale tx id is a silent no-op (don\'t throw on dup-commit retries)', async () => {
    const { mgr } = buildManager();
    const tx = mgr.beginTransaction();
    await mgr.commitTransaction(tx);
    // Second commit on the same tx — must not throw and must not double-post.
    await expect(mgr.commitTransaction(tx)).resolves.toBeUndefined();
  });
});

describe('createDiffManager — clear()', () => {
  it('wipes pendingDiffs', async () => {
    const { mgr } = buildManager();
    await mgr.registerPendingDiff('src/a.ts', '', 'a');
    mgr.clear();
    expect(mgr.getPendingDiff('src/a.ts')).toBeUndefined();
  });

  it('cancels an active transaction so a fresh beginTransaction succeeds', async () => {
    const { mgr } = buildManager();
    mgr.beginTransaction();
    mgr.clear();
    // After clear, a new transaction can start without throwing "already active".
    expect(() => mgr.beginTransaction()).not.toThrow();
  });
});

describe('createDiffManager — snapshot history', () => {
  it('recordSnapshot pushes onto the history and hasSnapshots / getSnapshotCount reflect it', () => {
    const { mgr } = buildManager();
    expect(mgr.hasSnapshots()).toBe(false);
    mgr.recordSnapshot(buildSnapshot('a.ts'));
    mgr.recordSnapshot(buildSnapshot('b.ts'));
    expect(mgr.hasSnapshots()).toBe(true);
    expect(mgr.getSnapshotCount()).toBe(2);
  });

  it('popSnapshot returns the most-recent snapshot LIFO order', () => {
    const { mgr } = buildManager();
    mgr.recordSnapshot(buildSnapshot('first.ts'));
    mgr.recordSnapshot(buildSnapshot('second.ts'));
    expect(mgr.popSnapshot()?.path).toBe('second.ts');
    expect(mgr.popSnapshot()?.path).toBe('first.ts');
    expect(mgr.popSnapshot()).toBeUndefined();
  });

  it('caps snapshot history at 25 entries (oldest shifted off)', () => {
    const { mgr } = buildManager();
    for (let i = 0; i < 30; i++) {
      mgr.recordSnapshot(buildSnapshot(`file${i}.ts`));
    }
    expect(mgr.getSnapshotCount()).toBe(25);
    // Oldest 5 are gone — popping should yield file29 down to file5.
    expect(mgr.popSnapshot()?.path).toBe('file29.ts');
  });

  it('silently drops snapshots with missing path or absolutePath (defensive — never grow history with garbage)', () => {
    const { mgr } = buildManager();
    mgr.recordSnapshot(buildSnapshot('', { absolutePath: '/abs/whatever' }));
    mgr.recordSnapshot({ ...buildSnapshot('ok'), absolutePath: '' });
    expect(mgr.getSnapshotCount()).toBe(0);
  });
});

describe('createDiffManager — review mode + diff stream', () => {
  it('review mode defaults to OFF', () => {
    const { mgr } = buildManager();
    expect(mgr.isReviewModeEnabled()).toBe(false);
  });

  it('enableReviewMode / isReviewModeEnabled round-trip', () => {
    const { mgr } = buildManager();
    mgr.enableReviewMode(true);
    expect(mgr.isReviewModeEnabled()).toBe(true);
    mgr.enableReviewMode(false);
    expect(mgr.isReviewModeEnabled()).toBe(false);
  });

  it('postDiffStream is a no-op when review mode is OFF', async () => {
    const { mgr, calls } = buildManager();
    await mgr.postDiffStream({ path: 'src/x.ts', kind: 'progress', content: 'streaming' });
    expect(calls.streams).toHaveLength(0);
  });

  it('postDiffStream forwards to the host transport when review mode is ON', async () => {
    const { mgr, calls } = buildManager();
    mgr.enableReviewMode(true);
    await mgr.postDiffStream({ path: 'src/x.ts', kind: 'start' });
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0]).toEqual({ path: 'src/x.ts', kind: 'start' });
  });

  it('throttles `progress` updates to one per 120ms per path (per-path throttle, not global)', async () => {
    const { mgr, calls } = buildManager();
    mgr.enableReviewMode(true);
    await mgr.postDiffStream({ path: 'a.ts', kind: 'progress', content: '1' });
    // Same-path immediate follow-up is throttled out.
    await mgr.postDiffStream({ path: 'a.ts', kind: 'progress', content: '2' });
    // DIFFERENT path is not throttled — its own clock starts fresh.
    await mgr.postDiffStream({ path: 'b.ts', kind: 'progress', content: '3' });
    expect(calls.streams.map((s) => s.content)).toEqual(['1', '3']);
  });

  it('does NOT throttle `start` or `complete` updates (only `progress`)', async () => {
    const { mgr, calls } = buildManager();
    mgr.enableReviewMode(true);
    await mgr.postDiffStream({ path: 'a.ts', kind: 'start' });
    await mgr.postDiffStream({ path: 'a.ts', kind: 'start' });
    await mgr.postDiffStream({ path: 'a.ts', kind: 'complete' });
    expect(calls.streams).toHaveLength(3);
  });
});
