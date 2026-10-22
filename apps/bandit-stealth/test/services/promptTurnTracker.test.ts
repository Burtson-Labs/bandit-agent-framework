/**
 * Contract tests for `PromptTurnTracker` — how each prompt ended, which
 * the webview's message queue uses to decide whether the next queued
 * message may run (only after `done`).
 */
import { describe, expect, it } from 'vitest';
import { PromptTurnTracker } from '../../src/provider/services/promptTurnTracker';

describe('PromptTurnTracker', () => {
  it('a prompt that went busy and returned is done', () => {
    const t = new PromptTurnTracker();
    const h = t.begin('turn-1');
    expect(t.activeTurnId).toBe('turn-1');
    t.noteBusy();
    expect(t.settle(h)).toEqual({ turnId: 'turn-1', outcome: 'done' });
    expect(t.activeTurnId).toBeNull();
    expect(t.lastSettledTurn).toEqual({ turnId: 'turn-1', outcome: 'done' });
  });

  it('a prompt that never went busy was refused (no key, too large)', () => {
    const t = new PromptTurnTracker();
    expect(t.settle(t.begin('turn-1')).outcome).toBe('refused');
  });

  it('an error the user saw, or a throw, is failed', () => {
    const t = new PromptTurnTracker();
    const a = t.begin('a');
    t.noteBusy();
    t.noteFailed();
    expect(t.settle(a).outcome).toBe('failed');
    const b = t.begin('b');
    t.noteBusy();
    expect(t.settle(b, true).outcome).toBe('failed');
  });

  it('cancel wins over the error the abort produced', () => {
    const t = new PromptTurnTracker();
    const h = t.begin('turn-1');
    t.noteBusy();
    t.noteCancelled();
    t.noteFailed();
    expect(t.settle(h).outcome).toBe('cancelled');
  });

  it('notes outside a prompt change nothing for the next one', () => {
    const t = new PromptTurnTracker();
    t.noteFailed();
    t.noteCancelled();
    const h = t.begin('turn-1');
    t.noteBusy();
    expect(t.settle(h).outcome).toBe('done');
  });

  it('turns the webview did not send settle without an id and leave lastSettledTurn alone', () => {
    const t = new PromptTurnTracker();
    const mine = t.begin('mine');
    t.noteBusy();
    t.settle(mine);
    const remote = t.begin();
    t.noteBusy();
    t.noteFailed();
    expect(t.settle(remote)).toEqual({ outcome: 'failed' });
    expect(t.lastSettledTurn).toEqual({ turnId: 'mine', outcome: 'done' });
  });

  it('a failure lands on every prompt running at the time', () => {
    const t = new PromptTurnTracker();
    const a = t.begin('a');
    const b = t.begin();
    t.noteBusy();
    t.noteFailed();
    expect(t.activeTurnId).toBe('a');
    expect(t.settle(b).outcome).toBe('failed');
    expect(t.settle(a).outcome).toBe('failed');
  });
});
