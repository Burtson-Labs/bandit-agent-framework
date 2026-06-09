/**
 * Contract tests for `VoiceService` — the speech surface.
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) `maybeAutoSpeak` honors the four gates (autoSpeak off →
 *     skip; bandit-provider but no key → audioError; no speakable
 *     text → silent skip; over word cap → silent skip),
 * (2) `handleSpeak` short-circuits with an audioError when the
 *     bandit TTS provider is configured but no key is stored — never
 *     silently fails,
 * (3) `handleTranscribe` posts the parsed transcription as a
 *     `voiceTranscription` event when the STT call returns text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';
import type { ProviderContext } from '../../src/provider/context';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get<T>(key: string, fallback?: T): T {
        return ((configMap.get(key) ?? fallback) as unknown) as T;
      }
    })
  },
  window: {
    createTerminal: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined)
  },
  commands: { executeCommand: vi.fn(async () => undefined) }
}));

const configMap = new Map<string, unknown>();

vi.mock('../../src/voiceProviders', () => ({
  synthesizeSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
  sttRequiresBanditKey: (p: string) => p === 'bandit',
  ttsRequiresBanditKey: (p: string) => p === 'bandit'
}));

vi.mock('../../src/extensionRecorder', () => ({
  probeRecorder: () => ({ available: true, kind: 'native', message: undefined }),
  getInstallHint: () => ({ manager: null, command: 'no-manager', friendlyName: undefined }),
  startRecording: vi.fn(async () => undefined),
  stopRecording: vi.fn(async () => Buffer.from('audio')),
  cancelRecording: vi.fn()
}));

vi.mock('../../src/helpers/endpoints', () => ({
  resolveTtsUrl: () => 'https://api.example/tts',
  resolveSttUrl: () => 'https://api.example/stt'
}));

vi.mock('../../src/helpers/speakableText', () => ({
  extractSpeakableText: (s: string) => s.replace(/```[\s\S]*?```/g, '').trim()
}));

import * as voiceProviders from '../../src/voiceProviders';
import { VoiceService } from '../../src/provider/services/voiceService';

function makeCtx(options: { storedApiKey?: string } = {}): { ctx: ProviderContext; posted: Array<Record<string, unknown>> } {
  const posted: Array<Record<string, unknown>> = [];
  const ctx = {
    extensionContext: {
      secrets: { get: vi.fn(async () => options.storedApiKey) }
    },
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); }
  } as unknown as ProviderContext;
  return { ctx, posted };
}

function makeEntry(content: string): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0 };
}

function fakeConfiguration() {
  return {
    get<T>(key: string, fallback?: T): T {
      return ((configMap.get(key) ?? fallback) as unknown) as T;
    }
  } as unknown as import('vscode').WorkspaceConfiguration;
}

beforeEach(() => {
  configMap.clear();
  vi.mocked(voiceProviders.synthesizeSpeech).mockReset();
  vi.mocked(voiceProviders.transcribeAudio).mockReset();
});

describe('VoiceService', () => {
  it('maybeAutoSpeak honors the four gates (off → skip, missing key → audioError, no speakable text → silent, over word cap → silent)', async () => {
    // Gate 1: autoSpeak off
    {
      const { ctx, posted } = makeCtx({ storedApiKey: 'sk_live_ok' });
      const svc = new VoiceService(ctx);
      configMap.set('voice.autoSpeak', false);
      await svc.maybeAutoSpeak(makeEntry('hello'), fakeConfiguration(), 'sk_live_ok', 'bandit');
      expect(posted).toHaveLength(0);
      expect(vi.mocked(voiceProviders.synthesizeSpeech)).not.toHaveBeenCalled();
    }

    // Gate 2: bandit TTS configured but no key
    {
      const { ctx, posted } = makeCtx();
      const svc = new VoiceService(ctx);
      configMap.set('voice.autoSpeak', true);
      configMap.set('voice.tts.provider', 'bandit');
      await svc.maybeAutoSpeak(makeEntry('hello'), fakeConfiguration(), undefined, 'bandit');
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ type: 'audioError' });
      expect((posted[0] as { message: string }).message).toContain('Bandit API key');
      expect(vi.mocked(voiceProviders.synthesizeSpeech)).not.toHaveBeenCalled();
    }

    // Gate 3: no speakable text (everything fenced)
    {
      const { ctx, posted } = makeCtx({ storedApiKey: 'sk_live_ok' });
      const svc = new VoiceService(ctx);
      configMap.set('voice.autoSpeak', true);
      configMap.set('voice.tts.provider', 'bandit');
      await svc.maybeAutoSpeak(makeEntry('```ts\ncode only\n```'), fakeConfiguration(), 'sk_live_ok', 'bandit');
      expect(posted).toHaveLength(0); // silent skip
      expect(vi.mocked(voiceProviders.synthesizeSpeech)).not.toHaveBeenCalled();
    }

    // Gate 4: over the word cap
    {
      const { ctx, posted } = makeCtx({ storedApiKey: 'sk_live_ok' });
      const svc = new VoiceService(ctx);
      configMap.set('voice.autoSpeak', true);
      configMap.set('voice.tts.provider', 'bandit');
      configMap.set('voice.maxAutoSpeakWords', 5);
      const longText = 'one two three four five six seven eight nine ten';
      await svc.maybeAutoSpeak(makeEntry(longText), fakeConfiguration(), 'sk_live_ok', 'bandit');
      expect(posted).toHaveLength(0); // silent skip on word-cap overrun
      expect(vi.mocked(voiceProviders.synthesizeSpeech)).not.toHaveBeenCalled();
    }
  });

  it('handleSpeak short-circuits with an audioError when bandit TTS is configured but no key is stored', async () => {
    const { ctx, posted } = makeCtx({ storedApiKey: undefined });
    const svc = new VoiceService(ctx);
    configMap.set('voice.tts.provider', 'bandit');

    await svc.handleSpeak('msg-1', 'hello world');

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'audioError', entryId: 'msg-1' });
    expect((posted[0] as { message: string }).message).toContain('Bandit API key');
    expect(vi.mocked(voiceProviders.synthesizeSpeech)).not.toHaveBeenCalled();
  });

  it('handleTranscribe posts the parsed transcription as voiceTranscription on success', async () => {
    const { ctx, posted } = makeCtx({ storedApiKey: 'sk_live_ok' });
    const svc = new VoiceService(ctx);
    configMap.set('voice.stt.provider', 'bandit');
    vi.mocked(voiceProviders.transcribeAudio).mockResolvedValueOnce({ text: '  hello there  ' });

    await svc.handleTranscribe(Buffer.from('audio bytes').toString('base64'), 'audio/wav');

    expect(vi.mocked(voiceProviders.transcribeAudio)).toHaveBeenCalledOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'voiceTranscription', text: 'hello there' });
  });
});
