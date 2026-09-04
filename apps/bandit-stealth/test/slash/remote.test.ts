import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';

vi.mock('vscode', () => ({
  workspace: { get workspaceFolders() { return [{ uri: { fsPath: process.cwd() } }]; } },
  ConfigurationTarget: { Global: 1 }
}));

import { handleSlashCommand } from '../../src/slash';

function configuration(values: Record<string, unknown> = {}) {
  return {
    get<T>(key: string, fallback?: T): T {
      return (key in values ? values[key] : fallback) as T;
    },
    update: vi.fn()
  };
}

function context(conversation: ConversationEntry[], remote?: (sub: string) => Promise<string>) {
  return {
    conversation,
    updateConversation: async (entries: ConversationEntry[]) => {
      const next = [...entries]; // copy first — entries may be the same array ref
      conversation.length = 0;
      conversation.push(...next);
    },
    syncState: async () => undefined,
    clearCurrentConversation: async () => undefined,
    getProviderKind: () => 'bandit' as const,
    resolveOllamaBaseModel: () => 'gemma4:26b',
    hasBanditApiKey: async () => true,
    remote
  };
}

describe('IDE /remote slash command', () => {
  it('routes /remote on to ctx.remote and renders its status', async () => {
    const calls: string[] = [];
    const conversation: ConversationEntry[] = [];
    const handled = await handleSlashCommand(
      '/remote on',
      configuration() as never,
      context(conversation, async (sub) => { calls.push(sub); return 'Remote control is active.'; })
    );
    expect(handled).toBe(true);
    expect(calls).toEqual(['on']);
    expect(conversation.at(-1)?.content).toContain('Remote control is active.');
  });

  it('passes the empty sub for a bare /remote (status)', async () => {
    const calls: string[] = [];
    await handleSlashCommand(
      '/remote',
      configuration() as never,
      context([], async (sub) => { calls.push(sub); return 'status'; })
    );
    expect(calls).toEqual(['']);
  });

  it('degrades gracefully when the host provides no remote handler', async () => {
    const conversation: ConversationEntry[] = [];
    const handled = await handleSlashCommand('/remote on', configuration() as never, context(conversation, undefined));
    expect(handled).toBe(true); // still consumed — never leaks to the model
    expect(conversation.at(-1)?.content).toMatch(/unavailable/i);
  });

  it('lists /remote in /help', async () => {
    const conversation: ConversationEntry[] = [];
    await handleSlashCommand('/help', configuration() as never, context(conversation));
    expect(conversation.at(-1)?.content).toMatch(/\/remote on/);
  });
});
