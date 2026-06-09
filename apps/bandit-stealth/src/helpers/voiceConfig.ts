/**
 * Voice settings readers extracted from extension.ts/flushState.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. flushState (the WebviewState assembler)
 * is tangled enough that wholesale extraction would need a 30-field
 * context bag — but a few pieces of it are genuinely pure config
 * readers that only need a `vscode.WorkspaceConfiguration`. The
 * voice block was the largest such island (~10 lines for provider
 * settings, plus the gates), so it's pulled here.
 */
import type * as vscode from 'vscode';
import type { WebviewState } from '../agentTypes';

type VoiceProviderSettings = NonNullable<WebviewState['voiceProviderSettings']>;

/**
 * Read the per-provider voice settings (STT + TTS adapters, URLs,
 * keys, models, voice id) from the workspace config. Used to
 * populate the Voice settings tab without hand-editing settings.json.
 *
 * apiKey fields stay in plain workspace settings (not Secrets)
 * because they have to travel with workspace files for self-hosted
 * multi-machine setups. Sensitive cloud keys belong on the Bandit
 * cloud provider, which uses VS Code Secrets.
 */
export function readVoiceProviderSettings(configuration: vscode.WorkspaceConfiguration): VoiceProviderSettings {
  return {
    sttProvider: configuration.get<'bandit' | 'openai-whisper' | 'custom'>('voice.stt.provider', 'bandit'),
    sttUrl: configuration.get<string>('voice.stt.url', '') ?? '',
    sttApiKey: configuration.get<string>('voice.stt.apiKey', '') ?? '',
    sttModel: configuration.get<string>('voice.stt.model', 'whisper-1') ?? 'whisper-1',
    ttsProvider: configuration.get<'bandit' | 'openai' | 'elevenlabs' | 'piper' | 'custom'>('voice.tts.provider', 'bandit'),
    ttsUrl: configuration.get<string>('voice.tts.url', '') ?? '',
    ttsApiKey: configuration.get<string>('voice.tts.apiKey', '') ?? '',
    ttsModel: configuration.get<string>('voice.tts.model', 'tts-1') ?? 'tts-1',
    ttsVoiceId: configuration.get<string>('voice.voiceId', 'en_US-brian-premium') ?? 'en_US-brian-premium'
  };
}

export interface VoiceGates {
  /** True when the webview should render the mic button. Composed of
   *  "user has a Bandit API key" AND "user opted into voice.micEnabled".
   *  Provider doesn't matter — the cloud STT endpoint is available to
   *  anyone with a Bandit account regardless of whether they're
   *  running Ollama locally. Without an API key the button is hidden
   *  entirely (it would fail on click and there's no UX value showing
   *  a button the user can't use). */
  micEnabled: boolean;
  /** Raw user preference for auto-speak (assistant TTS) — what the
   *  toggle in Settings → Voice is set to, NOT a derived gate. */
  autoSpeakPref: boolean;
  /** Raw user preference for the mic button — what the toggle in
   *  Settings → Voice is set to, NOT the derived `micEnabled` above. */
  micPref: boolean;
}

/** Read the voice gates that drive the mic button's visibility. */
export function readVoiceGates(
  configuration: vscode.WorkspaceConfiguration,
  hasStoredApiKey: boolean
): VoiceGates {
  const micPref = configuration.get<boolean>('voice.micEnabled', false) ?? false;
  return {
    micEnabled: hasStoredApiKey && micPref,
    autoSpeakPref: configuration.get<boolean>('voice.autoSpeak', false) ?? false,
    micPref
  };
}
