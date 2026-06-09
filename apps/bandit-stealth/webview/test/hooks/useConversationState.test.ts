/**
 * Arc W3-S3.2 — contract tests for useConversationState.
 *
 * Pins:
 * - the conversationEntries ↔ messages invariant (the hook keeps
 *   `messages` in sync via mapConversationToChat without a manual
 *   useMemo dance)
 * - the voice-transcription appendToComposer semantics (append-with-
 *   space when composer has typed content, raw insert when empty)
 * - changeMode posts the setMode wire message AND is a no-op for
 *   the same-mode case (so a click on the already-active toggle
 *   doesn't double-post)
 * - applyConversationStateSnapshot syncs entries, mode, busy,
 *   statusText, currentConversationId from a state message in one
 *   call (and leaves composerValue untouched — presetPrompt merge
 *   logic lives in App.tsx)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useConversationState } from '../../src/hooks/useConversationState';
import type { ConversationEntry, WebviewState } from '../../src/types/webview';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
});

const buildEntry = (id: string, content: string): ConversationEntry => ({
  id,
  role: 'user',
  content,
  timestamp: Date.now()
});

describe('useConversationState', () => {
  it('initial defaults: empty entries/messages, ask mode, Ready status, not busy, empty composer', () => {
    const { result } = renderHook(() => useConversationState());
    expect(result.current.conversationEntries).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.mode).toBe('ask');
    expect(result.current.statusText).toBe('Ready');
    expect(result.current.busy).toBe(false);
    expect(result.current.composerValue).toBe('');
    expect(result.current.currentConversationId).toBeUndefined();
  });

  it('setConversationEntries projects entries → messages via mapConversationToChat (invariant: in sync)', () => {
    const { result } = renderHook(() => useConversationState());
    act(() =>
      result.current.setConversationEntries([
        buildEntry('e1', 'first'),
        buildEntry('e2', 'second')
      ])
    );
    expect(result.current.conversationEntries.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(result.current.messages.map((m) => m.id)).toEqual(['e1', 'e2']);
    expect(result.current.messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('appendToComposer prepends with a space when the composer already has typed content', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.setComposerValue('hello'));
    act(() => result.current.appendToComposer('world'));
    expect(result.current.composerValue).toBe('hello world');
  });

  it('appendToComposer inserts raw when the composer is empty (no leading space)', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.appendToComposer('voice text'));
    expect(result.current.composerValue).toBe('voice text');
  });

  it('appendToComposer treats whitespace-only composer as empty (avoids leading-space artifact)', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.setComposerValue('   '));
    act(() => result.current.appendToComposer('transcribed'));
    expect(result.current.composerValue).toBe('transcribed');
  });

  it('appendToComposer with empty text is a no-op', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.setComposerValue('keep'));
    act(() => result.current.appendToComposer(''));
    expect(result.current.composerValue).toBe('keep');
  });

  it('clearComposer empties the composer', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.setComposerValue('about to drop'));
    act(() => result.current.clearComposer());
    expect(result.current.composerValue).toBe('');
  });

  it('changeMode posts the setMode wire message AND updates local state when switching', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.changeMode('agent'));
    expect(result.current.mode).toBe('agent');
    expect(recorder.calls).toEqual([{ type: 'setMode', value: 'agent' }]);
  });

  it('changeMode for the SAME mode is a no-op (no double post)', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.changeMode('agent'));
    recorder.reset();
    act(() => result.current.changeMode('agent'));
    expect(recorder.calls).toEqual([]);
  });

  it('changeMode for an unknown string is a no-op (defensive against bad UI wires)', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.changeMode('bogus'));
    expect(result.current.mode).toBe('ask');
    expect(recorder.calls).toEqual([]);
  });

  it('applyConversationStateSnapshot syncs entries, mode, busy, statusText, conversation id in one call', () => {
    const { result } = renderHook(() => useConversationState());
    const state = {
      messages: [buildEntry('e1', 'hi')],
      mode: 'agent',
      isBusy: true,
      statusText: 'Streaming…',
      currentConversationId: 'conv-77'
    } as unknown as WebviewState;
    act(() => result.current.applyConversationStateSnapshot(state));
    expect(result.current.conversationEntries.map((e) => e.id)).toEqual(['e1']);
    expect(result.current.messages.map((m) => m.id)).toEqual(['e1']);
    expect(result.current.mode).toBe('agent');
    expect(result.current.busy).toBe(true);
    expect(result.current.statusText).toBe('Streaming…');
    expect(result.current.currentConversationId).toBe('conv-77');
  });

  it('applyConversationStateSnapshot derives statusText from busy when the field is omitted', () => {
    const { result } = renderHook(() => useConversationState());
    act(() =>
      result.current.applyConversationStateSnapshot({
        messages: [],
        mode: 'ask',
        isBusy: true
      } as unknown as WebviewState)
    );
    expect(result.current.statusText).toBe('Working…');
    act(() =>
      result.current.applyConversationStateSnapshot({
        messages: [],
        mode: 'ask',
        isBusy: false
      } as unknown as WebviewState)
    );
    expect(result.current.statusText).toBe('Ready');
  });

  it('applyConversationStateSnapshot leaves composerValue untouched (presetPrompt merge lives in App)', () => {
    const { result } = renderHook(() => useConversationState());
    act(() => result.current.setComposerValue('in-progress draft'));
    act(() =>
      result.current.applyConversationStateSnapshot({
        messages: [],
        mode: 'ask',
        isBusy: false,
        currentConversationId: 'conv-1'
      } as unknown as WebviewState)
    );
    expect(result.current.composerValue).toBe('in-progress draft');
  });
});
