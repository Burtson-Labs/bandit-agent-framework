/**
 * Contract tests for usePromptQueue — the extension chat's message queue
 * wired to the host.
 *
 * Pins:
 * - a send carries a turnId and the next queued prompt waits for that
 *   turn's `promptSettled` (not just the busy flag, which lags the send)
 * - Stop hands the queue back unsent and cancels; a failed / refused /
 *   cancelled turn hands it back too, so nothing runs into the same error
 * - edit takes one prompt back; remove drops one
 * - the queue is saved in the webview state, and the first state snapshot
 *   after a reload re-attaches to the running turn, carries on after a
 *   finished one, or hands the prompts back when the turn is unknown
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePromptQueue, type PromptReturnReason, type QueuedPrompt } from '../../src/hooks/usePromptQueue';
import { mockReceiveMessage } from '../_helpers';

type Sent = { type: string; text?: string; turnId?: string; images?: string[]; files?: string[] };

let calls: Sent[];
let saved: unknown;

function installVscode(initialState?: unknown) {
  calls = [];
  saved = initialState;
  (globalThis as unknown as { vscode: unknown }).vscode = {
    postMessage: (m: Sent) => { calls.push(m); },
    getState: () => saved,
    setState: (s: unknown) => { saved = s; }
  };
}

const msg = (text: string, extra: Partial<{ images: string[]; files: string[] }> = {}) => ({
  text,
  images: extra.images ?? [],
  files: extra.files ?? [],
  autoContext: false
});

const prompts = () => calls.filter((c) => c.type === 'sendPrompt');

async function settle(turnId: string | undefined, outcome: string) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'promptSettled', turnId, outcome } }));
    await Promise.resolve();
  });
}

function setup(initialBusy = false) {
  const onReturn = vi.fn<(items: QueuedPrompt[], reason: PromptReturnReason) => void>();
  const hook = renderHook(({ busy }) => usePromptQueue({ busy, onReturn }), {
    initialProps: { busy: initialBusy }
  });
  return { ...hook, onReturn };
}

beforeEach(() => installVscode());
afterEach(() => cleanup());

describe('usePromptQueue', () => {
  it('sends with a turnId and runs the next queued prompt only once that turn settles done', async () => {
    const { result, rerender } = setup();
    act(() => {
      expect(result.current.submit(msg('first'))).toBe('sent');
      expect(result.current.submit(msg('second', { files: ['src/a.ts'] }))).toBe('queued');
    });
    expect(prompts()).toHaveLength(1);
    const first = prompts()[0];
    expect(first.text).toBe('first');
    expect(typeof first.turnId).toBe('string');

    // The host goes busy and back to idle; until promptSettled arrives the
    // queue keeps waiting.
    rerender({ busy: true });
    rerender({ busy: false });
    expect(prompts()).toHaveLength(1);

    await settle(first.turnId, 'done');
    expect(prompts().map((p) => p.text)).toEqual(['first', 'second']);
    expect(prompts()[1].files).toEqual(['src/a.ts']);
    expect(result.current.items).toEqual([]);
  });

  it.each([
    ['failed', 'failed'],
    ['refused', 'failed'],
    ['cancelled', 'stopped']
  ] as const)('a %s turn hands the queue back (%s) and sends nothing else', async (outcome, reason) => {
    const { result, onReturn } = setup();
    act(() => {
      result.current.submit(msg('first'));
      result.current.submit(msg('second'));
      result.current.submit(msg('third'));
    });
    await settle(prompts()[0].turnId, outcome);
    expect(prompts()).toHaveLength(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReturn.mock.calls[0][0].map((i) => i.text)).toEqual(['second', 'third']);
    expect(onReturn.mock.calls[0][1]).toBe(reason);
  });

  it('Stop hands the queue back at once, cancels, and nothing runs after the turn', async () => {
    const { result, onReturn } = setup();
    act(() => {
      result.current.submit(msg('first'));
      result.current.submit(msg('second'));
    });
    act(() => result.current.stop());
    expect(calls.at(-1)).toEqual({ type: 'cancelResponse' });
    expect(onReturn.mock.calls[0][0].map((i) => i.text)).toEqual(['second']);
    expect(onReturn.mock.calls[0][1]).toBe('stopped');
    await settle(prompts()[0].turnId, 'cancelled');
    expect(prompts()).toHaveLength(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('queues while the host is busy with a turn this view did not send (an open approval)', () => {
    const { result, rerender } = setup(true);
    act(() => {
      expect(result.current.submit(msg('while the card is open'))).toBe('queued');
    });
    expect(prompts()).toHaveLength(0);
    rerender({ busy: false });
    expect(prompts().map((p) => p.text)).toEqual(['while the card is open']);
  });

  it('edit takes one prompt back to the composer; remove drops one', () => {
    const { result, onReturn } = setup();
    act(() => {
      result.current.submit(msg('running'));
      result.current.submit(msg('a'));
      result.current.submit(msg('b'));
    });
    const [a, b] = result.current.items;
    act(() => result.current.edit(b.id));
    expect(onReturn).toHaveBeenCalledWith([expect.objectContaining({ text: 'b' })], 'edit');
    act(() => result.current.remove(a.id));
    expect(result.current.items).toEqual([]);
  });

  it('saves the queue and the in-flight turn in the webview state', () => {
    const { result } = setup();
    act(() => {
      result.current.submit(msg('first'));
      result.current.submit(msg('second'));
    });
    const state = saved as { promptQueue: { items: QueuedPrompt[]; inFlightTurnId: string } };
    expect(state.promptQueue.items.map((i) => i.text)).toEqual(['second']);
    expect(state.promptQueue.inFlightTurnId).toBe(prompts()[0].turnId);
  });

  describe('after a reload', () => {
    const savedQueue = (inFlightTurnId: string | null) => ({
      promptQueue: {
        items: [{ id: 'q1', ...msg('saved one') }, { id: 'q2', ...msg('saved two') }],
        inFlightTurnId
      },
      composerDraft: 'kept'
    });
    const state = (extra: Record<string, unknown>) => ({ type: 'state', state: { messages: [], isBusy: false, ...extra } });

    it('re-attaches to the turn the host is still running, then carries on', async () => {
      installVscode(savedQueue('turn-old'));
      const { result, onReturn } = setup();
      mockReceiveMessage(state({ isBusy: true, activeTurnId: 'turn-old' }));
      expect(result.current.items.map((i) => i.text)).toEqual(['saved one', 'saved two']);
      expect(prompts()).toHaveLength(0);
      await settle('turn-old', 'done');
      expect(prompts().map((p) => p.text)).toEqual(['saved one']);
      expect(onReturn).not.toHaveBeenCalled();
      expect((saved as { composerDraft?: string }).composerDraft).toBe('kept');
    });

    it('carries on when the turn it waited on finished while the view was gone', () => {
      installVscode(savedQueue('turn-old'));
      const { result } = setup();
      mockReceiveMessage(state({ lastSettledTurn: { turnId: 'turn-old', outcome: 'done' } }));
      expect(prompts().map((p) => p.text)).toEqual(['saved one']);
      expect(result.current.items.map((i) => i.text)).toEqual(['saved two']);
    });

    it('hands the prompts back when that turn failed', () => {
      installVscode(savedQueue('turn-old'));
      const { onReturn } = setup();
      mockReceiveMessage(state({ lastSettledTurn: { turnId: 'turn-old', outcome: 'failed' } }));
      expect(prompts()).toHaveLength(0);
      expect(onReturn.mock.calls[0][0].map((i) => i.text)).toEqual(['saved one', 'saved two']);
      expect(onReturn.mock.calls[0][1]).toBe('failed');
    });

    it('hands the prompts back when the host does not know the turn (VS Code reloaded)', () => {
      installVscode(savedQueue('turn-old'));
      const { result, onReturn } = setup();
      mockReceiveMessage(state({ activeTurnId: null, lastSettledTurn: null }));
      expect(prompts()).toHaveLength(0);
      expect(result.current.items).toEqual([]);
      expect(onReturn.mock.calls[0][1]).toBe('reloaded');
      expect((saved as { promptQueue: { items: unknown[] } }).promptQueue.items).toEqual([]);
    });

    it('only the first snapshot restores', () => {
      installVscode(savedQueue('turn-old'));
      const { onReturn } = setup();
      mockReceiveMessage(state({}));
      mockReceiveMessage(state({}));
      expect(onReturn).toHaveBeenCalledTimes(1);
    });
  });
});
