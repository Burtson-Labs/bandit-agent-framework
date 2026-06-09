/**
 * Contract tests for `turnFinalize` — the success / error / always
 * paths that wrap `performToolUseCompletion`.
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `finalizeTurnSuccess` posts the completion notification, kicks
 *     off auto-speak fire-and-forget when the assistant entry has
 *     content, and never throws on empty entries,
 * (2) `finalizeTurnError` routes a rate-limit Error to the
 *     `rateLimited` webview event (not the generic `error` path),
 *     so the UI can deep-link to Account & Usage instead of showing
 *     a raw stack trace,
 * (3) `finalizeTurnError` rewrites an "Ollama request failed: 404"
 *     into the actionable "ollama pull <model>" message — losing
 *     this is a silent UX regression that doesn't break tests
 *     elsewhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';
import type { ProviderContext } from '../../src/provider/context';
import type { VoiceService } from '../../src/provider/services/voiceService';

vi.mock('vscode', () => ({}));

import { finalizeTurnError, finalizeTurnSuccess } from '../../src/agent/turnFinalize';

function makeEntry(content = ''): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0 };
}

function makeCtx(): {
  ctx: ProviderContext;
  posted: Array<Record<string, unknown>>;
  notifs: Array<{ kind: string; title: string; message: string }>;
  statusMessages: string[];
} {
  const posted: Array<Record<string, unknown>> = [];
  const notifs: Array<{ kind: string; title: string; message: string }> = [];
  const statusMessages: string[] = [];
  const messages: ConversationEntry[] = [];
  const ctx = {
    conversations: {
      messages,
      currentId: 'c-1',
      updateMessages: vi.fn(async () => undefined)
    },
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); },
    syncState: async () => undefined,
    setStatusMessage: async (text: string) => { statusMessages.push(text); },
    notifyUser: (kind: string, title: string, message: string) => { notifs.push({ kind, title, message }); },
    describeProvider: (k: string) => k === 'ollama' ? 'Ollama' : 'Bandit Cloud',
    getProviderKind: () => 'ollama' as const
  } as unknown as ProviderContext;
  return { ctx, posted, notifs, statusMessages };
}

function makeVoice(): { voice: VoiceService; speakCalls: number } {
  let speakCalls = 0;
  const voice = { maybeAutoSpeak: vi.fn(async () => { speakCalls += 1; }) } as unknown as VoiceService;
  return {
    voice,
    get speakCalls() { return speakCalls; }
  } as never;
}

const baseOpts = (override: Partial<Parameters<typeof finalizeTurnSuccess>[0]> = {}) => ({
  configuration: { get: <T,>(_: string, f?: T) => f as T } as unknown as import('vscode').WorkspaceConfiguration,
  userGoal: 'do the thing\n  with whitespace',
  apiKey: 'sk_live',
  providerKind: 'bandit' as const,
  activeTurnStartedAt: Date.now() - 1500,
  disposeIndicators: vi.fn(),
  ...override
});

beforeEach(() => {
  // each test owns its own ctx; nothing global to reset.
});

describe('finalizeTurnSuccess', () => {
  it('posts the completion notification and fires auto-speak when the assistant entry has content', async () => {
    const { ctx, notifs, statusMessages } = makeCtx();
    const voiceWrap = makeVoice();
    const entry = makeEntry('a real assistant response');

    await finalizeTurnSuccess({
      ...baseOpts({ assistantEntry: entry, ctx }),
      ctx,
      assistantEntry: entry,
      iterations: 3,
      voice: voiceWrap.voice
    });

    expect(statusMessages).toEqual(['Completed with 3 tool calls.']);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({ kind: 'complete', title: 'Bandit turn complete' });
    // Goal is whitespace-collapsed in the toast body.
    expect(notifs[0].message).toBe('do the thing with whitespace');
    expect(voiceWrap.speakCalls).toBe(1);
  });

  it('does not fire auto-speak when the assistant entry is empty', async () => {
    const { ctx } = makeCtx();
    const voiceWrap = makeVoice();
    const entry = makeEntry('');

    await finalizeTurnSuccess({
      ...baseOpts({ assistantEntry: entry }),
      ctx,
      assistantEntry: entry,
      iterations: 0,
      voice: voiceWrap.voice
    });

    expect(voiceWrap.speakCalls).toBe(0);
  });
});

describe('finalizeTurnError', () => {
  it('routes a rate-limit Error to the rateLimited webview event (not the generic error path)', async () => {
    const { ctx, posted, notifs } = makeCtx();
    const entry = makeEntry('partial output');
    const error = Object.assign(new Error('Rate limit exceeded'), {
      isRateLimit: true,
      window: 'hour',
      resetsAtUnix: 1_700_000_000
    });

    await finalizeTurnError({
      ...baseOpts({ assistantEntry: entry }),
      ctx,
      assistantEntry: entry,
      assistantAdded: true,
      error
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'rateLimited',
      window: 'hour',
      resetsAtUnix: 1_700_000_000,
      message: 'Rate limit exceeded'
    });
    // Generic `error` event must NOT fire on the rate-limit path.
    const generic = posted.find((p) => p.type === 'error');
    expect(generic).toBeUndefined();
    // Toast surfaces the rate-limit title.
    expect(notifs[0]).toMatchObject({ kind: 'error', title: 'Bandit cloud rate limit' });
  });

  it("rewrites 'Ollama request failed: 404' errors into the actionable 'ollama pull <model>' message", async () => {
    const { ctx, posted } = makeCtx();
    const entry = makeEntry('partial');
    const error = new Error('Ollama request failed: 404 — model "gemma3:27b" not found');

    await finalizeTurnError({
      ...baseOpts({ assistantEntry: entry, providerKind: 'ollama' }),
      ctx,
      assistantEntry: entry,
      assistantAdded: true,
      error
    });

    const errorEvt = posted.find((p) => p.type === 'error');
    expect(errorEvt).toBeDefined();
    expect((errorEvt as { message: string }).message).toContain('ollama pull gemma3:27b');
    expect((errorEvt as { message: string }).message).not.toMatch(/^Ollama tool agent error: Ollama request failed/);
  });
});
