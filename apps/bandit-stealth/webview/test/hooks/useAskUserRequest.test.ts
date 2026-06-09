/**
 * Arc W3-S1.2 — contract tests for useAskUserRequest.
 *
 * Pins:
 * - the dedup-by-id behavior on inbound userInputRequest (so a resume
 *   re-send doesn't reset the user's in-progress form)
 * - the outbound userInputResponse shape sent to the extension host
 *   on submit / cancel (this is wire format — extension parses it)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useAskUserRequest } from '../../src/hooks/useAskUserRequest';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
});

describe('useAskUserRequest', () => {
  it('initial askUserRequest is null', () => {
    const { result } = renderHook(() => useAskUserRequest());
    expect(result.current.askUserRequest).toBeNull();
  });

  it('requestAskUser sets the in-flight question card', () => {
    const { result } = renderHook(() => useAskUserRequest());
    act(() => {
      result.current.requestAskUser('q-1', [
        { id: 'tone', question: 'How should I respond?' }
      ]);
    });
    expect(result.current.askUserRequest).toEqual({
      id: 'q-1',
      questions: [{ id: 'tone', question: 'How should I respond?' }]
    });
  });

  it('a duplicate requestAskUser with the same id preserves the existing object reference (no reset)', () => {
    const { result } = renderHook(() => useAskUserRequest());
    act(() => {
      result.current.requestAskUser('q-1', [{ id: 'a', question: 'A?' }]);
    });
    const first = result.current.askUserRequest;
    act(() => {
      // Same id, different questions (simulating a network-resume
      // re-send) — must NOT replace the in-progress state.
      result.current.requestAskUser('q-1', [{ id: 'b', question: 'B?' }]);
    });
    expect(result.current.askUserRequest).toBe(first);
  });

  it('a different id replaces the current request', () => {
    const { result } = renderHook(() => useAskUserRequest());
    act(() => {
      result.current.requestAskUser('q-1', [{ id: 'a', question: 'A?' }]);
    });
    act(() => {
      result.current.requestAskUser('q-2', [{ id: 'b', question: 'B?' }]);
    });
    expect(result.current.askUserRequest?.id).toBe('q-2');
  });

  it('handleAskUserSubmit clears the local state and posts the response wire message', () => {
    const { result } = renderHook(() => useAskUserRequest());
    act(() => {
      result.current.requestAskUser('q-1', [{ id: 'a', question: 'A?' }]);
    });
    expect(result.current.askUserRequest).not.toBeNull();
    act(() => {
      result.current.handleAskUserSubmit('q-1', { a: 'answer' });
    });
    expect(result.current.askUserRequest).toBeNull();
    expect(recorder.calls).toEqual([
      { type: 'userInputResponse', id: 'q-1', answers: { a: 'answer' }, cancelled: undefined }
    ]);
  });

  it('handleAskUserSubmit with cancelled=true still clears and posts a wire message marked cancelled', () => {
    const { result } = renderHook(() => useAskUserRequest());
    act(() => {
      result.current.requestAskUser('q-1', [{ id: 'a', question: 'A?' }]);
    });
    act(() => {
      result.current.handleAskUserSubmit('q-1', {}, true);
    });
    expect(result.current.askUserRequest).toBeNull();
    expect(recorder.calls).toEqual([
      { type: 'userInputResponse', id: 'q-1', answers: {}, cancelled: true }
    ]);
  });
});
