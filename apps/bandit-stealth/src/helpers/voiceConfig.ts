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
import { readMigratedSecret } from './secretMigration';
import { VOICE_STT_API_KEY_SECRET_KEY, VOICE_TTS_API_KEY_SECRET_KEY } from '../storageKeys';

type VoiceProviderSettings = NonNullable<WebviewState['voiceProviderSettings']>;

/**
 * Read the per-provider voice settings (STT + TTS adapters, URLs,
 * keys, models, voice id). Used to populate the Voice settings tab
 * without hand-editing settings.json.
 *
 * The two apiKey fields come from SecretStorage, not the workspace
 * config. They used to be plain settings — the doc comment here argued
 * they should "travel with workspace files for self-hosted multi-machine
 * setups", which is another way of saying a bearer token got committed
 * to a repo. They are bearer tokens for third-party endpoints (OpenAI,
 * ElevenLabs) and belong in the keychain like every other key.
 */
export async function readVoiceProviderSettings(
  configuration: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage
): Promise<VoiceProviderSettings> {
  return {
    sttProvider: configuration.get<'bandit' | 'openai-whisper' | 'custom'>('voice.stt.provider', 'bandit'),
    sttUrl: configuration.get<string>('voice.stt.url', '') ?? '',
    sttApiKey: await readMigratedSecret(secrets, VOICE_STT_API_KEY_SECRET_KEY, configuration, 'voice.stt.apiKey'),
    sttModel: configuration.get<string>('voice.stt.model', 'whisper-1') ?? 'whisper-1',
    ttsProvider: configuration.get<'bandit' | 'openai' | 'elevenlabs' | 'piper' | 'custom'>('voice.tts.provider', 'bandit'),
    ttsUrl: configuration.get<string>('voice.tts.url', '') ?? '',
    ttsApiKey: await readMigratedSecret(secrets, VOICE_TTS_API_KEY_SECRET_KEY, configuration, 'voice.tts.apiKey'),
    ttsModel: configuration.get<string>('voice.tts.model', 'tts-1') ?? 'tts-1',
    ttsVoiceId: configuration.get<string>('voice.voiceId', 'en_US-brian-premium') ?? 'en_US-brian-premium'
  };
}

/**
 * A `VoiceConfig` that resolves the two apiKey sections from SecretStorage
 * and delegates everything else to the workspace configuration.
 *
 * This is what keeps the adapters in voiceProviders.ts synchronous. They
 * read their whole configuration through one `get(section, default)` call,
 * so swapping the backing store for two of those sections needs an overlay
 * here rather than an async rewrite of every adapter.
 */
export async function buildVoiceConfig(
  configuration: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage
): Promise<{ get<T>(section: string, defaultValue: T): T }> {
  const sttApiKey = await readMigratedSecret(secrets, VOICE_STT_API_KEY_SECRET_KEY, configuration, 'voice.stt.apiKey');
  const ttsApiKey = await readMigratedSecret(secrets, VOICE_TTS_API_KEY_SECRET_KEY, configuration, 'voice.tts.apiKey');
  return {
    get: <T,>(section: string, defaultValue: T): T => {
      if (section === 'voice.stt.apiKey') {return (sttApiKey as unknown as T) ?? defaultValue;}
      if (section === 'voice.tts.apiKey') {return (ttsApiKey as unknown as T) ?? defaultValue;}
      return configuration.get<T>(section, defaultValue);
    }
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
