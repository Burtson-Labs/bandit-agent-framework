import { describe, expect, it, vi } from "vitest";
import { applyVoiceSnapshot } from "../../src/state/applyVoiceSnapshot";
import type { WebviewState } from "../../src/types/webview";

const makeDeps = () => ({
  setVoiceMicEnabled: vi.fn(),
  setVoiceAutoSpeakPref: vi.fn(),
  setVoiceMicPref: vi.fn(),
  setVoiceProviderSettings: vi.fn()
});

const baseState = {
  messages: [],
  hasApiKey: false,
  hasStoredApiKey: false,
  requiresApiKey: false,
  isBusy: false,
  provider: "bandit",
  model: "bandit-core-1",
  mode: "ask",
  history: [],
  hasArchivedConversations: false,
  showHistory: false,
  allowImageUploads: false,
  showIntentChips: false,
  feedbackEnabled: false,
  contextUsage: null
} as WebviewState;

const fullProviderSettings: WebviewState["voiceProviderSettings"] = {
  sttProvider: "bandit",
  sttUrl: "https://stt.example",
  sttApiKey: "k1",
  sttModel: "whisper-1",
  ttsProvider: "openai",
  ttsUrl: "https://tts.example",
  ttsApiKey: "k2",
  ttsModel: "tts-1",
  ttsVoiceId: "alloy"
};

describe("applyVoiceSnapshot", () => {
  it("voiceProviderSettings is only applied when present so an in-flight edit is not clobbered by a partial state push", () => {
    const deps = makeDeps();
    applyVoiceSnapshot(baseState, deps);
    expect(deps.setVoiceProviderSettings).not.toHaveBeenCalled();

    applyVoiceSnapshot({ ...baseState, voiceProviderSettings: fullProviderSettings }, deps);
    expect(deps.setVoiceProviderSettings).toHaveBeenCalledWith(fullProviderSettings);
  });

  it("voice booleans use strict-true equality (not truthy) so persisted strings do not silently flip the mic on", () => {
    const deps = makeDeps();
    applyVoiceSnapshot(
      {
        ...baseState,
        voiceMicEnabled: "true" as unknown as boolean,
        voiceAutoSpeakPref: 1 as unknown as boolean,
        voiceMicPref: "yes" as unknown as boolean
      },
      deps
    );
    expect(deps.setVoiceMicEnabled).toHaveBeenCalledWith(false);
    expect(deps.setVoiceAutoSpeakPref).toHaveBeenCalledWith(false);
    expect(deps.setVoiceMicPref).toHaveBeenCalledWith(false);
  });

  it("forwards explicit-true voice flags to their setters", () => {
    const deps = makeDeps();
    applyVoiceSnapshot(
      {
        ...baseState,
        voiceMicEnabled: true,
        voiceAutoSpeakPref: true,
        voiceMicPref: true
      },
      deps
    );
    expect(deps.setVoiceMicEnabled).toHaveBeenCalledWith(true);
    expect(deps.setVoiceAutoSpeakPref).toHaveBeenCalledWith(true);
    expect(deps.setVoiceMicPref).toHaveBeenCalledWith(true);
  });
});
