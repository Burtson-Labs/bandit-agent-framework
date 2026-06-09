import { useCallback, useEffect, useRef, useState } from "react";

export type MicState = "idle" | "recording" | "uploading";

export interface ExtensionMicAvailabilityPayload {
  available: boolean;
  message?: string;
  kind?: "bundled" | "ffmpeg" | "sox" | "arecord";
  canAutoInstall?: boolean;
  installerName?: string;
}

export interface UseMicrophoneRecordingOpts {
  /** Surface a toast (mic-error / TCC-reset guidance / encoding failure). */
  onToast: (message: string) => void;
  /** Inject the transcribed text into the composer. */
  onTranscript: (text: string) => void;
}

export interface MicrophoneRecordingHook {
  /** "idle" → "recording" → "uploading" → "idle". Drives the mic button state. */
  micRecording: MicState;
  /**
   * True when the extension host reports a native recorder (ffmpeg /
   * sox / arecord / bundled). Drives `handleMicStart` to prefer the
   * extension path (avoids the Chromium permission-cache quirks the
   * webview path hits on VS Code-flavored hosts).
   */
  extensionMicAvailable: boolean;
  /** Dispatch handler for the `voiceTranscription` wire message. */
  handleVoiceTranscription: (text: string) => void;
  /** Dispatch handler for the `extensionMicAvailability` wire message. */
  handleExtensionMicAvailability: (payload: ExtensionMicAvailabilityPayload) => void;
  /** Dispatch handler for the `extensionMicError` wire message. */
  handleExtensionMicError: (payload: { message: string }) => void;
  /** User clicks the mic button to start. */
  handleMicStart: () => Promise<void>;
  /** User releases the mic button to stop. */
  handleMicStop: () => void;
}

/**
 * Owns the voice-input STT surface: micRecording state machine,
 * extensionMicAvailable cap, the MediaRecorder/MediaStream refs for
 * the webview-getUserMedia fallback path, the activeMicPathRef that
 * tells handleMicStop which path to tear down, the one-shot
 * `extensionMicProbe` on mount, and the platform-specific error
 * guidance (macOS TCC, Cursor/Code/Insiders quirks, Chromium webview
 * permission caches).
 *
 * Note: the inbound `extensionMicAvailability` message carries
 * `canAutoInstall` and `installerName` hints; we accept them on the
 * payload type so the wire format stays exact but don't surface them
 * locally — no UI consumes them today. If a one-click "install
 * ffmpeg" affordance lands later, plumb those fields here.
 */
export function useMicrophoneRecording(opts: UseMicrophoneRecordingOpts): MicrophoneRecordingHook {
  const { onToast, onTranscript } = opts;
  const [micRecording, setMicRecording] = useState<MicState>("idle");
  const [extensionMicAvailable, setExtensionMicAvailable] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  // Track which path is actively recording so handleMicStop knows
  // which teardown to run.
  const activeMicPathRef = useRef<"webview" | "extension" | null>(null);

  // Keep the latest callbacks in refs so the async handlers below
  // capture the current closures even if the consumer's callback
  // identities change between renders.
  const onToastRef = useRef(onToast);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onToastRef.current = onToast;
    onTranscriptRef.current = onTranscript;
  }, [onToast, onTranscript]);

  // One-shot capability probe at mount. Asks the extension whether
  // ffmpeg/sox is on PATH so the mic button can route to the
  // extension-side recorder (which avoids the webview's flaky
  // Chromium per-origin permission cache entirely). If unavailable,
  // we fall back to in-browser getUserMedia.
  useEffect(() => {
    vscode.postMessage({ type: "extensionMicProbe" });
  }, []);

  const handleVoiceTranscription = useCallback((text: string) => {
    setMicRecording("idle");
    activeMicPathRef.current = null;
    if (text) {
      onTranscriptRef.current(text);
    }
  }, []);

  const handleExtensionMicAvailability = useCallback(
    (payload: ExtensionMicAvailabilityPayload) => {
      setExtensionMicAvailable(payload.available);
    },
    []
  );

  const handleExtensionMicError = useCallback((payload: { message: string }) => {
    setMicRecording("idle");
    activeMicPathRef.current = null;
    onToastRef.current(`Microphone error: ${payload.message}`);
  }, []);

  const handleMicStart = useCallback(async () => {
    // Prefer extension-side recording when ffmpeg/sox is available.
    // No getUserMedia, no Chromium origin permission cache, no TCC
    // re-prompt fights. Just send a "start" to the extension and let
    // it spawn the recorder. The transcription comes back through the
    // existing voiceTranscription channel.
    if (extensionMicAvailable) {
      if (activeMicPathRef.current) {return;}
      activeMicPathRef.current = "extension";
      setMicRecording("recording");
      vscode.postMessage({ type: "extensionMicStart" });
      return;
    }

    // Fallback: webview getUserMedia. Same code path as before. This is
    // the path that hits the Chromium permission cache problems on
    // VS Code, hence the diagnostic toast in the catch block.
    if (mediaRecorderRef.current) {return;}
    activeMicPathRef.current = "webview";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordedChunksRef.current = [];
      // Prefer audio/webm;codecs=opus (supported everywhere Chromium
      // webviews run); fall back to whatever the browser picks.
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {recordedChunksRef.current.push(event.data);}
      });
      recorder.addEventListener("stop", async () => {
        setMicRecording("uploading");
        const chunks = recordedChunksRef.current;
        recordedChunksRef.current = [];
        const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
        // Tear down mic so the OS indicator goes away.
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        try {
          const buffer = await blob.arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.length; i++) {binary += String.fromCharCode(bytes[i]);}
          const base64 = btoa(binary);
          vscode.postMessage({
            type: "transcribeAudio",
            audioBase64: base64,
            mimeType: blob.type || "audio/webm"
          });
        } catch (err) {
          setMicRecording("idle");
          activeMicPathRef.current = null;
          console.warn("Mic encoding failed", err);
        }
      });
      recorder.start();
      setMicRecording("recording");
    } catch (err) {
      setMicRecording("idle");
      activeMicPathRef.current = null;
      // macOS TCC permission flow has a sharp edge: if the user ever
      // dismissed (or denied) the original "VS Code wants mic access"
      // OS prompt, that "deny" verdict gets cached in the TCC database
      // and CHECKING the Privacy & Security toggle in System Settings
      // does NOT clear the cached deny. The actual fix is
      // `tccutil reset Microphone <bundle-id>` to wipe both caches,
      // then restart the editor — the next mic request triggers the
      // OS prompt fresh.
      const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
      const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
      const isCursor = /cursor/i.test(ua);
      const isInsiders = /code.*insiders/i.test(ua);
      const bundleId = isCursor
        ? "com.todesktop.230313mzl4w4u92"
        : isInsiders
        ? "com.microsoft.VSCodeInsiders"
        : "com.microsoft.VSCode";
      const editorName = isCursor ? "Cursor" : isInsiders ? "VS Code Insiders" : "VS Code";
      const tccCommand = `tccutil reset Microphone ${bundleId}`;
      // Probe `navigator.permissions` to distinguish OS-level deny (TCC)
      // from a Chromium per-origin cached deny on the `vscode-webview://`
      // origin. The latter sticks around even after a TCC reset + OS
      // allow + window reload — Chromium's permission DB is independent
      // of the OS layer. The two cases need different fixes, so the
      // toast text branches on the probe result.
      let permState: PermissionState | "unsupported" = "unsupported";
      try {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName
        });
        permState = status.state;
      } catch {
        /* permissions API may not expose `microphone` on some webview builds */
      }
      const isWebviewCacheDeny =
        err instanceof Error && err.name === "NotAllowedError" && permState === "denied";

      let guidance: string;
      let toCopy: string | null = null;
      if (!isMac || !(err instanceof Error) || err.name !== "NotAllowedError") {
        guidance = `Could not start microphone: ${err instanceof Error ? err.message : String(err)}`;
      } else if (isWebviewCacheDeny) {
        // Chromium has cached a deny verdict for the webview origin.
        // Reloading doesn't clear it — only a full editor restart with
        // a wiped webview cache (or an extension reinstall) does.
        // The recovery command needs three things to actually work
        // when pasted into a terminal:
        // 1) Quit by app name via `osascript`, NOT `killall <process>`
        // (VS Code's process is `Code`, Cursor's is `Cursor`,
        // Insiders' is `Code - Insiders` — and `killall "VS Code"`
        // finds nothing). osascript quits cleanly regardless.
        // 2) `$HOME` expansion, NOT `~` inside double quotes (`~`
        // doesn't expand when quoted, so the rm targets the wrong
        // path and silently no-ops).
        // 3) Quit BEFORE deleting cache — VS Code rewrites cache
        // files on shutdown and can race the rm.
        const appName = isCursor
          ? "Cursor"
          : isInsiders
          ? "Visual Studio Code - Insiders"
          : "Visual Studio Code";
        const cacheSegment = isCursor
          ? "Cursor"
          : isInsiders
          ? "Code - Insiders"
          : "Code";
        toCopy =
          `osascript -e 'tell application "${appName}" to quit' && ` +
          `rm -rf "$HOME/Library/Application Support/${cacheSegment}/Cache"`;
        guidance =
          `Microphone blocked at the webview layer (perm state: denied). The OS allow you just gave is fine — but Chromium has cached an old "denied" verdict for this webview origin and a reload won't clear it.\n\n` +
          `Two options to recover:\n` +
          `  1. Cmd+Q ${editorName} fully (not just close the window), then reopen and try again.\n` +
          `  2. If that still doesn't work, clear the webview cache. I copied this command to your clipboard:\n\n    ${toCopy}`;
      } else {
        toCopy = tccCommand;
        guidance =
          `Microphone blocked. The OS toggle isn't enough once a deny is cached in TCC. ` +
          `I copied the reset command to your clipboard — paste it in a terminal:\n\n    ${tccCommand}\n\n` +
          `Then Cmd+Q ${editorName} (close window won't do it) and reopen. The mic prompt will reappear; click Allow.`;
      }
      if (toCopy) {
        try { await navigator.clipboard.writeText(toCopy); } catch { /* clipboard may be unavailable */ }
      }
      onToastRef.current(guidance);
    }
  }, [extensionMicAvailable]);

  const handleMicStop = useCallback(() => {
    // Route to whichever path actually started recording. Without this
    // dispatch, the webview path is the only one wired and a stop on
    // an extension-side recording would silently no-op (process keeps
    // capturing audio until the OS / our cleanup tears it down).
    if (activeMicPathRef.current === "extension") {
      setMicRecording("uploading");
      vscode.postMessage({ type: "extensionMicStop" });
      return;
    }
    const recorder = mediaRecorderRef.current;
    if (!recorder) {return;}
    if (recorder.state !== "inactive") {recorder.stop();}
  }, []);

  return {
    micRecording,
    extensionMicAvailable,
    handleVoiceTranscription,
    handleExtensionMicAvailability,
    handleExtensionMicError,
    handleMicStart,
    handleMicStop
  };
}
