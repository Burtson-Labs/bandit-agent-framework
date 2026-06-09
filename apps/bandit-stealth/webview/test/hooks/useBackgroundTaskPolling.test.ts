/**
 * Arc W3-S1.4 — contract tests for useBackgroundTaskPolling.
 *
 * Pins:
 * - tasks always emerge sorted by startedAt asc (the BackgroundTaskTile
 *   relies on this order, the hook owns the sort so the component is
 *   simple)
 * - backgroundTaskList REPLACES the map (covers the "panel was hidden
 *   while tasks finished" case)
 * - backgroundTaskUpdate is OVERWRITE-by-id, never merge
 * - dismissTask is OPTIMISTIC: local consumed=true flip lands before the
 *   wire message, and is idempotent on unknown ids
 * - cancelTask + dismissTask post the right wire shapes
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useBackgroundTaskPolling } from '../../src/hooks/useBackgroundTaskPolling';
import {
  buildBackgroundTaskPayload,
  mockPostMessage,
  type PostMessageRecorder
} from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
});

describe('useBackgroundTaskPolling', () => {
  it('initial state: empty tasks, panel closed', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    expect(result.current.tasks).toEqual([]);
    expect(result.current.panelOpen).toBe(false);
  });

  it('setBackgroundTasksList seeds the map and returns the array sorted by startedAt asc', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => {
      result.current.setBackgroundTasksList([
        { ...buildBackgroundTaskPayload({ id: 'b' }), startedAt: 200 },
        { ...buildBackgroundTaskPayload({ id: 'a' }), startedAt: 100 },
        { ...buildBackgroundTaskPayload({ id: 'c' }), startedAt: 300 }
      ]);
    });
    expect(result.current.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('a second setBackgroundTasksList REPLACES the previous map (not merge)', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => {
      result.current.setBackgroundTasksList([
        buildBackgroundTaskPayload({ id: 'a' }),
        buildBackgroundTaskPayload({ id: 'b' })
      ]);
    });
    act(() => {
      result.current.setBackgroundTasksList([
        buildBackgroundTaskPayload({ id: 'c' })
      ]);
    });
    expect(result.current.tasks.map((t) => t.id)).toEqual(['c']);
  });

  it('applyBackgroundTaskUpdate overwrites an existing task by id', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => {
      result.current.setBackgroundTasksList([
        buildBackgroundTaskPayload({ id: 'a', status: 'running' })
      ]);
    });
    act(() => {
      result.current.applyBackgroundTaskUpdate(
        buildBackgroundTaskPayload({ id: 'a', status: 'completed' })
      );
    });
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0].status).toBe('completed');
  });

  it('applyBackgroundTaskUpdate for a new id inserts (extension can broadcast a never-seen task)', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => {
      result.current.applyBackgroundTaskUpdate(
        buildBackgroundTaskPayload({ id: 'late', status: 'running' })
      );
    });
    expect(result.current.tasks.map((t) => t.id)).toEqual(['late']);
  });

  it('togglePanelOpen flips and unflips the expanded state', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => result.current.togglePanelOpen());
    expect(result.current.panelOpen).toBe(true);
    act(() => result.current.togglePanelOpen());
    expect(result.current.panelOpen).toBe(false);
  });

  it('cancelTask posts the cancelBackgroundTask wire message (no local state change)', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => {
      result.current.setBackgroundTasksList([
        buildBackgroundTaskPayload({ id: 'a', status: 'running' })
      ]);
    });
    act(() => result.current.cancelTask('a'));
    expect(recorder.calls).toEqual([
      { type: 'cancelBackgroundTask', taskId: 'a' }
    ]);
    // Cancel does not change local state — the extension's
    // backgroundTaskUpdate broadcast is what flips status to "cancelled".
    expect(result.current.tasks[0].status).toBe('running');
  });

  it('dismissTask flips consumed=true optimistically AND posts the dismiss wire message', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => {
      result.current.setBackgroundTasksList([
        buildBackgroundTaskPayload({ id: 'a', status: 'completed', consumed: false })
      ]);
    });
    act(() => result.current.dismissTask('a'));
    expect(result.current.tasks[0].consumed).toBe(true);
    expect(recorder.calls).toEqual([
      { type: 'dismissBackgroundTask', taskId: 'a' }
    ]);
  });

  it('dismissTask for an unknown id posts the wire message but does not crash on local state', () => {
    const { result } = renderHook(() => useBackgroundTaskPolling());
    act(() => result.current.dismissTask('ghost'));
    expect(result.current.tasks).toEqual([]);
    expect(recorder.calls).toEqual([
      { type: 'dismissBackgroundTask', taskId: 'ghost' }
    ]);
  });
});
