/**
 * BackgroundTaskStore — host-managed registry of long-running subagent
 * tasks that the parent agent has spawned in the background.
 *
 * Why this exists:
 * The original `task` tool was synchronous from the parent agent's
 * perspective: the parent's tool call awaited the subagent's full run
 * before getting a result. That blocked the entire conversation for
 * however long the subagent took (often minutes on local models). The
 * user couldn't ask follow-ups or change direction mid-investigation.
 *
 * Background tasks fix that. The agent calls `task` with
 * `run_in_background: true`, gets a task id back immediately, and the
 * parent loop continues. When the subagent eventually completes, the
 * host injects a synthetic system message before the next agent turn:
 *
 *   [Background task abc123 completed]
 *   <synopsis>
 *
 * The agent can call `check_task` or `list_tasks` to inspect state on
 * demand, but the auto-injection means it usually doesn't have to.
 *
 * Design notes:
 * - This module only defines the interface + an in-memory implementation.
 *   Hosts that need persistence (cross-session resume, web app sharing
 *   tasks across browser tabs, etc) can ship their own implementation.
 * - Cancellation is cooperative — a cancelled task stops accepting new
 *   tool-result events but the running tool call (if any) finishes
 *   first. Hard kill of a model generation in flight is provider-
 *   specific and out of scope here.
 * - We surface progress as tool-call counts rather than streaming a
 *   live tool log — the live log is high-volume and noisy for the
 *   "how's that task going" status check the agent actually wants.
 */

import { EventEmitter } from 'node:events';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTaskRecord {
  id: string;
  goal: string;
  status: BackgroundTaskStatus;
  /** Wall-clock when the task was spawned. */
  startedAt: number;
  /** Wall-clock when the task reached a terminal state. Undefined while running. */
  endedAt?: number;
  /** Subagent iteration count at last update. */
  iterations: number;
  /** Number of tool calls the subagent has made so far. */
  toolCalls: number;
  /** Last tool name the subagent called — handy for status display. */
  lastTool?: string;
  /** Final synopsis when status === 'completed'. */
  synopsis?: string;
  /** Error message when status === 'failed'. */
  error?: string;
  /** True after the parent agent has consumed the completion event
   *  (via auto-injection or check_task). Lets the host stop showing the
   *  task in the "needs attention" UI section. */
  consumed: boolean;
}

export interface BackgroundTaskProgress {
  iterations?: number;
  toolCalls?: number;
  lastTool?: string;
}

export interface BackgroundTaskStore {
  /**
   * Register a newly-spawned task. The store assigns and returns the id.
   * The host is expected to actually run the subagent — this method
   * just records the record and emits a `start` event.
   */
  start(goal: string): string;
  /** Update progress fields on an in-flight task. No-op if id unknown. */
  progress(id: string, progress: BackgroundTaskProgress): void;
  /** Mark the task completed with its final synopsis. */
  complete(id: string, synopsis: string): void;
  /** Mark the task failed with an error message. */
  fail(id: string, error: string): void;
  /** Mark the task cancelled. The actual subagent kill is the host's
   *  responsibility — this method just flips the status so subsequent
   *  progress events are dropped. */
  cancel(id: string): void;
  /** Get a single task record by id, or undefined. */
  get(id: string): BackgroundTaskRecord | undefined;
  /** All known tasks. Order is start-time ascending. */
  list(): BackgroundTaskRecord[];
  /** Subset filtered by status. Convenience over filtering list(). */
  listByStatus(status: BackgroundTaskStatus): BackgroundTaskRecord[];
  /** Mark a completed/failed/cancelled task as consumed. */
  markConsumed(id: string): void;
  /** Subscribe to task lifecycle events. Returns an unsubscribe fn. */
  on(
    event: 'start' | 'progress' | 'complete' | 'failed' | 'cancelled',
    listener: (record: BackgroundTaskRecord) => void
  ): () => void;
}

/**
 * In-memory store. Per-session, no persistence. Suitable for the CLI
 * and the VS Code extension session lifetime. A web host that wants
 * resume-across-reload can implement the same interface backed by
 * IndexedDB or a server endpoint.
 */
export class InMemoryBackgroundTaskStore implements BackgroundTaskStore {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly emitter = new EventEmitter();
  private idCounter = 0;

  start(goal: string): string {
    // Short, human-readable id. We don't need uniqueness across hosts;
    // collisions inside a single CLI/extension session would require
    // ~thousands of subagents which isn't the workload.
    this.idCounter += 1;
    const id = `bg${Date.now().toString(36)}${this.idCounter.toString(36)}`;
    const record: BackgroundTaskRecord = {
      id,
      goal,
      status: 'running',
      startedAt: Date.now(),
      iterations: 0,
      toolCalls: 0,
      consumed: false
    };
    this.tasks.set(id, record);
    this.emitter.emit('start', record);
    return id;
  }

  progress(id: string, progress: BackgroundTaskProgress): void {
    const record = this.tasks.get(id);
    if (!record) return;
    if (record.status !== 'running') return;
    if (typeof progress.iterations === 'number') record.iterations = progress.iterations;
    if (typeof progress.toolCalls === 'number') record.toolCalls = progress.toolCalls;
    if (typeof progress.lastTool === 'string') record.lastTool = progress.lastTool;
    this.emitter.emit('progress', record);
  }

  complete(id: string, synopsis: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    if (record.status !== 'running') return;
    record.status = 'completed';
    record.endedAt = Date.now();
    record.synopsis = synopsis;
    this.emitter.emit('complete', record);
  }

  fail(id: string, error: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    if (record.status !== 'running') return;
    record.status = 'failed';
    record.endedAt = Date.now();
    record.error = error;
    this.emitter.emit('failed', record);
  }

  cancel(id: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    if (record.status !== 'running') return;
    record.status = 'cancelled';
    record.endedAt = Date.now();
    this.emitter.emit('cancelled', record);
  }

  get(id: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  listByStatus(status: BackgroundTaskStatus): BackgroundTaskRecord[] {
    return this.list().filter((r) => r.status === status);
  }

  markConsumed(id: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    record.consumed = true;
  }

  on(
    event: 'start' | 'progress' | 'complete' | 'failed' | 'cancelled',
    listener: (record: BackgroundTaskRecord) => void
  ): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }
}
