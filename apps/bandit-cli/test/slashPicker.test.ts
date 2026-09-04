/**
 * matchSlashCommands ranks the slash-command list for the picker: substring
 * match, prefix hits first, then shorter names, then alphabetical. The
 * interactive picker (raw stdin) isn't unit-tested here — this locks the
 * ranking, which is the part that decides what the user sees after `/`.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { matchSlashCommands, openSlashPicker, type SlashPickerCommand } from '../src/slashPicker';

const cmds: SlashPickerCommand[] = [
  { name: 'insights', description: 'usage report' },
  { name: 'init', description: 'scaffold' },
  { name: 'commit', description: 'git commit' },
  { name: 'inspect', description: 'inspect state' },
  { name: 'review', description: 'review changes' }
];

describe('matchSlashCommands', () => {
  it('returns everything (capped) for an empty query', () => {
    expect(matchSlashCommands(cmds, '')).toHaveLength(cmds.length);
  });

  it('filters by case-insensitive substring', () => {
    const names = matchSlashCommands(cmds, 'IN').map((c) => c.name);
    // all names containing "in": insights, init, inspect (NOT commit/review)
    expect(names).toContain('init');
    expect(names).toContain('insights');
    expect(names).toContain('inspect');
    expect(names).not.toContain('commit');
    expect(names).not.toContain('review');
  });

  it('ranks by shorter name when neither is a prefix hit', () => {
    // "it" is mid-string in both init (in-IT) and commit (comm-IT); neither
    // starts with "it", so the shorter name (init) ranks first.
    const names = matchSlashCommands(cmds, 'it').map((c) => c.name);
    expect(names).toEqual(['init', 'commit']);
  });

  it('prefers the shorter name when both are prefix matches', () => {
    // query "in" prefixes init(4), inspect(7), insights(8) -> shortest first.
    const names = matchSlashCommands(cmds, 'in').map((c) => c.name);
    expect(names[0]).toBe('init');
    expect(names.slice(0, 3)).toEqual(['init', 'inspect', 'insights']);
  });

  it('returns empty for a query nothing matches', () => {
    expect(matchSlashCommands(cmds, 'zzz')).toEqual([]);
  });
});

/**
 * Drive the interactive picker through a mocked TTY: replace process.stdin
 * (keypress source) + process.stdout (needs isTTY/columns) for the duration of
 * one call, emit keypresses, and assert the resolved insertion. This exercises
 * the actual key handling + readline-insertion contract — the new, risky part.
 */
function mockStdio() {
  const origIn = process.stdin;
  const origOut = process.stdout;
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.setRawMode = () => stdin;
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.isRaw = false;
  const stdout = { isTTY: true, columns: 80, write: () => true } as unknown as NodeJS.WriteStream;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  const restore = () => {
    Object.defineProperty(process, 'stdin', { value: origIn, configurable: true });
    Object.defineProperty(process, 'stdout', { value: origOut, configurable: true });
  };
  const type = (s: string) => stdin.emit('keypress', s, { name: s });
  const press = (name: string) => stdin.emit('keypress', undefined, { name });
  return { stdin, restore, type, press };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('openSlashPicker (interactive)', () => {
  const menu: SlashPickerCommand[] = [
    { name: 'insights', description: 'usage report' },
    { name: 'init', description: 'scaffold' },
    { name: 'commit', description: 'git commit' }
  ];

  it('fills `/name ` on Enter after filtering', async () => {
    const io = mockStdio();
    try {
      const p = openSlashPicker(menu, '');
      await tick();
      io.type('i'); io.type('n'); io.type('s'); // query "ins" -> only insights
      io.press('return');
      const result = await p;
      expect(result).toEqual({ insertion: '/insights ', trailingChar: '', dismissed: false });
    } finally {
      io.restore();
    }
  });

  it('down-arrow moves selection before committing', async () => {
    const io = mockStdio();
    try {
      const p = openSlashPicker(menu, '');
      await tick();
      io.type('i'); // matches: init(4), insights(8) — init first
      io.press('down'); // -> insights
      io.press('tab');
      const result = await p;
      expect(result.insertion).toBe('/insights ');
    } finally {
      io.restore();
    }
  });

  it('Esc keeps whatever was typed (nothing lost)', async () => {
    const io = mockStdio();
    try {
      const p = openSlashPicker(menu, '');
      await tick();
      io.type('c'); io.type('o');
      io.press('escape');
      const result = await p;
      expect(result).toEqual({ insertion: '/co', trailingChar: '', dismissed: true });
    } finally {
      io.restore();
    }
  });

  it('backspace past empty pops the `/` (empty insertion)', async () => {
    const io = mockStdio();
    try {
      const p = openSlashPicker(menu, '');
      await tick();
      io.press('backspace'); // query already empty -> remove the slash
      const result = await p;
      expect(result).toEqual({ insertion: '', trailingChar: '', dismissed: true });
    } finally {
      io.restore();
    }
  });

  it('non-TTY resolves immediately as dismissed (keeps typed text)', async () => {
    // No stdio mock — vitest runs piped, so isTTY is false.
    const result = await openSlashPicker(menu, 'help');
    expect(result).toEqual({ insertion: '/help', trailingChar: '', dismissed: true });
  });
});
