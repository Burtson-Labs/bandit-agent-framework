import { useCallback, useEffect, useRef, useState } from "react";

export interface PlayAudioPayload {
  entryId: string;
  mimeType: string;
  audioBase64: string;
}

export interface AudioErrorPayload {
  entryId: string;
  message: string;
}

export interface UseAudioPlaybackOpts {
  /**
   * Surface a toast to the user. The hook calls this for:
   * - real codec / decode / playback errors (NOT for the Chromium
   *   autoplay-policy denial that fires on first-paint before any user
   *   gesture — that's silenced because the next user-initiated speak
   *   works fine and a "playback blocked" toast would just be noise)
   * - audioError dispatches forwarded from the extension host
   */
  onToast: (message: string) => void;
}

export interface AudioPlaybackHook {
  /** The entry id whose TTS is currently audible, or null when nothing is playing. */
  speakingEntryId: string | null;
  /** True iff the current audio is paused (vs playing) — drives the pause/play icon swap. */
  audioPaused: boolean;
  /** Dispatch handler for the `playAudio` wire message. */
  handlePlayAudio: (payload: PlayAudioPayload) => void;
  /** Dispatch handler for the `audioError` wire message. */
  handleAudioError: (payload: AudioErrorPayload) => void;
  /** User pauses the active speaker pill on a message (keeps buffered audio for resume). */
  pauseSpeak: (id: string) => void;
  /** User resumes the paused speaker. */
  resumeSpeak: (id: string) => void;
  /** User stops the active speaker entirely (drops buffer). */
  stopSpeak: () => void;
  /**
   * User starts speaking a message — stops any prior, then posts a
   * `speakMessage` to the extension which will respond with `playAudio`.
   */
  startSpeak: (id: string, text: string) => void;
}

/**
 * Owns the TTS playback surface: speakingEntryId / audioPaused state,
 * the `currentAudioRef` HTMLAudioElement that lives across renders,
 * the playAudio decode → blob → object-url chain, the user-initiated
 * pause/resume/stop/start actions, and the unmount cleanup that
 * silences any in-flight audio if the webview is torn down mid-play.
 */
export function useAudioPlayback(opts: UseAudioPlaybackOpts): AudioPlaybackHook {
  const { onToast } = opts;
  const [speakingEntryId, setSpeakingEntryId] = useState<string | null>(null);
  const [audioPaused, setAudioPaused] = useState(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // Keep the latest onToast in a ref so the playAudio dispatch's
  // event-listener closures stay correct even if the caller's
  // callback identity changes between renders. Without this, the
  // listeners would capture a stale toast function.
  const onToastRef = useRef(onToast);
  useEffect(() => {
    onToastRef.current = onToast;
  }, [onToast]);

  // Unmount cleanup — if the webview tears down mid-play, stop the
  // audio so it doesn't keep talking into a dead React tree.
  useEffect(
    () => () => {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.src = "";
        currentAudioRef.current = null;
      }
    },
    []
  );

  const handlePlayAudio = useCallback((payload: PlayAudioPayload) => {
    try {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current.src = "";
        currentAudioRef.current = null;
      }
      const binary = atob(payload.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i);}
      const blob = new Blob([bytes], { type: payload.mimeType || "audio/mpeg" });
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      currentAudioRef.current = audio;
      setSpeakingEntryId(payload.entryId);
      setAudioPaused(false);
      audio.addEventListener("ended", () => {
        URL.revokeObjectURL(objectUrl);
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
          setSpeakingEntryId((id) => (id === payload.entryId ? null : id));
          setAudioPaused(false);
        }
      });
      audio.addEventListener("error", () => {
        URL.revokeObjectURL(objectUrl);
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
          setSpeakingEntryId(null);
          setAudioPaused(false);
        }
      });
      void audio.play().catch((err) => {
        URL.revokeObjectURL(objectUrl);
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
          setSpeakingEntryId(null);
          setAudioPaused(false);
        }
        // Distinguish autoplay-policy denial from real playback errors.
        // Chromium's autoplay policy throws `NotAllowedError` ("play()
        // failed because the user didn't interact with the document
        // first") when audio tries to start before any user gesture —
        // happens with banditStealth.voice.autoSpeak on the FIRST page
        // load before the user clicks anything. Showing a scary
        // "playback blocked" toast for that case is bad UX because the
        // next time the user clicks Listen, audio will work fine. Stay
        // silent on autoplay denial; toast for everything else (CSP
        // violations, codec failures, decode errors — those are real
        // bugs).
        const reason = err instanceof Error ? err.message : String(err);
        const isAutoplayBlocked =
          err instanceof Error &&
          (err.name === "NotAllowedError" ||
            /didn't interact|user gesture|play\(\) request was interrupted/i.test(reason));
        if (!isAutoplayBlocked) {
          onToastRef.current(`Audio playback blocked: ${reason}`);
        }
      });
    } catch (err) {
      console.warn("playAudio decode failed", err);
      setSpeakingEntryId(null);
      setAudioPaused(false);
    }
  }, []);

  const handleAudioError = useCallback((payload: AudioErrorPayload) => {
    setSpeakingEntryId((id) => (id === payload.entryId ? null : id));
    setAudioPaused(false);
    onToastRef.current(payload.message);
  }, []);

  const pauseSpeak = useCallback((id: string) => {
    const audio = currentAudioRef.current;
    if (audio && speakingEntryId === id) {
      audio.pause();
      setAudioPaused(true);
    }
  }, [speakingEntryId]);

  const resumeSpeak = useCallback((id: string) => {
    const audio = currentAudioRef.current;
    if (audio && speakingEntryId === id) {
      void audio.play().catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        onToastRef.current(`Audio playback blocked: ${reason}`);
      });
      setAudioPaused(false);
    }
  }, [speakingEntryId]);

  const stopSpeak = useCallback(() => {
    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      currentAudioRef.current = null;
    }
    setSpeakingEntryId(null);
    setAudioPaused(false);
  }, []);

  const startSpeak = useCallback((id: string, text: string) => {
    // Fresh synthesis. If a DIFFERENT message is playing, stop it
    // first — otherwise two voices fight for the output device once
    // the new audio arrives.
    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      currentAudioRef.current = null;
      setSpeakingEntryId(null);
      setAudioPaused(false);
    }
    vscode.postMessage({ type: "speakMessage", entryId: id, text });
  }, []);

  return {
    speakingEntryId,
    audioPaused,
    handlePlayAudio,
    handleAudioError,
    pauseSpeak,
    resumeSpeak,
    stopSpeak,
    startSpeak
  };
}
