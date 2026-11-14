/**
 * Artifacts → Bandit Stash rename in the CLI: `/stash` is the command, `/artifact`
 * still dispatches to it but is hidden, the help text says "Bandit Stash (cloud)"
 * up front (it sits next to git commands), and there are no git verbs.
 */
import { describe, it, expect } from 'vitest';
import { slashCommands, findSlashCommand } from '../src/slashCommands';

describe('/stash slash command', () => {
  it('is registered as stash, with artifact as a hidden alias', () => {
    const found = findSlashCommand('/stash report.html');
    expect(found?.cmd.name).toBe('stash');
    expect(found?.args).toBe('report.html');
    const legacy = findSlashCommand('/artifact ls');
    expect(legacy?.cmd.name).toBe('stash');
    expect(legacy?.args).toBe('ls');
    expect(slashCommands.some((c) => c.name === 'artifact')).toBe(false);
  });

  it('describes itself as the Bandit Stash (cloud), not git stash', () => {
    const cmd = slashCommands.find((c) => c.name === 'stash')!;
    expect(cmd.description).toMatch(/^Bandit Stash \(cloud\): /);
    expect(cmd.description).toMatch(/Not git stash/);
  });

  it('hands the args to the REPL stash handler', async () => {
    const seen: string[] = [];
    const cmd = slashCommands.find((c) => c.name === 'stash')!;
    const out = await cmd.run('  ls ', { stash: async (a: string) => { seen.push(a); return 'ok'; } } as never);
    expect(out).toBe('ok');
    expect(seen).toEqual(['ls']);
  });

  it('/help all lists /stash and never the hidden /artifact alias', async () => {
    const help = slashCommands.find((c) => c.name === 'help')!;
    const out = String(await help.run('all', {} as never));
    expect(out).toContain('/stash');
    expect(out).not.toMatch(/\/artifact\b/);
  });
});
