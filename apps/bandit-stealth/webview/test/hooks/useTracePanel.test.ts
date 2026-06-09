/**
 * Arc W6.2 — contract tests for useTracePanel.
 *
 * Pins:
 * - handleOpenTracePanel runs the onOpen side effect AND requests a
 *   fresh list; re-clicking closes the panel without re-requesting
 * - handleTraceModeChange drops the detail BEFORE refetching (so the
 *   user doesn't briefly see the old detail in the new mode's
 *   filtered list)
 * - requestTraceDetail no-ops on empty ids
 * - the trim-loading / clear-error pattern on every outbound request
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTracePanel } from '../../src/hooks/useTracePanel';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
});

describe('useTracePanel', () => {
  it('initial state: closed, mode "all", empty list/detail, not loading, no error', () => {
    const { result } = renderHook(() => useTracePanel());
    expect(result.current.tracePanelOpen).toBe(false);
    expect(result.current.traceViewMode).toBe('all');
    expect(result.current.traceList).toEqual([]);
    expect(result.current.traceDetail).toBeNull();
    expect(result.current.traceLoading).toBe(false);
    expect(result.current.traceError).toBeNull();
  });

  it('handleOpenTracePanel opens + runs onOpen + posts requestTraceList', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useTracePanel({ onOpen }));
    act(() => result.current.handleOpenTracePanel());
    expect(result.current.tracePanelOpen).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(recorder.calls).toEqual([{ type: 'requestTraceList', mode: 'all' }]);
    expect(result.current.traceLoading).toBe(true);
  });

  it('handleOpenTracePanel re-click closes WITHOUT re-running onOpen or requesting again', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useTracePanel({ onOpen }));
    act(() => result.current.handleOpenTracePanel());
    onOpen.mockClear();
    recorder.reset();
    act(() => result.current.handleOpenTracePanel());
    expect(result.current.tracePanelOpen).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual([]);
  });

  it('handleTraceModeChange drops the detail BEFORE re-requesting (so the old detail does not flash)', () => {
    const { result } = renderHook(() => useTracePanel());
    act(() => result.current.setTraceDetail({ summary: { id: 't1' } } as never));
    expect(result.current.traceDetail).toBeTruthy();
    act(() => result.current.handleTraceModeChange('failed'));
    expect(result.current.traceDetail).toBeNull();
    expect(result.current.traceViewMode).toBe('failed');
    expect(recorder.calls).toEqual([{ type: 'requestTraceList', mode: 'failed' }]);
  });

  it('handleTraceRefresh re-posts requestTraceList with the CURRENT mode', () => {
    const { result } = renderHook(() => useTracePanel());
    act(() => result.current.setTraceViewMode('failed'));
    recorder.reset();
    act(() => result.current.handleTraceRefresh());
    expect(recorder.calls).toEqual([{ type: 'requestTraceList', mode: 'failed' }]);
  });

  it('requestTraceDetail with a non-empty id posts the wire message AND flips loading on', () => {
    const { result } = renderHook(() => useTracePanel());
    act(() => result.current.requestTraceDetail('trace-x'));
    expect(recorder.calls).toEqual([{ type: 'requestTraceDetail', id: 'trace-x' }]);
    expect(result.current.traceLoading).toBe(true);
    expect(result.current.traceError).toBeNull();
  });

  it('requestTraceDetail with an empty id is a no-op (no wire post, no loading flip)', () => {
    const { result } = renderHook(() => useTracePanel());
    act(() => result.current.requestTraceDetail(''));
    expect(recorder.calls).toEqual([]);
    expect(result.current.traceLoading).toBe(false);
  });

  it('outbound requests clear any prior error before fetching', () => {
    const { result } = renderHook(() => useTracePanel());
    act(() => result.current.setTraceError('stale message'));
    expect(result.current.traceError).toBe('stale message');
    act(() => result.current.requestTraceList());
    expect(result.current.traceError).toBeNull();
  });
});
