/**
 * Contract tests for createTaskQueue — sequential FIFO with retry
 * and exponential backoff. Used by goal-runner / background-subagent
 * paths for serialized work that mustn't interleave (write quotas,
 * provider rate limits, etc.). Concurrency bugs in this primitive
 * would surface as "tools fired out of order" or "duplicate writes."
 *
 * Pinned contracts:
 * - Tasks run sequentially, never in parallel
 * - FIFO by default (enqueue → tail); prepend → head
 * - maxRetries with 2^n * baseDelay backoff
 * - cancelPending rejects ALL queued tasks with `Task cancelled`,
 * but does NOT interrupt the currently-running task
 * - getSize counts queued items (running task is shifted off
 * before its promise resolves)
 * - Errors that exceed maxRetries reject the caller's promise
 */
import { describe, expect, it } from 'vitest';
import { createTaskQueue } from '../src/runtime/taskQueue';

describe('createTaskQueue', () => {
  it('runs a single task and resolves with its return value', async () => {
    const q = createTaskQueue();
    const result = await q.enqueue({ id: 't1', run: async () => 'hello' });
    expect(result).toBe('hello');
  });

  it('runs tasks sequentially, never in parallel (FIFO order)', async () => {
    const q = createTaskQueue();
    const order: string[] = [];
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const p1 = q.enqueue({
      id: 'slow',
      async run() { await wait(30); order.push('slow'); return 1; }
    });
    const p2 = q.enqueue({
      id: 'fast',
      async run() { order.push('fast'); return 2; }
    });
    await Promise.all([p1, p2]);
    // If they ran in parallel, "fast" would finish first.
    expect(order).toEqual(['slow', 'fast']);
  });

  // fixed the prepend race. These tests pin the new
  // contract: prepend during an in-flight task lands at the head of
  // the queue and runs BEFORE later-enqueued tasks once the running
  // one finishes.
  it('prepend() puts the task at the head of the queue (runs before later-enqueued tasks even during an in-flight run)', async () => {
    const q = createTaskQueue();
    const order: string[] = [];
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const blockingTask = q.enqueue({
      id: 'block',
      async run() { await wait(20); order.push('block'); return 'b'; }
    });
    const enqueued = q.enqueue({ id: 'tail', async run() { order.push('tail'); return 't'; } });
    const prepended = q.prepend({ id: 'head', async run() { order.push('head'); return 'h'; } });
    await Promise.all([blockingTask, enqueued, prepended]);
    // After the blocking task finishes, prepend (which was inserted
    // at queue[0] during the await) runs next, THEN the originally-
    // enqueued tail task.
    expect(order).toEqual(['block', 'head', 'tail']);
  });

  it('prepend() resolves the caller\'s promise with the task\'s return value', async () => {
    const q = createTaskQueue();
    const result = await q.prepend({ id: 'p1', async run() { return 'prepended-value'; } });
    expect(result).toBe('prepended-value');
  });

  it('rejects the caller\'s promise when a task throws and retries are exhausted', async () => {
    const q = createTaskQueue();
    await expect(
      q.enqueue({ id: 'doom', run: async () => { throw new Error('fail'); } })
    ).rejects.toThrow('fail');
  });

  it('retries on failure up to maxRetries before giving up (custom maxRetries)', async () => {
    const q = createTaskQueue();
    let attempts = 0;
    const result = await q.enqueue(
      {
        id: 'flaky',
        async run() {
          attempts += 1;
          if (attempts < 3) throw new Error('not yet');
          return 'ok';
        }
      },
      { maxRetries: 5, baseDelayMs: 0 }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('rejects after exhausting retries with the LAST error', async () => {
    const q = createTaskQueue();
    let attempts = 0;
    await expect(
      q.enqueue(
        {
          id: 'doomed',
          async run() {
            attempts += 1;
            throw new Error(`attempt ${attempts}`);
          }
        },
        { maxRetries: 2, baseDelayMs: 0 }
      )
    ).rejects.toThrow(/attempt 3/);
    // Initial run + 2 retries = 3 total attempts.
    expect(attempts).toBe(3);
  });

  it('default maxRetries is 0 (one attempt, no retry, fail-fast)', async () => {
    const q = createTaskQueue();
    let attempts = 0;
    await expect(
      q.enqueue({
        id: 'one-shot',
        async run() { attempts += 1; throw new Error('boom'); }
      })
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
  });

  it('options.maxRetries on a per-task call overrides the default passed at construction', async () => {
    const q = createTaskQueue({ maxRetries: 5 });
    let attempts = 0;
    await expect(
      q.enqueue(
        { id: 'one', async run() { attempts += 1; throw new Error('x'); } },
        { maxRetries: 0 }
      )
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('cancelPending rejects QUEUED tasks but lets the in-flight task complete normally', async () => {
    // contract change: the running task is tracked
    // separately from the queue, so cancelPending only operates on
    // pending work. The in-flight task's run() continues, and its
    // caller-facing promise resolves with the real result. The old
    // shape (single queue with the runner holding queue[0]) silently
    // rejected the running task's caller while its work still wrote
    // side effects — a footgun.
    const q = createTaskQueue();
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const running = q.enqueue({ id: 'long', async run() { await wait(30); return 'done'; } });
    const queued1 = q.enqueue({ id: 'q1', async run() { return 1; } });
    const queued2 = q.enqueue({ id: 'q2', async run() { return 2; } });

    q.cancelPending();

    await expect(queued1).rejects.toThrow('Task cancelled');
    await expect(queued2).rejects.toThrow('Task cancelled');
    await expect(running).resolves.toBe('done');
  });

  it('getSize() counts pending tasks (excludes the running one)', async () => {
    const q = createTaskQueue();
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const running = q.enqueue({ id: 'long', async run() { await wait(20); return 1; } });
    q.enqueue({ id: 'q1', async run() { return 2; } });
    q.enqueue({ id: 'q2', async run() { return 3; } });
    // running task is tracked separately from the queue,
    // so getSize() now reports purely-pending count. With one task
    // running and two queued, getSize() returns 2 (NOT 3 — the running
    // one isn't in the queue anymore). This is what callers always
    // intuitively wanted: "how many tasks are waiting?"
    expect(q.getSize()).toBe(2);
    await running;
    // After running resolves, the next task moves off the queue
    // immediately, so size drops further as work drains.
    expect(q.getSize()).toBeLessThan(2);
  });

  it('a synchronous-throwing run() is treated like a rejected promise (and rejected as such)', async () => {
    const q = createTaskQueue();
    await expect(
      q.enqueue({
        id: 'sync-throw',
        run: (() => { throw new Error('sync boom'); }) as () => Promise<never>
      })
    ).rejects.toThrow('sync boom');
  });

  it('a long sequence of enqueues all run in order', async () => {
    const q = createTaskQueue();
    const order: number[] = [];
    const promises: Array<Promise<number>> = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        q.enqueue({
          id: `t${i}`,
          async run() { order.push(i); return i; }
        })
      );
    }
    const results = await Promise.all(promises);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
