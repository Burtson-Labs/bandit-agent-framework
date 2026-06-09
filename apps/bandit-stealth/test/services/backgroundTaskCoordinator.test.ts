/**
 * Contract tests for `BackgroundTaskCoordinator` — the mid-turn
 * injection queue for background-subagent completions.
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) `enqueue()` translates each terminal status into the right
 *     synopsis body and marks the source record consumed,
 * (2) `drainCompletions()` prepends a single preamble block listing
 *     every ready completion to the user's goal, marks each one
 *     consumed, and leaves running / already-consumed records alone,
 * (3) `dismiss()` flips consumed + re-broadcasts the record so the
 *     webview tile re-renders.
 *
 * The store is a hand-rolled minimum-viable fake — `InMemoryBackgroundTaskStore`
 * from host-kit would also work but its API surface is bigger than
 * what we need to assert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackgroundTaskRecord } from '@burtson-labs/host-kit';
import type { ProviderContext } from '../../src/provider/context';

vi.mock('vscode', () => ({}));

import { BackgroundTaskCoordinator } from '../../src/provider/services/backgroundTaskCoordinator';

function makeRecord(overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  return {
    id: 'bg-1',
    goal: 'investigate the latency regression',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_012_300,
    iterations: 4,
    synopsis: 'p99 jumped after the cache TTL change',
    consumed: false,
    ...overrides
  } as BackgroundTaskRecord;
}

type FakeStore = {
  records: Map<string, BackgroundTaskRecord>;
  cancelCalls: string[];
  list: () => BackgroundTaskRecord[];
  markConsumed: (id: string) => void;
  get: (id: string) => BackgroundTaskRecord | undefined;
  cancel: (id: string) => void;
  // unused but required by the type
  on: (...args: unknown[]) => void;
};

function makeFakeStore(initial: BackgroundTaskRecord[] = []): FakeStore {
  const records = new Map<string, BackgroundTaskRecord>(initial.map((r) => [r.id, r]));
  const cancelCalls: string[] = [];
  return {
    records,
    cancelCalls,
    list: () => Array.from(records.values()),
    markConsumed: (id: string) => {
      const r = records.get(id);
      if (r) r.consumed = true;
    },
    get: (id: string) => records.get(id),
    cancel: (id: string) => { cancelCalls.push(id); },
    on: () => undefined
  };
}

function makeCtx(store: FakeStore): { ctx: ProviderContext; posted: Array<Record<string, unknown>> } {
  const posted: Array<Record<string, unknown>> = [];
  const ctx = {
    background: store,
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); }
  } as unknown as ProviderContext;
  return { ctx, posted };
}

beforeEach(() => {
  // each test owns its own store + ctx; nothing global to reset.
});

describe('BackgroundTaskCoordinator', () => {
  it('enqueue() formats completed/failed/cancelled bodies and marks the record consumed', () => {
    const completed = makeRecord({ id: 'bg-ok' });
    const failed = makeRecord({ id: 'bg-fail', status: 'failed', error: 'boom', synopsis: undefined });
    const cancelled = makeRecord({ id: 'bg-cxl', status: 'cancelled', synopsis: undefined });
    const store = makeFakeStore([completed, failed, cancelled]);
    const { ctx } = makeCtx(store);
    const svc = new BackgroundTaskCoordinator(ctx);

    svc.enqueue(completed);
    svc.enqueue(failed);
    svc.enqueue(cancelled);
    expect(svc.pendingInjectionCount).toBe(3);

    const messages = svc.drainPendingMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toContain('Background task');
    expect(messages[0].content).toContain('completed in');
    expect(messages[0].content).toContain('p99 jumped');
    expect(messages[1].content).toContain('FAILED');
    expect(messages[1].content).toContain('Error: boom');
    expect(messages[2].content).toContain('cancelled');

    // After enqueue every source record must be marked consumed so the
    // per-turn drain doesn't double-surface the same synopsis.
    expect(completed.consumed).toBe(true);
    expect(failed.consumed).toBe(true);
    expect(cancelled.consumed).toBe(true);

    // drainPendingMessages clears the queue.
    expect(svc.pendingInjectionCount).toBe(0);
    expect(svc.drainPendingMessages()).toHaveLength(0);

    // enqueue is a no-op on records already marked consumed (covers
    // a race-driven double-fire of a lifecycle event).
    svc.enqueue(completed);
    expect(svc.pendingInjectionCount).toBe(0);
  });

  it('drainCompletions() prepends ready tasks to the goal, marks them consumed, skips running and already-consumed', () => {
    const readyDone = makeRecord({ id: 'bg-r1' });
    const readyFail = makeRecord({ id: 'bg-r2', status: 'failed', error: 'oom', synopsis: undefined });
    const running = makeRecord({ id: 'bg-run', status: 'running', synopsis: undefined });
    const stale = makeRecord({ id: 'bg-old', consumed: true });
    const store = makeFakeStore([readyDone, readyFail, running, stale]);
    const { ctx } = makeCtx(store);
    const svc = new BackgroundTaskCoordinator(ctx);

    const augmented = svc.drainCompletions('please continue the task');
    expect(augmented).toContain('[Background tasks completed since last turn]');
    expect(augmented).toContain('bg-r1');
    expect(augmented).toContain('bg-r2');
    expect(augmented).toContain('error: oom');
    expect(augmented).toContain('p99 jumped');
    expect(augmented.endsWith('please continue the task')).toBe(true);
    // Running task must not appear (not terminal). Already-consumed
    // task must not appear (already shown).
    expect(augmented).not.toContain('bg-run');
    expect(augmented).not.toContain('bg-old');

    // The two ready records are now consumed.
    expect(readyDone.consumed).toBe(true);
    expect(readyFail.consumed).toBe(true);
    // Running and stale are untouched.
    expect(running.consumed).toBe(false);
    expect(stale.consumed).toBe(true);

    // Second call with nothing ready returns the goal unchanged.
    expect(svc.drainCompletions('next turn')).toBe('next turn');
  });

  it('dismiss() marks the record consumed and posts a backgroundTaskUpdate', () => {
    const record = makeRecord({ id: 'bg-dismiss' });
    const store = makeFakeStore([record]);
    const { ctx, posted } = makeCtx(store);
    const svc = new BackgroundTaskCoordinator(ctx);

    svc.dismiss('bg-dismiss');
    expect(record.consumed).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'backgroundTaskUpdate' });
    expect((posted[0] as { task: BackgroundTaskRecord }).task.id).toBe('bg-dismiss');

    // dismiss() for an unknown id marks (no-op on missing) and skips
    // the broadcast.
    svc.dismiss('bg-not-found');
    expect(posted).toHaveLength(1);

    // cancel() delegates to the store.
    svc.cancel('bg-dismiss');
    expect(store.cancelCalls).toEqual(['bg-dismiss']);
  });
});
