export interface TaskQueueTask<T = unknown> {
  id: string;
  run(): Promise<T>;
}

export interface TaskQueueOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface TaskQueue {
  enqueue<T>(task: TaskQueueTask<T>, options?: TaskQueueOptions): Promise<T>;
  prepend<T>(task: TaskQueueTask<T>, options?: TaskQueueOptions): Promise<T>;
  cancelPending(): void;
  getSize(): number;
}

const defaultBaseDelay = 1000;

export function createTaskQueue(defaults?: TaskQueueOptions): TaskQueue {
  type PendingTask<T> = {
    task: TaskQueueTask<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
    attempt: number;
    maxRetries: number;
    baseDelayMs: number;
  };

  // _runningTask is tracked separately from queue so
  // prepend()/cancelPending() operate on PENDING work only. The
  // previous shape (single queue with the runner holding queue[0])
  // had a race: prepending during an in-flight task would `unshift`
  // onto the queue, then the runner's later `queue.shift()` would
  // remove the prepended item instead of the running one, dropping
  // the prepended caller's promise on the floor. Separating the
  // running slot from the queue makes both operations safe.
  const queue: PendingTask<unknown>[] = [];
  let _runningTask: PendingTask<unknown> | undefined;
  let processing = false;

  async function processQueue(): Promise<void> {
    if (processing) {
      return;
    }
    processing = true;
    while (queue.length > 0) {
      const next = queue.shift()!;
      _runningTask = next;
      try {
        const result = await next.task.run();
        next.resolve(result);
        _runningTask = undefined;
      } catch (error) {
        if (next.attempt >= next.maxRetries) {
          next.reject(error);
          _runningTask = undefined;
        } else {
          next.attempt += 1;
          const delay = next.baseDelayMs * Math.pow(2, next.attempt - 1);
          // Put the task BACK at the head so retries happen in place
          // before any newly-enqueued tasks. unshift on a queue that
          // doesn't include the running slot is now safe — the loop
          // will pick it up next iteration via queue.shift().
          queue.unshift(next);
          _runningTask = undefined;
          await delayMs(delay);
        }
      }
    }
    processing = false;
  }

  function schedule<T>(
    task: TaskQueueTask<T>,
    options: TaskQueueOptions | undefined,
    strategy: 'enqueue' | 'prepend'
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask<T> = {
        task,
        resolve,
        reject,
        attempt: 0,
        maxRetries: options?.maxRetries ?? defaults?.maxRetries ?? 0,
        baseDelayMs: options?.baseDelayMs ?? defaults?.baseDelayMs ?? defaultBaseDelay
      };
      if (strategy === 'prepend') {
        queue.unshift(pending as PendingTask<unknown>);
      } else {
        queue.push(pending as PendingTask<unknown>);
      }
      void processQueue();
    });
  }

  function enqueue<T>(task: TaskQueueTask<T>, options?: TaskQueueOptions): Promise<T> {
    return schedule(task, options, 'enqueue');
  }

  function prepend<T>(task: TaskQueueTask<T>, options?: TaskQueueOptions): Promise<T> {
    return schedule(task, options, 'prepend');
  }

  function cancelPending(): void {
    // only cancels QUEUED tasks. The currently-running
    // task is not interrupted; its run() finishes and the caller's
    // promise resolves normally. Previously the running task lived
    // in the queue too, so cancelPending rejected the running task's
    // promise even though its work would still complete and write
    // side effects.
    while (queue.length > 0) {
      const item = queue.shift();
      item?.reject(new Error('Task cancelled'));
    }
  }

  function getSize(): number {
    // Queued pending count. Excludes the currently-running task
    // (matches the caller intuition — callers were
    // already using getSize() as "how many are waiting").
    return queue.length;
  }

  return { enqueue, prepend, cancelPending, getSize };
}

function delayMs(duration: number): Promise<void> {
  if (duration <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}
