/**
 * Arc W3-S2.1 — contract tests for useAudioPlayback.
 *
 * Pins the dispatcher boundary + the user-action wire-format. The full
 * Audio()/MediaElement playback chain is jsdom/happy-dom territory and
 * isn't exercised here — these tests cover state transitions and
 * outbound postMessage calls, which are the bits Arc W4's dispatcher
 * extraction must preserve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useAudioPlayback } from '../../src/hooks/useAudioPlayback';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;
let toasts: string[];

const opts = () => ({ onToast: (m: string) => toasts.push(m) });

beforeEach(() => {
  recorder = mockPostMessage();
  toasts = [];
});

afterEach(() => {
  cleanup();
});

describe('useAudioPlayback', () => {
  it('initial state: speakingEntryId null, audioPaused false', () => {
    const { result } = renderHook(() => useAudioPlayback(opts()));
    expect(result.current.speakingEntryId).toBeNull();
    expect(result.current.audioPaused).toBe(false);
  });

  it('handleAudioError clears speakingEntryId when the id matches and toasts the message', () => {
    const { result } = renderHook(() => useAudioPlayback(opts()));
    // Manually set the entry as "speaking" via handlePlayAudio so the
    // matching id has something to clear. handlePlayAudio's Audio()
    // pipeline runs but never actually plays in happy-dom; the
    // speakingEntryId setter fires synchronously before that.
    act(() => {
      result.current.handlePlayAudio({
        entryId: 'msg-1',
        mimeType: 'audio/mpeg',
        audioBase64: btoa('fake audio bytes')
      });
    });
    expect(result.current.speakingEntryId).toBe('msg-1');
    act(() => {
      result.current.handleAudioError({ entryId: 'msg-1', message: 'STT exploded' });
    });
    expect(result.current.speakingEntryId).toBeNull();
    expect(result.current.audioPaused).toBe(false);
    expect(toasts).toEqual(['STT exploded']);
  });

  it('handleAudioError for a non-matching id still toasts but leaves the speaker alone', () => {
    const { result } = renderHook(() => useAudioPlayback(opts()));
    act(() => {
      result.current.handlePlayAudio({
        entryId: 'msg-1',
        mimeType: 'audio/mpeg',
        audioBase64: btoa('fake')
      });
    });
    act(() => {
      result.current.handleAudioError({ entryId: 'OTHER', message: 'unrelated' });
    });
    expect(result.current.speakingEntryId).toBe('msg-1');
    expect(toasts).toEqual(['unrelated']);
  });

  it('handlePlayAudio with malformed base64 catches + clears state without throwing', () => {
    // Suppress the expected console.warn so the test log stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useAudioPlayback(opts()));
    act(() => {
      result.current.handlePlayAudio({
        entryId: 'msg-bad',
        mimeType: 'audio/mpeg',
        audioBase64: 'this!!is~~not^^base64'
      });
    });
    expect(result.current.speakingEntryId).toBeNull();
    expect(result.current.audioPaused).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('startSpeak posts the speakMessage wire message with the entryId + text', () => {
    const { result } = renderHook(() => useAudioPlayback(opts()));
    act(() => {
      result.current.startSpeak('msg-9', 'Hello world');
    });
    expect(recorder.calls).toEqual([
      { type: 'speakMessage', entryId: 'msg-9', text: 'Hello world' }
    ]);
  });

  it('stopSpeak clears speakingEntryId and audioPaused (no outbound message)', () => {
    const { result } = renderHook(() => useAudioPlayback(opts()));
    act(() => {
      result.current.handlePlayAudio({
        entryId: 'msg-1',
        mimeType: 'audio/mpeg',
        audioBase64: btoa('fake')
      });
    });
    expect(result.current.speakingEntryId).toBe('msg-1');
    act(() => {
      result.current.stopSpeak();
    });
    expect(result.current.speakingEntryId).toBeNull();
    expect(result.current.audioPaused).toBe(false);
    expect(recorder.calls).toEqual([]);
  });

  it('pauseSpeak with a non-matching id is a no-op (does not flip audioPaused)', () => {
    const { result } = renderHook(() => useAudioPlayback(opts()));
    act(() => {
      result.current.handlePlayAudio({
        entryId: 'msg-1',
        mimeType: 'audio/mpeg',
        audioBase64: btoa('fake')
      });
    });
    act(() => {
      // User clicks pause on a DIFFERENT message — should be ignored
      // because the pill isn't owned by that message right now.
      result.current.pauseSpeak('msg-other');
    });
    expect(result.current.audioPaused).toBe(false);
  });
});
