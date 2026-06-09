/**
 * Arc W3-S1.1 — contract tests for useToast.
 *
 * Pins the dismiss-delay semantics + hover-pause behavior that the
 * monolithic App was relying on inline before the extraction. If a
 * future refactor changes the schedule or the replace-instead-of-stack
 * behavior, these tests catch it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useToast } from '../../src/hooks/useToast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useToast', () => {
  it('initial toast is null and no timer is pending', () => {
    const { result } = renderHook(() => useToast());
    expect(result.current.toast).toBeNull();
    // No way to observe the timer queue from outside; advancing time
    // with no scheduled dismiss should leave the toast null.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toast).toBeNull();
  });

  it('updateToast shows the message and auto-dismisses after 8 seconds', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.updateToast('hello');
    });
    expect(result.current.toast).toBe('hello');
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(result.current.toast).toBe('hello');
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.toast).toBeNull();
  });

  it('a second updateToast replaces the first and restarts the timer', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.updateToast('first');
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(result.current.toast).toBe('first');

    // Second toast lands 4s in — the original 8s timer must be cancelled
    // so the new one fires at second-show + 8s (= 12s total), not 8s
    // total (which would chop the second toast's lifetime in half).
    act(() => {
      result.current.updateToast('second');
    });
    expect(result.current.toast).toBe('second');
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(result.current.toast).toBe('second');
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.toast).toBeNull();
  });

  it('cancelToastDismiss pauses the auto-dismiss (hover-pause behavior)', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.updateToast('hover-me');
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
      result.current.cancelToastDismiss();
    });
    // After hover-pause the toast survives an arbitrarily long wait.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toast).toBe('hover-me');
  });

  it('scheduleToastDismiss after a pause resumes the 8s countdown from zero', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.updateToast('pause-and-resume');
      vi.advanceTimersByTime(3_000);
      result.current.cancelToastDismiss();
      vi.advanceTimersByTime(120_000); // hover for 2 minutes
      result.current.scheduleToastDismiss(); // mouse leaves
    });
    // Resumed timer is a fresh 8s, NOT the remainder.
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(result.current.toast).toBe('pause-and-resume');
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.toast).toBeNull();
  });

  it('dismissToast clears immediately and cancels any pending timer', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.updateToast('about-to-be-killed');
    });
    expect(result.current.toast).toBe('about-to-be-killed');
    act(() => {
      result.current.dismissToast();
    });
    expect(result.current.toast).toBeNull();
    // Any scheduled timer is dead — advancing time must NOT
    // resurrect anything (or trigger a "ghost" setToast(null) that
    // overwrites a subsequent updateToast).
    act(() => {
      result.current.updateToast('after-dismiss');
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toast).toBe('after-dismiss');
  });
});
