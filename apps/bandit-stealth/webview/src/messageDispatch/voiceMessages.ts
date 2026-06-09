import type { WebviewMessage } from "../types/webviewMessage";

export interface VoiceMessagesDeps {
  handleVoiceTranscription: (text: string) => void;
  handleExtensionMicAvailability: (payload: {
    available: boolean;
    message?: string;
    kind?: "bundled" | "ffmpeg" | "sox" | "arecord";
    canAutoInstall?: boolean;
    installerName?: string;
  }) => void;
  handleExtensionMicError: (payload: { message: string }) => void;
}

/**
 * Topic dispatcher for voice/STT-related webview messages — the
 * transcription that the composer absorbs, the extension-mic
 * capability availability probe response, and any extension-mic
 * runtime errors.
 */
export function dispatchVoiceMessage(
  message: WebviewMessage,
  deps: VoiceMessagesDeps
): boolean {
  switch (message.type) {
    case "voiceTranscription":
      deps.handleVoiceTranscription(message.text);
      return true;
    case "extensionMicAvailability":
      deps.handleExtensionMicAvailability(message);
      return true;
    case "extensionMicError":
      deps.handleExtensionMicError(message);
      return true;
    default:
      return false;
  }
}
