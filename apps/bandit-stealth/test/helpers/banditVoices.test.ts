import { describe, it, expect, vi } from 'vitest';
import {
  BANDIT_VOICES,
  DEFAULT_BANDIT_VOICE,
  looksLikeBanditVoiceId,
  migrateBanditVoiceId,
  migrateBanditVoiceSetting
} from '../../src/helpers/banditVoices';

const HEART = 'kokoro-af_heart';
const MICHAEL = 'kokoro-am_michael';
const EMMA = 'kokoro-bf_emma';
const GEORGE = 'kokoro-bm_george';

describe('migrateBanditVoiceId', () => {
  it('keeps the four voices and defaults to Heart', () => {
    expect(BANDIT_VOICES.map((v) => v.id)).toEqual([HEART, MICHAEL, EMMA, GEORGE]);
    expect(DEFAULT_BANDIT_VOICE).toBe(HEART);
    for (const v of BANDIT_VOICES) {expect(migrateBanditVoiceId(v.id)).toBe(v.id);}
    expect(migrateBanditVoiceId('')).toBe(HEART);
    expect(migrateBanditVoiceId(undefined)).toBe(HEART);
  });

  it.each([
    ['en_US-jessica-premium', HEART],
    ['en_US-matilda-premium', HEART],
    ['en_US-brian-premium', MICHAEL],
    ['en_US-liam-premium', MICHAEL],
    ['en_US-mark-premium', MICHAEL],
    ['en_US-ryan-medium', MICHAEL],
    ['en_US-someone-ivc', MICHAEL],
    ['en_US-someone-r', MICHAEL],
    ['kokoro-af_sarah', HEART],
    ['kokoro-am_puck', MICHAEL],
    ['kokoro-bf_lily', EMMA],
    ['kokoro-bm_lewis', GEORGE],
    ['en_US-bella-standard', HEART],
    ['en_US-fenrir-standard', MICHAEL],
    ['en_GB-alice-standard', EMMA],
    ['en_GB-daniel-standard', GEORGE],
    ['en_US-heart-local', HEART],
    ['en_US-bella-local', HEART],
    ['en_US-michael-local', MICHAEL],
    ['en_US-studio-local', MICHAEL],
    ['en_GB-emma-local', EMMA],
    ['en_US-turbo-local', HEART],
    ['something-else', HEART],
    ['alloy', HEART]
  ])('%s -> %s', (from, to) => {
    expect(migrateBanditVoiceId(from)).toBe(to);
  });
});

describe('looksLikeBanditVoiceId', () => {
  it('recognises Bandit ids but not OpenAI or ElevenLabs voices', () => {
    expect(looksLikeBanditVoiceId('en_US-brian-premium')).toBe(true);
    expect(looksLikeBanditVoiceId('kokoro-af_heart')).toBe(true);
    expect(looksLikeBanditVoiceId('alloy')).toBe(false);
    expect(looksLikeBanditVoiceId('21m00Tcm4TlvDq8ikWAM')).toBe(false);
  });
});

describe('migrateBanditVoiceSetting', () => {
  const targets = { global: 1, workspace: 2, folder: 3 } as const;

  function config(values: { global?: string; workspace?: string; folder?: string }, provider = 'auto') {
    const update = vi.fn(async () => undefined);
    const configuration = {
      get: (key: string, fallback: unknown) => (key === 'voice.tts.provider' ? provider : fallback),
      inspect: () => ({
        globalValue: values.global,
        workspaceValue: values.workspace,
        workspaceFolderValue: values.folder
      }),
      update
    } as unknown as import('vscode').WorkspaceConfiguration;
    return { configuration, update };
  }

  it('rewrites an old id at the scope it was saved in', async () => {
    const { configuration, update } = config({ global: 'en_US-brian-premium', workspace: 'en_US-jessica-premium' });
    const rewritten = await migrateBanditVoiceSetting(configuration, targets as never);
    expect(update).toHaveBeenCalledWith('voice.voiceId', MICHAEL, 1);
    expect(update).toHaveBeenCalledWith('voice.voiceId', HEART, 2);
    expect(rewritten).toEqual([1, 2]);
  });

  it('writes nothing when no value was saved or it is already one of the four', async () => {
    const { configuration, update } = config({ global: GEORGE });
    expect(await migrateBanditVoiceSetting(configuration, targets as never)).toEqual([]);
    const empty = config({});
    await migrateBanditVoiceSetting(empty.configuration, targets as never);
    expect(update).not.toHaveBeenCalled();
    expect(empty.update).not.toHaveBeenCalled();
  });

  it('leaves bring-your-own voices alone unless the provider is bandit', async () => {
    const byo = config({ global: '21m00Tcm4TlvDq8ikWAM' }, 'elevenlabs');
    await migrateBanditVoiceSetting(byo.configuration, targets as never);
    expect(byo.update).not.toHaveBeenCalled();
    const bandit = config({ global: 'alloy' }, 'bandit');
    await migrateBanditVoiceSetting(bandit.configuration, targets as never);
    expect(bandit.update).toHaveBeenCalledWith('voice.voiceId', HEART, 1);
  });
});
