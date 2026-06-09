/**
 * Arc W3-S2.4 — contract tests for useLiveDiffEntries.
 *
 * Pins:
 * - the agent:diffSnapshot merge contract (path-keyed; defined fields
 *   replace; undefined fields fall back to the existing entry)
 * - the diff-preview card lifecycle (idle → pending → success/error)
 * - the success-only auto-dismiss schedule at DIFF_PREVIEW_DISMISS_DELAY_MS
 * - the user-action wire format
 * - the localStorage round-trip keyed on conversationId + the
 *   canUndoAgentChange seeding semantics
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  DIFF_PREVIEW_DISMISS_DELAY_MS,
  useLiveDiffEntries
} from '../../src/hooks/useLiveDiffEntries';
import { LIVE_DIFF_STORAGE_PREFIX } from '../../src/state/diffStorage';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const renderLiveDiff = (opts?: { conversationId?: string; canUndoAgentChange?: boolean }) =>
  renderHook(
    (p: { conversationId?: string; canUndoAgentChange: boolean }) => useLiveDiffEntries(p),
    {
      initialProps: {
        conversationId: opts?.conversationId,
        canUndoAgentChange: opts?.canUndoAgentChange ?? false
      }
    }
  );

describe('useLiveDiffEntries', () => {
  it('initial state: all 3 records empty when there is no stored data', () => {
    const { result } = renderLiveDiff();
    expect(result.current.liveDiffEntries).toEqual({});
    expect(result.current.persistedDiffEntries).toEqual({});
    expect(result.current.diffPreviewCards).toEqual({});
  });

  it('seeds persistedDiffEntries from localStorage on mount when a conversationId is given', () => {
    const conversationId = 'conv-1';
    window.localStorage.setItem(
      `${LIVE_DIFF_STORAGE_PREFIX}${conversationId}`,
      JSON.stringify({
        'src/foo.ts': { path: 'src/foo.ts', diffText: '@@ patch', added: 1, removed: 0 }
      })
    );
    const { result } = renderLiveDiff({ conversationId, canUndoAgentChange: false });
    expect(result.current.persistedDiffEntries['src/foo.ts']).toMatchObject({
      path: 'src/foo.ts',
      added: 1,
      removed: 0
    });
    // canUndoAgentChange=false → live entries DO NOT seed from storage.
    expect(result.current.liveDiffEntries).toEqual({});
  });

  it('seeds liveDiffEntries from persisted when canUndoAgentChange=true (the undo window is still open)', () => {
    const conversationId = 'conv-2';
    window.localStorage.setItem(
      `${LIVE_DIFF_STORAGE_PREFIX}${conversationId}`,
      JSON.stringify({ 'src/bar.ts': { path: 'src/bar.ts', added: 2, removed: 0 } })
    );
    const { result } = renderLiveDiff({ conversationId, canUndoAgentChange: true });
    expect(result.current.liveDiffEntries['src/bar.ts']).toMatchObject({ path: 'src/bar.ts', added: 2 });
  });

  it('handleDiffSnapshot merges the snapshot fields into liveDiffEntries keyed by path', () => {
    const { result } = renderLiveDiff();
    act(() => {
      result.current.handleDiffSnapshot({
        path: 'src/foo.ts',
        diff: '@@ initial',
        summary: { added: 3, removed: 1 }
      });
    });
    expect(result.current.liveDiffEntries['src/foo.ts']).toMatchObject({
      path: 'src/foo.ts',
      diffText: '@@ initial',
      added: 3,
      removed: 1
    });
  });

  it('handleDiffSnapshot preserves prior fields when the new payload omits them', () => {
    const { result } = renderLiveDiff();
    act(() => {
      result.current.handleDiffSnapshot({
        path: 'src/foo.ts',
        diff: '@@ first',
        summary: { added: 5, removed: 2 }
      });
    });
    act(() => {
      // Subsequent snapshot only updates the diff text; counts should
      // persist (the stream may push a refined diff without re-stating
      // the line-counts each time).
      result.current.handleDiffSnapshot({ path: 'src/foo.ts', diff: '@@ refined' });
    });
    expect(result.current.liveDiffEntries['src/foo.ts']).toMatchObject({
      path: 'src/foo.ts',
      diffText: '@@ refined',
      added: 5,
      removed: 2
    });
  });

  it('handleDiffSnapshot drops payloads without a string path (defensive)', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffSnapshot({ diff: 'no path' }));
    expect(result.current.liveDiffEntries).toEqual({});
  });

  it('handleDiffPreviewCard creates an idle card and ensures a live entry exists', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffPreviewCard({ path: 'src/foo.ts', hasBackup: true }));
    expect(result.current.diffPreviewCards['src/foo.ts']).toEqual({
      path: 'src/foo.ts',
      hasBackup: true,
      status: 'idle'
    });
    expect(result.current.liveDiffEntries['src/foo.ts']).toEqual({ path: 'src/foo.ts' });
  });

  it('handleDiffPreviewCard drops payloads without a path (defensive)', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffPreviewCard({ hasBackup: false }));
    expect(result.current.diffPreviewCards).toEqual({});
  });

  it('handleDiffPreviewResult success flips the card to success and auto-dismisses after the delay', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffPreviewCard({ path: 'src/foo.ts', hasBackup: false }));
    act(() => result.current.handleDiffPreviewResult({ path: 'src/foo.ts', status: 'apply' }));
    expect(result.current.diffPreviewCards['src/foo.ts']).toMatchObject({
      status: 'success',
      lastAction: 'apply',
      message: 'Applied changes.'
    });
    // Before the auto-dismiss settles, the card is still up.
    act(() => vi.advanceTimersByTime(DIFF_PREVIEW_DISMISS_DELAY_MS - 1));
    expect(result.current.diffPreviewCards['src/foo.ts']).toBeTruthy();
    // After the settle, gone.
    act(() => vi.advanceTimersByTime(2));
    expect(result.current.diffPreviewCards['src/foo.ts']).toBeUndefined();
  });

  it('handleDiffPreviewResult error does NOT auto-dismiss (the user needs to see the failure)', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffPreviewCard({ path: 'src/foo.ts', hasBackup: false }));
    act(() =>
      result.current.handleDiffPreviewResult({
        path: 'src/foo.ts',
        status: 'error',
        message: 'patch rejected'
      })
    );
    expect(result.current.diffPreviewCards['src/foo.ts']).toMatchObject({
      status: 'error',
      message: 'patch rejected'
    });
    act(() => vi.advanceTimersByTime(60_000));
    // Still up — error cards stick around for the user to read.
    expect(result.current.diffPreviewCards['src/foo.ts']).toMatchObject({ status: 'error' });
  });

  it('handleDiffPreviewClear drops all cards AND cancels any pending auto-dismiss timers', () => {
    const { result } = renderLiveDiff();
    act(() => {
      result.current.handleDiffPreviewCard({ path: 'a' });
      result.current.handleDiffPreviewCard({ path: 'b' });
      result.current.handleDiffPreviewResult({ path: 'a', status: 'apply' }); // schedules a dismiss
    });
    act(() => result.current.handleDiffPreviewClear());
    expect(result.current.diffPreviewCards).toEqual({});
    // If the pending timer wasn't cancelled it would fire setDiffPreviewCards
    // into a dead-state, harmless but noisy. Advance and confirm nothing
    // surfaces.
    act(() => vi.advanceTimersByTime(DIFF_PREVIEW_DISMISS_DELAY_MS * 2));
    expect(result.current.diffPreviewCards).toEqual({});
  });

  it('handleDiffPreviewAction flips card to pending AND posts the wire action', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffPreviewCard({ path: 'src/foo.ts', hasBackup: false }));
    recorder.reset();
    act(() => result.current.handleDiffPreviewAction('src/foo.ts', 'apply'));
    expect(result.current.diffPreviewCards['src/foo.ts']).toMatchObject({
      status: 'pending',
      lastAction: 'apply',
      message: 'Applying changes…'
    });
    expect(recorder.calls).toEqual([
      { type: 'diffPreviewAction', path: 'src/foo.ts', action: 'apply' }
    ]);
  });

  it('handleDiffPreviewAction dedup is UI-only — state update is skipped on a pending card, but the wire post still fires (existing behavior; the extension is idempotent on duplicate paths)', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffPreviewCard({ path: 'src/foo.ts', hasBackup: false }));
    act(() => result.current.handleDiffPreviewAction('src/foo.ts', 'apply'));
    const cardAfterFirst = result.current.diffPreviewCards['src/foo.ts'];
    recorder.reset();
    act(() => result.current.handleDiffPreviewAction('src/foo.ts', 'apply'));
    // State unchanged — same object reference, the setter returned `prev`.
    expect(result.current.diffPreviewCards['src/foo.ts']).toBe(cardAfterFirst);
    // But the wire post fires regardless. The extension dedupes by path
    // on its side. If a future refactor wants to suppress this, expand
    // the check to also gate the postMessage on the pending status.
    expect(recorder.calls).toEqual([
      { type: 'diffPreviewAction', path: 'src/foo.ts', action: 'apply' }
    ]);
  });

  it('handleUndoAgentChanges clears live entries and posts undoAgentChange', () => {
    const { result } = renderLiveDiff();
    act(() => result.current.handleDiffSnapshot({ path: 'src/foo.ts', diff: '@@' }));
    expect(result.current.liveDiffEntries['src/foo.ts']).toBeTruthy();
    act(() => result.current.handleUndoAgentChanges());
    expect(result.current.liveDiffEntries).toEqual({});
    expect(recorder.calls).toEqual([{ type: 'undoAgentChange' }]);
  });

  it('clearLiveDiffEntries empties the live map WITHOUT persisting (used at turn-start)', () => {
    const conversationId = 'conv-3';
    const { result } = renderLiveDiff({ conversationId, canUndoAgentChange: false });
    act(() => result.current.handleDiffSnapshot({ path: 'src/foo.ts', diff: '@@' }));
    act(() => result.current.clearLiveDiffEntries());
    expect(result.current.liveDiffEntries).toEqual({});
    // localStorage NOT touched — the persisted-entries copy survives the
    // turn-start clear (so the undo affordance still has its trail).
    // The diff snapshot above WOULD have persisted, so verify the
    // persisted set still has src/foo.ts even though live is empty.
    expect(result.current.persistedDiffEntries['src/foo.ts']).toBeTruthy();
  });
});
