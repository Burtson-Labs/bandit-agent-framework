/**
 * The chat view's title-bar actions (new conversation, history, settings,
 * trace logs) are VS Code menu contributions. Pin the contract between
 * package.json and the command registrations so a renamed command can't
 * leave a dead button in the title bar.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
  };
};
const registerSource = readFileSync(path.join(root, 'src/commands/registerCommands.ts'), 'utf8');

const viewTitle = pkg.contributes.menus['view/title'] ?? [];
const commandById = new Map(pkg.contributes.commands.map((c) => [c.command, c]));

describe('chat view title-bar actions', () => {
  it('puts new conversation, history and settings inline, in that order', () => {
    const inline = viewTitle
      .filter((m) => m.group?.startsWith('navigation'))
      .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''))
      .map((m) => m.command);
    expect(inline).toEqual([
      'banditStealth.view.newConversation',
      'banditStealth.view.toggleHistory',
      'banditStealth.view.toggleSettings'
    ]);
  });

  it('keeps trace logs in the overflow menu', () => {
    const trace = viewTitle.find((m) => m.command === 'banditStealth.view.openTraceLogs');
    expect(trace?.group?.startsWith('navigation')).toBe(false);
  });

  it('scopes every entry to the Bandit chat view', () => {
    for (const item of viewTitle) {
      expect(item.when).toBe('view == banditStealth.chat');
    }
  });

  it('declares each command with a codicon and a title', () => {
    for (const item of viewTitle) {
      const cmd = commandById.get(item.command);
      expect(cmd, item.command).toBeTruthy();
      expect(cmd?.title).toBeTruthy();
      expect(cmd?.icon).toMatch(/^\$\([a-z-]+\)$/);
    }
  });

  it('registers a handler for each view action command', () => {
    for (const item of viewTitle) {
      expect(registerSource).toContain(`'${item.command}'`);
    }
  });
});
