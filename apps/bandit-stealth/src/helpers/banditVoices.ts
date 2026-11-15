/**
 * The four Bandit Cloud voices, and the mapping that moves a saved older
 * voice id onto one of them.
 *
 * Bandit Cloud TTS now offers Heart, Michael, Emma and George (Kokoro voices
 * served by the Bandit gateway). The old default was the ElevenLabs voice
 * `en_US-brian-premium`; the gateway keeps accepting the old ids as aliases,
 * but the extension stops sending them.
 *
 * `banditStealth.voice.voiceId` is shared with the bring-your-own providers
 * (OpenAI voice names, ElevenLabs voice ids), so the setting stays a string
 * and the mapping only applies when the value is used for, or clearly belongs
 * to, Bandit Cloud. See migrateBanditVoiceSetting.
 */
import type * as vscode from 'vscode';

export interface BanditVoice {
  id: string;
  name: string;
  accent: 'American' | 'British';
  gender: 'woman' | 'man';
}

export const BANDIT_VOICES: readonly BanditVoice[] = [
  { id: 'kokoro-af_heart', name: 'Heart', accent: 'American', gender: 'woman' },
  { id: 'kokoro-am_michael', name: 'Michael', accent: 'American', gender: 'man' },
  { id: 'kokoro-bf_emma', name: 'Emma', accent: 'British', gender: 'woman' },
  { id: 'kokoro-bm_george', name: 'George', accent: 'British', gender: 'man' }
];

export const DEFAULT_BANDIT_VOICE = 'kokoro-af_heart';

const HEART = 'kokoro-af_heart';
const MICHAEL = 'kokoro-am_michael';
const EMMA = 'kokoro-bf_emma';
const GEORGE = 'kokoro-bm_george';

// Chatterbox (-local) voices with a matching family; the rest become Heart.
const LOCAL_FAMILY: Record<string, string> = {
  heart: HEART,
  bella: HEART,
  michael: MICHAEL,
  studio: MICHAEL,
  emma: EMMA
};

// Kokoro English voices whose gender we know, for -standard aliases
// (en_US-<name>-standard is kokoro-a?_<name>).
const KOKORO_FEMALE = new Set([
  'alloy', 'aoede', 'bella', 'heart', 'jessica', 'kore', 'nicole', 'nova', 'river', 'sarah', 'sky',
  'alice', 'emma', 'isabella', 'lily'
]);
const KOKORO_MALE = new Set([
  'adam', 'echo', 'eric', 'fenrir', 'liam', 'michael', 'onyx', 'puck', 'santa',
  'daniel', 'fable', 'george', 'lewis'
]);

export function isBanditVoiceId(id: string | undefined | null): boolean {
  return Boolean(id) && BANDIT_VOICES.some((v) => v.id === id);
}

/** True when a value can only have been meant for Bandit Cloud TTS. */
export function looksLikeBanditVoiceId(id: string | undefined | null): boolean {
  const v = (id ?? '').trim().toLowerCase();
  if (!v) {return false;}
  return (
    v.startsWith('kokoro-') ||
    /^[a-z]{2}_[a-z]{2}-[a-z0-9]+-(premium|ivc|r|medium|low|high|standard|local)$/.test(v)
  );
}

/**
 * Map any voice id onto one of the four Bandit Cloud voices. The four ids map
 * to themselves; anything unrecognised becomes Heart.
 */
export function migrateBanditVoiceId(id: string | undefined | null): string {
  const raw = (id ?? '').trim();
  if (!raw) {return DEFAULT_BANDIT_VOICE;}
  const exact = BANDIT_VOICES.find((voice) => voice.id.toLowerCase() === raw.toLowerCase());
  if (exact) {return exact.id;}
  const v = raw.toLowerCase();

  // Kokoro ids: kokoro-af_x, kokoro-am_x, kokoro-bf_x, kokoro-bm_x.
  const kokoro = /^kokoro-([a-z])([fm])_/.exec(v);
  if (kokoro) {
    const [, lang, gender] = kokoro;
    if (lang === 'b') {return gender === 'm' ? GEORGE : EMMA;}
    return gender === 'm' ? MICHAEL : HEART;
  }

  const named = /^([a-z]{2})_([a-z]{2})-([a-z0-9]+)-([a-z]+)$/.exec(v);
  if (named) {
    const [, , region, name, suffix] = named;
    if (suffix === 'standard') {
      const british = region === 'gb';
      if (KOKORO_MALE.has(name)) {return british ? GEORGE : MICHAEL;}
      if (KOKORO_FEMALE.has(name)) {return british ? EMMA : HEART;}
      return HEART;
    }
    if (suffix === 'local') {
      return LOCAL_FAMILY[name] ?? HEART;
    }
    if (suffix === 'premium' || suffix === 'ivc' || suffix === 'r') {
      return name === 'jessica' || name === 'matilda' ? HEART : MICHAEL;
    }
    if (name === 'ryan') {return MICHAEL;}
  }

  return HEART;
}

type Inspected = {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
};

/**
 * Rewrite a saved `voice.voiceId` onto one of the four voices, at each scope
 * that holds a value. Nothing is written where the user never set one.
 *
 * A value is migrated when the TTS provider is set to `bandit`, or when the
 * value itself is a Bandit id (an old `-premium` name, a `kokoro-` id, ...).
 * OpenAI voice names and ElevenLabs voice ids used with the bring-your-own
 * providers are left alone.
 *
 * Returns the scopes that were rewritten.
 */
export async function migrateBanditVoiceSetting(
  configuration: vscode.WorkspaceConfiguration,
  targets: { global: vscode.ConfigurationTarget; workspace: vscode.ConfigurationTarget; folder: vscode.ConfigurationTarget }
): Promise<vscode.ConfigurationTarget[]> {
  const provider = configuration.get<string>('voice.tts.provider', 'auto');
  const info = configuration.inspect<string>('voice.voiceId') as Inspected | undefined;
  const scopes: Array<[unknown, vscode.ConfigurationTarget]> = [
    [info?.globalValue, targets.global],
    [info?.workspaceValue, targets.workspace],
    [info?.workspaceFolderValue, targets.folder]
  ];
  const rewritten: vscode.ConfigurationTarget[] = [];
  for (const [value, target] of scopes) {
    if (typeof value !== 'string' || !value.trim()) {continue;}
    if (provider !== 'bandit' && !looksLikeBanditVoiceId(value)) {continue;}
    const next = migrateBanditVoiceId(value);
    if (next === value) {continue;}
    try {
      await configuration.update('voice.voiceId', next, target);
      rewritten.push(target);
    } catch {
      // Never block activation; the request path maps the value anyway.
    }
  }
  return rewritten;
}
