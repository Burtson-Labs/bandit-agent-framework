import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';

const vscodeMock = vi.hoisted(() => ({ root: process.cwd() }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: vscodeMock.root } }];
    }
  },
  ConfigurationTarget: {
    Global: 1
  }
}));

import { handleSlashCommand } from '../../src/slash';

function configuration(values: Record<string, unknown>) {
  return {
    get<T>(key: string, fallback?: T): T {
      return (key in values ? values[key] : fallback) as T;
    },
    update: vi.fn()
  };
}

function context(conversation: ConversationEntry[]) {
  return {
    conversation,
    updateConversation: async (entries: ConversationEntry[]) => {
      const next = [...entries];
      conversation.length = 0;
      conversation.push(...next);
    },
    syncState: async () => undefined,
    clearCurrentConversation: async () => undefined,
    getProviderKind: () => 'bandit' as const,
    resolveOllamaBaseModel: () => 'gemma4:26b',
    hasBanditApiKey: async () => true
  };
}

describe('IDE /doctor slash command', () => {
  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'bandit-doctor-'));
    mkdirSync(path.join(root, '.bandit', 'skills'), { recursive: true });
    writeFileSync(path.join(root, 'BANDIT.md'), '- Prefer pnpm\n');
    writeFileSync(path.join(root, '.bandit', 'settings.json'), '{}\n');
    writeFileSync(path.join(root, '.bandit', 'skills', 'release.md'), '# Release\n');
    vscodeMock.root = root;
  });

  it('renders setup, provider, profile, watchdog, and next actions without calling the model', async () => {
    const conversation: ConversationEntry[] = [];
    const handled = await handleSlashCommand('/doctor', configuration({
      provider: 'bandit',
      model: 'bandit-logic',
      watchdogMs: -1,
      'notifications.enabled': true
    }) as never, context(conversation));

    expect(handled).toBe(true);
    expect(conversation.length).toBe(1);
    const content = conversation[0].content;
    expect(content).toContain('Bandit doctor');
    expect(content).toContain('Provider');
    expect(content).toContain('Bandit Cloud');
    expect(content).toContain('Model profile');
    expect(content).toContain('Watchdog');
    expect(content).toContain('Next best actions');
  });
});
