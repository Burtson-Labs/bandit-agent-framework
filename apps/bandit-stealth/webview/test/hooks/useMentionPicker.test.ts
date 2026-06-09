/**
 * Arc W3-S2.3 — contract tests for useMentionPicker.
 *
 * Pins:
 * - the 120 ms debounce on outbound searchWorkspaceFiles (a burst of
 *   keystrokes coalesces to one fetch on settle, not one per keystroke)
 * - the rapid-burst cancel + restart semantics (only the last query
 *   wins; intermediate ones never reach the extension)
 * - the inbound workspaceFileSuggestions shape filter (malformed
 *   entries get dropped silently; the popover never crashes on a
 *   typo'd extension payload)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useMentionPicker } from '../../src/hooks/useMentionPicker';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useMentionPicker', () => {
  it('initial state: empty suggestions, no outbound message', () => {
    const { result } = renderHook(() => useMentionPicker());
    expect(result.current.mentionSuggestions).toEqual([]);
    expect(recorder.calls).toEqual([]);
  });

  it('handleFileMentionQuery posts searchWorkspaceFiles after the 120 ms debounce settles', () => {
    const { result } = renderHook(() => useMentionPicker());
    act(() => result.current.handleFileMentionQuery('src/foo'));
    act(() => vi.advanceTimersByTime(119));
    expect(recorder.calls).toEqual([]);
    act(() => vi.advanceTimersByTime(2));
    expect(recorder.calls).toEqual([{ type: 'searchWorkspaceFiles', query: 'src/foo' }]);
  });

  it('a burst of rapid handleFileMentionQuery calls coalesces to a single search using the last query', () => {
    const { result } = renderHook(() => useMentionPicker());
    act(() => {
      result.current.handleFileMentionQuery('s');
      vi.advanceTimersByTime(40);
      result.current.handleFileMentionQuery('sr');
      vi.advanceTimersByTime(40);
      result.current.handleFileMentionQuery('src');
      vi.advanceTimersByTime(40);
      result.current.handleFileMentionQuery('src/foo');
    });
    // No fires yet — each call restarted the debounce.
    expect(recorder.calls).toEqual([]);
    act(() => vi.advanceTimersByTime(120));
    expect(recorder.calls).toEqual([{ type: 'searchWorkspaceFiles', query: 'src/foo' }]);
  });

  it('handleWorkspaceFileSuggestions accepts a well-formed entry list', () => {
    const { result } = renderHook(() => useMentionPicker());
    act(() => {
      result.current.handleWorkspaceFileSuggestions([
        { path: 'src/foo.ts', isDir: false },
        { path: 'src', isDir: true }
      ]);
    });
    expect(result.current.mentionSuggestions).toEqual([
      { path: 'src/foo.ts', isDir: false },
      { path: 'src', isDir: true }
    ]);
  });

  it('handleWorkspaceFileSuggestions silently drops malformed entries (defense against extension drift)', () => {
    const { result } = renderHook(() => useMentionPicker());
    act(() => {
      result.current.handleWorkspaceFileSuggestions([
        { path: 'src/ok.ts', isDir: false },
        null,
        { path: 42, isDir: false }, // non-string path
        { path: 'src/bad', isDir: 'yes' }, // non-boolean isDir
        'just-a-string',
        { path: 'src/ok2.ts', isDir: true }
      ]);
    });
    expect(result.current.mentionSuggestions).toEqual([
      { path: 'src/ok.ts', isDir: false },
      { path: 'src/ok2.ts', isDir: true }
    ]);
  });

  it('handleWorkspaceFileSuggestions with a non-array payload falls back to an empty list', () => {
    const { result } = renderHook(() => useMentionPicker());
    act(() => result.current.handleWorkspaceFileSuggestions(undefined));
    expect(result.current.mentionSuggestions).toEqual([]);
    act(() => result.current.handleWorkspaceFileSuggestions('not-an-array'));
    expect(result.current.mentionSuggestions).toEqual([]);
    act(() => result.current.handleWorkspaceFileSuggestions(null));
    expect(result.current.mentionSuggestions).toEqual([]);
  });
});
