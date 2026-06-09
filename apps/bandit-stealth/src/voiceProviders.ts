/**
 * Voice provider adapters — STT + TTS dispatch keyed off
 * `banditStealth.voice.stt.provider` / `voice.tts.provider`.
 *
 * Why this lives in its own file: the chat provider and the voice
 * provider are independent. A user can run Ollama for chat and Bandit
 * cloud for voice (cheap pleasant TTS without burning chat tokens), or
 * run Bandit cloud for chat and a self-hosted Whisper for STT (privacy,
 * cost). Keeping the adapters here means the gating logic in
 * extension.ts stays one-line: "ask the adapter if it's ready, call it
 * if so."
 *
 * Each adapter takes the workspace configuration + a Bandit API key
 * (only relevant for the bandit provider) and returns either the
 * resolved audio (TTS) or transcription text (STT). Errors are
 * surfaced as thrown Errors so the caller renders one consistent
 * `audioError` / `notification` toast.
 */

export interface VoiceConfig {
  /** Resolved at the call site by the extension via `getConfiguration('banditStealth')`. */
  get<T>(section: string, defaultValue: T): T;
}

export type SttProvider = 'bandit' | 'openai-whisper' | 'custom';
export type TtsProvider = 'bandit' | 'openai' | 'elevenlabs' | 'piper' | 'custom';

/** Whether the configured provider needs a Bandit API key. Used by
 *  the gate that previously refused all voice without a Bandit key —
 *  now only Bandit cloud requires one. */
export function sttRequiresBanditKey(provider: SttProvider): boolean {
  return provider === 'bandit';
}
export function ttsRequiresBanditKey(provider: TtsProvider): boolean {
  return provider === 'bandit';
}

export interface SttRequest {
  audioBytes: Uint8Array;
  mimeType: string;
  /** Bandit cloud key. Only consulted when provider = 'bandit'. */
  banditApiKey?: string;
  /** Resolved Bandit gateway URL (api/stealth/stt/transcribe). Only
   *  consulted when provider = 'bandit'. */
  banditUrl?: string;
}

export interface TtsRequest {
  text: string;
  /** Bandit voice id ("en_US-brian-premium") or the OpenAI/ElevenLabs
   *  voice name. Adapters that don't take a voice (Piper) ignore it. */
  voice: string;
  banditApiKey?: string;
  banditUrl?: string;
}

export interface SttResult {
  /** Plain transcription text. */
  text: string;
}

export interface TtsResult {
  /** Raw audio bytes. */
  audio: Uint8Array;
  /** MIME type the webview should use to construct the Audio element.
   *  Bandit/OpenAI/ElevenLabs return mp3; Piper returns wav. */
  mimeType: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  bandit: 'Bandit cloud',
  'openai-whisper': 'OpenAI-compatible Whisper',
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  piper: 'Piper',
  custom: 'Custom endpoint'
};
export function describeProvider(name: string): string {
  return PROVIDER_LABEL[name] ?? name;
}

// ─── STT ──────────────────────────────────────────────────────────────────────

export async function transcribeAudio(
  config: VoiceConfig,
  req: SttRequest
): Promise<SttResult> {
  const provider = config.get<SttProvider>('voice.stt.provider', 'bandit');
  if (provider === 'bandit') {
    if (!req.banditApiKey || !req.banditUrl) {
      throw new Error('Bandit STT needs a Bandit API key — set one in Account, or switch the STT provider in Voice settings.');
    }
    return transcribeBandit(req.banditUrl, req.banditApiKey, req.audioBytes, req.mimeType);
  }
  if (provider === 'openai-whisper' || provider === 'custom') {
    const url = config.get<string>('voice.stt.url', '').trim();
    if (!url) {
      throw new Error(`STT provider is "${describeProvider(provider)}" but no URL is configured. Set banditStealth.voice.stt.url.`);
    }
    const apiKey = config.get<string>('voice.stt.apiKey', '').trim();
    const model = config.get<string>('voice.stt.model', 'whisper-1').trim();
    return transcribeWhisperCompatible(url, apiKey || undefined, model || undefined, req.audioBytes, req.mimeType);
  }
  throw new Error(`Unknown STT provider: ${provider}`);
}

async function transcribeBandit(url: string, apiKey: string, bytes: Uint8Array, mimeType: string): Promise<SttResult> {
  const form = new FormData();
  const blob = new Blob([bytes], { type: mimeType || 'audio/webm' });
  form.append('audio', blob, `recording.${(mimeType || 'audio/webm').split('/').pop() ?? 'webm'}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bandit STT failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await response.json() as { transcription?: string };
  // The gateway wraps stt-api's `{text:"..."}` JSON STRING in a
  // `transcription` field — try-parse so we hand back plain text.
  const raw = (data?.transcription ?? '').trim();
  let text = raw;
  if (raw.startsWith('{')) {
    try {
      const inner = JSON.parse(raw) as { text?: string; transcription?: string };
      const innerText = inner?.text ?? inner?.transcription;
      if (typeof innerText === 'string') {text = innerText.trim();}
    } catch { /* not JSON, keep raw */ }
  }
  return { text };
}

async function transcribeWhisperCompatible(
  url: string,
  apiKey: string | undefined,
  model: string | undefined,
  bytes: Uint8Array,
  mimeType: string
): Promise<SttResult> {
  // OpenAI-compatible Whisper expects multipart with `file` (not `audio`)
  // and accepts a `model` field. faster-whisper-server, whisper.cpp HTTP,
  // LiteLLM, vLLM-Whisper, and the real OpenAI all match this.
  const form = new FormData();
  const ext = (mimeType || 'audio/webm').split('/').pop() ?? 'webm';
  form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), `recording.${ext}`);
  if (model) {form.append('model', model);}
  const headers: Record<string, string> = {};
  if (apiKey) {headers['Authorization'] = `Bearer ${apiKey}`;}
  const response = await fetch(url, { method: 'POST', headers, body: form });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`STT failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  // OpenAI returns { text: "..." }. Some servers return plain text.
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = await response.json() as { text?: string; transcription?: string };
    return { text: (data.text ?? data.transcription ?? '').trim() };
  }
  return { text: (await response.text()).trim() };
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

export async function synthesizeSpeech(config: VoiceConfig, req: TtsRequest): Promise<TtsResult> {
  const provider = config.get<TtsProvider>('voice.tts.provider', 'bandit');
  if (provider === 'bandit') {
    if (!req.banditApiKey || !req.banditUrl) {
      throw new Error('Bandit TTS needs a Bandit API key — set one in Account, or switch the TTS provider in Voice settings.');
    }
    return ttsBandit(req.banditUrl, req.banditApiKey, req.text, req.voice);
  }
  const url = config.get<string>('voice.tts.url', '').trim();
  const apiKey = config.get<string>('voice.tts.apiKey', '').trim();
  const model = config.get<string>('voice.tts.model', 'tts-1').trim();
  if (provider === 'openai') {
    const target = url || 'https://api.openai.com/v1/audio/speech';
    return ttsOpenAI(target, apiKey, model || 'tts-1', req.text, req.voice || 'alloy');
  }
  if (provider === 'elevenlabs') {
    const base = url || 'https://api.elevenlabs.io';
    return ttsElevenLabs(base, apiKey, model || 'eleven_monolingual_v1', req.text, req.voice);
  }
  if (provider === 'piper') {
    if (!url) {throw new Error('Piper TTS needs banditStealth.voice.tts.url set to your Piper HTTP server.');}
    return ttsPiper(url, req.text);
  }
  if (provider === 'custom') {
    if (!url) {throw new Error('Custom TTS needs banditStealth.voice.tts.url. Body shape: { text, voice }, response: audio bytes.');}
    return ttsCustom(url, apiKey, req.text, req.voice);
  }
  throw new Error(`Unknown TTS provider: ${provider}`);
}

async function ttsBandit(url: string, apiKey: string, text: string, voice: string): Promise<TtsResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ Text: text, ModelName: voice })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bandit TTS failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: 'audio/mpeg' };
}

async function ttsOpenAI(url: string, apiKey: string, model: string, text: string, voice: string): Promise<TtsResult> {
  if (!apiKey) {throw new Error('OpenAI TTS needs banditStealth.voice.tts.apiKey set.');}
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text, voice, response_format: 'mp3' })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: 'audio/mpeg' };
}

async function ttsElevenLabs(base: string, apiKey: string, model: string, text: string, voiceId: string): Promise<TtsResult> {
  if (!apiKey) {throw new Error('ElevenLabs needs banditStealth.voice.tts.apiKey set.');}
  if (!voiceId) {throw new Error('ElevenLabs needs a voice id in banditStealth.voice.voiceId.');}
  const trimmed = base.replace(/\/+$/, '');
  // Allow either the bare base ("https://api.elevenlabs.io") or the
  // full template-with-voice URL. If the URL already ends with the
  // voice id placeholder, leave it alone; otherwise build it.
  const url = trimmed.includes('/text-to-speech/')
    ? trimmed
    : `${trimmed}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: 'audio/mpeg' };
}

async function ttsPiper(url: string, text: string): Promise<TtsResult> {
  // Piper's HTTP server takes the text in the request body or query
  // string depending on the implementation; the most common pattern is
  // a raw POST with `text/plain`. Servers that prefer JSON accept
  // `{ text }` too — we send both shapes by negotiation: try plain
  // first, fall back to JSON on 415.
  const tryPlain = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text
  });
  let response = tryPlain;
  if (response.status === 415 || response.status === 400) {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Piper TTS failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: 'audio/wav' };
}

async function ttsCustom(url: string, apiKey: string, text: string, voice: string): Promise<TtsResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {headers['Authorization'] = `Bearer ${apiKey}`;}
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, voice })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Custom TTS failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  // Custom servers may return audio bytes directly OR a JSON wrapper
  // like `{ audio: "<base64>", mimeType: "audio/mpeg" }`. Auto-detect
  // by content-type.
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = await response.json() as { audio?: string; mimeType?: string };
    if (typeof data.audio !== 'string') {throw new Error('Custom TTS JSON response missing `audio` (base64).');}
    return { audio: Uint8Array.from(Buffer.from(data.audio, 'base64')), mimeType: data.mimeType ?? 'audio/mpeg' };
  }
  return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: ct || 'audio/mpeg' };
}
