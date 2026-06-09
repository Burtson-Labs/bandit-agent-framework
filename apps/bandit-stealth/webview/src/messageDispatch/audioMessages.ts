import type {
  AudioErrorPayload,
  PlayAudioPayload
} from "../hooks/useAudioPlayback";
import type { WebviewMessage } from "../types/webviewMessage";

export interface AudioMessagesDeps {
  handlePlayAudio: (payload: PlayAudioPayload) => void;
  handleAudioError: (payload: AudioErrorPayload) => void;
}

/**
 * Topic dispatcher for the TTS playback signal stream. Both cases
 * delegate straight into the audio-playback hook.
 */
export function dispatchAudioMessage(
  message: WebviewMessage,
  deps: AudioMessagesDeps
): boolean {
  switch (message.type) {
    case "playAudio":
      deps.handlePlayAudio(message);
      return true;
    case "audioError":
      deps.handleAudioError(message);
      return true;
    default:
      return false;
  }
}
