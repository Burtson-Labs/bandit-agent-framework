/**
 * Arc W3-S2.2 — contract tests for useMicrophoneRecording.
 *
 * Pins:
 * - the on-mount extensionMicProbe (the extension's STT path detection
 *   depends on receiving this — without it the mic falls back to
 *   webview getUserMedia even when ffmpeg is available)
 * - the voiceTranscription dispatch resets micRecording to idle AND
 *   injects the text through onTranscript (append-with-space when the
 *   composer already has content)
 * - extensionMicAvailability dispatch toggles extensionMicAvailable
 * - extensionMicError dispatch resets state + toasts with the
 *   "Microphone error: ..." prefix
 * - handleMicStart prefers the extension path when available (posts
 *   extensionMicStart, sets state to recording, does NOT touch
 *   getUserMedia) and is idempotent while one is in flight
 * - handleMicStop routes by the active path
 *
 * The webview getUserMedia fallback path uses platform-specific code
 * (MediaRecorder, navigator.mediaDevices.getUserMedia, TCC guidance)
 * that's hard to exercise reliably from happy-dom — those branches are
 * outside the contract here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  useMicrophoneRecording,
  type ExtensionMicAvailabilityPayload
} from '../../src/hooks/useMicrophoneRecording';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;
let toasts: string[];
let transcripts: string[];

const opts = () => ({
  onToast: (m: string) => toasts.push(m),
  onTranscript: (t: string) => transcripts.push(t)
});

beforeEach(() => {
  recorder = mockPostMessage();
  toasts = [];
  transcripts = [];
});

afterEach(() => {
  cleanup();
});

describe('useMicrophoneRecording', () => {
  it('initial state: idle + extensionMicAvailable false', () => {
    renderHook(() => useMicrophoneRecording(opts()));
    expect(recorder.calls).toEqual([{ type: 'extensionMicProbe' }]);
    // micRecording starts at idle and extensionMicAvailable at false;
    // tested via observable behavior below (the probe call is the only
    // initial side effect).
  });

  it('mounts post an extensionMicProbe exactly once (cold capability probe)', () => {
    const { rerender } = renderHook(() => useMicrophoneRecording(opts()));
    rerender();
    rerender();
    expect(recorder.calls.filter((c) => (c as { type: string }).type === 'extensionMicProbe')).toHaveLength(1);
  });

  it('handleVoiceTranscription resets micRecording to idle AND fires onTranscript with the text', () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    act(() => result.current.handleVoiceTranscription('hello world'));
    expect(transcripts).toEqual(['hello world']);
    expect(result.current.micRecording).toBe('idle');
  });

  it('handleVoiceTranscription with empty text resets state but does NOT call onTranscript', () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    act(() => result.current.handleVoiceTranscription(''));
    expect(transcripts).toEqual([]);
    expect(result.current.micRecording).toBe('idle');
  });

  it('handleExtensionMicAvailability(available=true) flips extensionMicAvailable', () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    expect(result.current.extensionMicAvailable).toBe(false);
    act(() => {
      const payload: ExtensionMicAvailabilityPayload = { available: true };
      result.current.handleExtensionMicAvailability(payload);
    });
    expect(result.current.extensionMicAvailable).toBe(true);
  });

  it('handleExtensionMicError resets micRecording AND toasts with the "Microphone error:" prefix', () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    act(() => result.current.handleExtensionMicError({ message: 'ffmpeg crashed' }));
    expect(toasts).toEqual(['Microphone error: ffmpeg crashed']);
    expect(result.current.micRecording).toBe('idle');
  });

  it('handleMicStart prefers extensionMicStart when extension recorder is available (no getUserMedia)', async () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    act(() => {
      result.current.handleExtensionMicAvailability({ available: true });
    });
    recorder.reset();
    await act(async () => {
      await result.current.handleMicStart();
    });
    expect(recorder.calls).toEqual([{ type: 'extensionMicStart' }]);
    expect(result.current.micRecording).toBe('recording');
  });

  it('handleMicStart is idempotent — a second call while one is in flight is a no-op', async () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    act(() => {
      result.current.handleExtensionMicAvailability({ available: true });
    });
    recorder.reset();
    await act(async () => {
      await result.current.handleMicStart();
    });
    expect(recorder.calls).toEqual([{ type: 'extensionMicStart' }]);
    await act(async () => {
      await result.current.handleMicStart();
    });
    // No additional extensionMicStart post — second call detected the
    // active path and bailed.
    expect(recorder.calls).toEqual([{ type: 'extensionMicStart' }]);
  });

  it('handleMicStop on an extension-path recording posts extensionMicStop and flips to uploading', async () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    act(() => {
      result.current.handleExtensionMicAvailability({ available: true });
    });
    await act(async () => {
      await result.current.handleMicStart();
    });
    recorder.reset();
    act(() => result.current.handleMicStop());
    expect(recorder.calls).toEqual([{ type: 'extensionMicStop' }]);
    expect(result.current.micRecording).toBe('uploading');
  });

  it('handleMicStop with no active recording is a no-op (no crash, no message)', () => {
    const { result } = renderHook(() => useMicrophoneRecording(opts()));
    recorder.reset();
    act(() => result.current.handleMicStop());
    expect(recorder.calls).toEqual([]);
  });
});
