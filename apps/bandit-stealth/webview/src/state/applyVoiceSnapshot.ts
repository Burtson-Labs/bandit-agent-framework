import type { VoiceProviderSettings } from "../components/SettingsPanel";
import type { WebviewState } from "../types/webview";

/**
 * Setter surface for the voice slice — mic enabled, auto-speak +
 * mic-pref toggles, and the full voice provider settings record (STT
 * + TTS providers/URLs/keys/models). `voiceProviderSettings` is only
 * applied when present on the wire: omitting it preserves whatever
 * the user is currently editing, instead of clobbering with empty
 * defaults on each state push.
 */
export interface VoiceSnapshotDeps {
  setVoiceMicEnabled: (value: boolean) => void;
  setVoiceAutoSpeakPref: (value: boolean) => void;
  setVoiceMicPref: (value: boolean) => void;
  setVoiceProviderSettings: (value: VoiceProviderSettings) => void;
}

export function applyVoiceSnapshot(state: WebviewState, deps: VoiceSnapshotDeps): void {
  deps.setVoiceMicEnabled(state.voiceMicEnabled === true);
  deps.setVoiceAutoSpeakPref(state.voiceAutoSpeakPref === true);
  deps.setVoiceMicPref(state.voiceMicPref === true);
  if (state.voiceProviderSettings) {
    deps.setVoiceProviderSettings(state.voiceProviderSettings);
  }
}
