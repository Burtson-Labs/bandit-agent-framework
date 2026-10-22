/**
 * How each prompt the user sent ended, for the webview's message queue.
 *
 * The webview queues messages typed while a turn runs and sends the next
 * one when the turn before it ends — but only if that turn finished. A turn
 * that failed, was cancelled (Stop, a new conversation), or never started
 * (no API key, too big for the context window) stops the queue, and the
 * webview puts what was waiting back in the composer unsent.
 *
 * The busy flag alone can't tell those apart, so the provider records what
 * happens during each prompt here and posts `promptSettled` with the
 * outcome when it returns. The last settled turn and the running one also
 * ride on the state snapshot, so a webview that reloaded mid-turn (the view
 * is not retained while hidden) can pick its queue back up.
 *
 * Several prompts can overlap (a remote-control turn arriving mid-turn);
 * a failure or cancel is recorded on every prompt running at the time.
 */

export type PromptTurnOutcome = 'done' | 'cancelled' | 'failed' | 'refused';

export interface SettledPromptTurn {
  /** The webview's id for the prompt; absent for turns it did not send. */
  turnId?: string;
  outcome: PromptTurnOutcome;
}

interface ActiveTurn {
  turnId?: string;
  started: boolean;
  failed: boolean;
  cancelled: boolean;
}

export class PromptTurnTracker {
  private readonly active = new Set<ActiveTurn>();
  private lastSettled: SettledPromptTurn | null = null;

  /** A prompt starts. Returns the handle `settle` takes. */
  begin(turnId?: string): object {
    const turn: ActiveTurn = { turnId, started: false, failed: false, cancelled: false };
    this.active.add(turn);
    return turn;
  }

  /** The agent went busy: the prompts running now got as far as a turn. */
  noteBusy(): void {
    for (const turn of this.active) {turn.started = true;}
  }

  /** An error reached the user (`error`, `rateLimited`). */
  noteFailed(): void {
    for (const turn of this.active) {turn.failed = true;}
  }

  /** Stop, or the conversation was reset under the running turn. */
  noteCancelled(): void {
    for (const turn of this.active) {turn.cancelled = true;}
  }

  /** The prompt returned (or threw: pass `threw`). */
  settle(handle: object, threw = false): SettledPromptTurn {
    const turn = handle as ActiveTurn;
    this.active.delete(turn);
    const outcome: PromptTurnOutcome = turn.cancelled
      ? 'cancelled'
      : turn.failed || threw
        ? 'failed'
        : turn.started
          ? 'done'
          : 'refused';
    const settled: SettledPromptTurn = turn.turnId ? { turnId: turn.turnId, outcome } : { outcome };
    if (turn.turnId) {this.lastSettled = settled;}
    return settled;
  }

  /** The webview-sent prompt still running, if any (newest first). */
  get activeTurnId(): string | null {
    let id: string | null = null;
    for (const turn of this.active) {
      if (turn.turnId) {id = turn.turnId;}
    }
    return id;
  }

  /** The last webview-sent prompt that ended, and how. */
  get lastSettledTurn(): SettledPromptTurn | null {
    return this.lastSettled;
  }
}
