/**
 * `BackgroundTaskCoordinator` owns the mid-turn injection mechanic
 * for background-subagent completions. When a detached `task` tool
 * finishes (or fails / is cancelled) WHILE the parent agent loop is
 * still iterating, its synopsis gets pushed here. The agent loop's
 * `drainExternalMessages` callback empties the queue at the start of
 * each iteration so the parent sees subagent results AS THEY ARRIVE
 * instead of poll-spinning on `check_task`. The CLI mirrors this in
 * `cli.ts`.
 *
 * Also owns the per-turn drain that fires at turn start: ANY ready
 * background completion (regardless of when it landed since the last
 * user prompt) gets prepended to the user's goal as an inline
 * `[Background tasks completed since last turn]` summary so the
 * model reads the synopses as part of its own context window.
 *
 * Webview bridge methods (`cancel`, `dismiss`) handle the user-side
 * controls on the background-task tile in the chat panel.
 */
import type { ToolLoopMessage } from '@burtson-labs/agent-core';
import type { BackgroundTaskRecord } from '@burtson-labs/host-kit';
import type { ProviderContext } from '../context';

export class BackgroundTaskCoordinator {
  private readonly injections: ToolLoopMessage[] = [];

  constructor(private readonly ctx: ProviderContext) {}

  /** Mid-turn arrival queue depth — primarily used by tests. */
  get pendingInjectionCount(): number {
    return this.injections.length;
  }

  /**
   * Push a completed/failed/cancelled background task's synopsis
   * into the mid-turn injection queue and mark the record consumed
   * so the next per-turn drain skips it. Called from the
   * `background.on('complete'|'failed'|'cancelled')` subscribers in
   * the provider's constructor.
   *
   * No-ops on records already marked consumed (race-safe against a
   * race-driven double-fire) and on any unknown status.
   */
  enqueue(record: BackgroundTaskRecord): void {
    if (record.consumed) {return;}
    const seconds = ((record.endedAt ?? Date.now()) - record.startedAt) / 1000;
    const title = record.goal.length > 60 ? record.goal.slice(0, 57).trim() + '…' : record.goal;
    let body: string;
    if (record.status === 'completed') {
      body = `[Background task "${title}" completed in ${seconds.toFixed(1)}s, ${record.iterations} iter]\n${record.synopsis ?? '(no synopsis)'}`;
    } else if (record.status === 'failed') {
      body = `[Background task "${title}" FAILED after ${seconds.toFixed(1)}s, ${record.iterations} iter]\nError: ${record.error ?? 'unknown error'}\n\nDecide whether to retry this scope, work around it, or proceed without that subagent's findings.`;
    } else if (record.status === 'cancelled') {
      body = `[Background task "${title}" cancelled after ${seconds.toFixed(1)}s, ${record.iterations} iter]`;
    } else {
      return;
    }
    this.injections.push({ role: 'user', content: body });
    this.ctx.background.markConsumed(record.id);
  }

  /**
   * Per-turn drain — pull every completed/failed/cancelled background-
   * subagent task that the agent hasn't seen yet, mark them consumed,
   * and prepend their synopses to the user's goal as a synthetic
   * preamble. Same shape the CLI uses, so the agent reads:
   *
   *   [Background tasks completed since last turn]
   *   - bg123 · completed (12.3s, 4 iter): <synopsis>
   *
   *   <original user goal>
   *
   * Returns the original goal unchanged when no completions are
   * pending — the common case mid-conversation.
   */
  drainCompletions(userGoal: string): string {
    const ready = this.ctx.background.list().filter((t) => !t.consumed && t.status !== 'running');
    if (ready.length === 0) {return userGoal;}
    const lines: string[] = ['[Background tasks completed since last turn]'];
    for (const t of ready) {
      const seconds = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
      const head = `- ${t.id} · ${t.status} (${seconds.toFixed(1)}s, ${t.iterations} iter) · "${t.goal.slice(0, 80)}${t.goal.length > 80 ? '…' : ''}"`;
      if (t.status === 'completed' && t.synopsis) {
        lines.push(`${head}\n${t.synopsis}`);
      } else if (t.status === 'failed' && t.error) {
        lines.push(`${head}\n  error: ${t.error}`);
      } else {
        lines.push(head);
      }
      this.ctx.background.markConsumed(t.id);
    }
    return `${lines.join('\n\n')}\n\n${userGoal}`;
  }

  /**
   * Mid-iteration drain — return queued injections and clear them.
   * Wired into `runWithMessages`'s `drainExternalMessages` callback;
   * called by the loop at each iteration boundary so the parent agent
   * sees subagent results without a `check_task` poll.
   */
  drainPendingMessages(): ToolLoopMessage[] {
    if (this.injections.length === 0) {return [];}
    const out = this.injections.slice();
    this.injections.length = 0;
    return out;
  }

  /** Webview bridge — cancel a running task by id. */
  cancel(taskId: string): void {
    this.ctx.background.cancel(taskId);
  }

  /**
   * Webview bridge — user clicked the X on a completed/failed/
   * cancelled task tile. Flip the consumed flag so the visible-filter
   * in the webview tile (and the per-turn drain on the next prompt)
   * both skip it. `markConsumed` itself doesn't emit a store event
   * (it's semantically a host-side ack, not a lifecycle change), so
   * the broadcast has to be explicit here.
   */
  dismiss(taskId: string): void {
    this.ctx.background.markConsumed(taskId);
    const record = this.ctx.background.get(taskId);
    if (record) {this.ctx.postMessage({ type: 'backgroundTaskUpdate', task: record });}
  }
}
