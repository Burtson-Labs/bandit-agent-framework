/**
 * The read-before-edit guard across turns.
 *
 * A tool context lives for one turn. Its read-tracking did too, so "change the title" on
 * a file the agent wrote in the previous turn was always rejected once with "you have not
 * read this file in this conversation" (BanditBench context_reuse.artifact_revision could
 * not pass with apply_edit, replace_range or write_file until the fixture allowed the
 * forced read). The session ledger carries what the agent has seen from turn to turn, for
 * as long as the file on disk is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyEditTool, readFileTool, replaceRangeTool, writeFileTool } from '@burtson-labs/agent-core';
import { CliToolExecutionContext, SessionFileLedger } from '../src/cliToolContext';

const HTML = '<!doctype html>\n<title>Fleet Status</title>\n<h1>Fleet Status</h1>\n';

let root: string;
const file = (): string => path.join(root, 'status.html');
/** One turn = one tool context, as in runPrompt. */
const turn = (ledger?: SessionFileLedger): CliToolExecutionContext =>
  new CliToolExecutionContext(root, undefined, { sessionFiles: ledger });
/** Something other than the agent changes the file. */
const touchExternally = (content: string): void => {
  fs.writeFileSync(file(), content);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file(), later, later);
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-ledger-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('read-before-edit guard across turns', () => {
  it('a file the agent wrote last turn can be edited without re-reading it', async () => {
    const ledger = new SessionFileLedger();
    const wrote = await writeFileTool.execute({ path: 'status.html', content: HTML }, turn(ledger));
    expect(wrote.isError).toBeFalsy();

    const edited = await applyEditTool.execute({ path: 'status.html', find: '<title>Fleet Status</title>', replace: '<title>Fleet Health</title>' }, turn(ledger));
    expect(edited.isError, edited.output).toBeFalsy();
    expect(fs.readFileSync(file(), 'utf8')).toContain('<title>Fleet Health</title>');
  });

  it('a file read last turn can be edited by line number, and edited again in the same turn', async () => {
    fs.writeFileSync(file(), HTML);
    const ledger = new SessionFileLedger();
    await readFileTool.execute({ path: 'status.html' }, turn(ledger));

    const next = turn(ledger);
    const first = await replaceRangeTool.execute({ path: 'status.html', start_line: '2', end_line: '2', content: '<title>Fleet Health</title>' }, next);
    expect(first.isError, first.output).toBeFalsy();
    const second = await applyEditTool.execute({ path: 'status.html', find: '<h1>Fleet Status</h1>', replace: '<h1>Fleet Health</h1>' }, next);
    expect(second.isError, second.output).toBeFalsy();
    // …and the turn after that still knows the file, because the agent made those edits.
    const third = await applyEditTool.execute({ path: 'status.html', find: 'Fleet Health</h1>', replace: 'Fleet Health!</h1>' }, turn(ledger));
    expect(third.isError, third.output).toBeFalsy();
    expect(fs.readFileSync(file(), 'utf8')).toBe('<!doctype html>\n<title>Fleet Health</title>\n<h1>Fleet Health!</h1>\n');
  });

  it('a file changed by anything else since then must be read again', async () => {
    const ledger = new SessionFileLedger();
    await writeFileTool.execute({ path: 'status.html', content: HTML }, turn(ledger));
    touchExternally(HTML.replace('Fleet Status</h1>', 'Fleet Status (edited by hand)</h1>'));

    const blind = await applyEditTool.execute({ path: 'status.html', find: '<title>Fleet Status</title>', replace: '<title>Fleet Health</title>' }, turn(ledger));
    expect(blind.isError).toBe(true);
    expect(blind.output).toContain('you have not read this file');
    expect(fs.readFileSync(file(), 'utf8')).toContain('edited by hand');

    // Reading it again is enough.
    const next = turn(ledger);
    await readFileTool.execute({ path: 'status.html' }, next);
    const edited = await applyEditTool.execute({ path: 'status.html', find: '<title>Fleet Status</title>', replace: '<title>Fleet Health</title>' }, next);
    expect(edited.isError, edited.output).toBeFalsy();
  });

  it('a file the agent never saw is still refused, with or without a ledger', async () => {
    fs.writeFileSync(file(), HTML);
    for (const ledger of [new SessionFileLedger(), undefined]) {
      const blind = await applyEditTool.execute({ path: 'status.html', find: 'Fleet Status', replace: 'Fleet Health' }, turn(ledger));
      expect(blind.isError).toBe(true);
      expect(blind.output).toContain('you have not read this file');
    }
  });

  it('without a ledger (one-shot mode) each context starts from nothing, as before', async () => {
    await writeFileTool.execute({ path: 'status.html', content: HTML }, turn());
    const blind = await applyEditTool.execute({ path: 'status.html', find: 'Fleet Status', replace: 'Fleet Health' }, turn());
    expect(blind.isError).toBe(true);
  });

  it('a deleted file is forgotten', async () => {
    const ledger = new SessionFileLedger();
    await writeFileTool.execute({ path: 'status.html', content: HTML }, turn(ledger));
    fs.unlinkSync(file());
    expect(ledger.isCurrent(file())).toBe(false);
    fs.writeFileSync(file(), HTML);
    expect(turn(ledger).hasFileBeenRead(file())).toBe(false);
  });
});
