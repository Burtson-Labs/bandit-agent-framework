import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  formatTurnTraceMarkdown,
  listTurnTraces,
  parseTurnLog,
  readTurnTraceById,
  summarizeTurnTrace
} from '../src';

async function withWorkspace<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'bandit-trace-'));
  try {
    mkdirSync(path.join(root, '.bandit', 'turns'), { recursive: true });
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('turn trace reader', () => {
  it('parses JSONL traces and ignores corrupt lines', () => {
    const events = parseTurnLog([
      '{"t":"2026-05-24T17:00:00.000Z","type":"user-prompt","prompt":"fix it"}',
      'not json',
      '{"t":"2026-05-24T17:00:01.000Z","type":"tool-execute","name":"read_file","iteration":0}'
    ].join('\n'));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('user-prompt');
    expect(events[1].type).toBe('tool-execute');
  });

  it('summarizes retries, native fallback, permissions, tools, and final status', () => {
    const events = parseTurnLog([
      '{"t":"2026-05-24T17:00:00.000Z","type":"user-prompt","prompt":"refactor auth"}',
      '{"t":"2026-05-24T17:00:01.000Z","type":"llm-retry","iteration":0,"attempt":2}',
      '{"t":"2026-05-24T17:00:02.000Z","type":"native-tool-fallback","iteration":0}',
      '{"t":"2026-05-24T17:00:03.000Z","type":"permission-request","name":"apply_edit","primary":"src/auth.ts","risk":"Modifies files.","iteration":0}',
      '{"t":"2026-05-24T17:00:04.000Z","type":"permission-decision","name":"apply_edit","primary":"src/auth.ts","choice":"session","iteration":0}',
      '{"t":"2026-05-24T17:00:05.000Z","type":"tool-execute","name":"apply_edit","iteration":0}',
      '{"t":"2026-05-24T17:00:06.000Z","type":"tool-result","name":"apply_edit","isError":false}',
      '{"t":"2026-05-24T17:00:07.000Z","type":"final-response","iterations":1,"hitLimit":false,"finalPreview":"done"}'
    ].join('\n'));

    const summary = summarizeTurnTrace('turn-test', '/tmp/turn-test.jsonl', events);

    expect(summary.prompt).toBe('refactor auth');
    expect(summary.status).toBe('completed');
    expect(summary.toolCalls).toBe(1);
    expect(summary.tools).toEqual(['apply_edit']);
    expect(summary.retries).toBe(1);
    expect(summary.nativeFallbacks).toBe(1);
    expect(summary.permissionRequests).toBe(1);
    expect(summary.permissionDecisions).toBe(1);
    expect(summary.permissionDenials).toBe(0);
  });

  it('lists latest trace files and renders a markdown timeline', async () => {
    await withWorkspace(async (root) => {
      const tracePath = path.join(root, '.bandit', 'turns', 'turn-2026-05-24T17-00-00-000Z-abcd.jsonl');
      writeFileSync(tracePath, [
        '{"t":"2026-05-24T17:00:00.000Z","type":"user-prompt","prompt":"inspect repo"}',
        '{"t":"2026-05-24T17:00:01.000Z","type":"tool-execute","name":"list_files","iteration":0}',
        '{"t":"2026-05-24T17:00:02.000Z","type":"final-response","iterations":1,"finalPreview":"I inspected it."}'
      ].join('\n'));

      const traces = await listTurnTraces(root);
      expect(traces).toHaveLength(1);
      expect(traces[0].id).toBe('turn-2026-05-24T17-00-00-000Z-abcd');

      const byId = await readTurnTraceById(root, traces[0].id);
      expect(byId?.summary.tools).toEqual(['list_files']);

      const rendered = formatTurnTraceMarkdown(traces[0]);
      expect(rendered).toContain('## Trace turn-2026-05-24T17-00-00-000Z-abcd');
      expect(rendered).toContain('`tool-execute`');
    });
  });

  it('can include global turn traces and read them by id', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'bandit-trace-home-'));
    const root = mkdtempSync(path.join(tmpdir(), 'bandit-trace-root-'));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const globalTurns = path.join(home, '.bandit', 'turns');
      mkdirSync(globalTurns, { recursive: true });
      const tracePath = path.join(globalTurns, 'turn-2026-05-25T20-58-33-159Z-glob.jsonl');
      writeFileSync(tracePath, [
        '{"t":"2026-05-25T20:58:33.159Z","type":"user-prompt","prompt":"clean Gmail with MCP"}',
        '{"t":"2026-05-25T20:58:34.000Z","type":"tool-execute","name":"burtson-labs.modifyMessageLabels","params":{"messageId":"1"}}',
        '{"t":"2026-05-25T20:58:35.000Z","type":"final-response","iterations":1,"finalPreview":"Done."}'
      ].join('\n'));

      expect(await listTurnTraces(root)).toHaveLength(0);
      const traces = await listTurnTraces(root, { includeGlobal: true, limit: 5 });
      expect(traces).toHaveLength(1);
      expect(traces[0].summary.scope).toBe('global');

      const byId = await readTurnTraceById(root, traces[0].id, { includeGlobal: true });
      expect(byId?.summary.prompt).toBe('clean Gmail with MCP');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('renders permission denials in the timeline', () => {
    const events = parseTurnLog([
      '{"t":"2026-05-24T17:00:00.000Z","type":"permission-request","name":"run_command","displayPrimary":"git push","risk":"Changes Git state."}',
      '{"t":"2026-05-24T17:00:01.000Z","type":"permission-denied","name":"run_command","primary":"git","source":"user","reason":"User denied `run_command git`."}'
    ].join('\n'));

    const summary = summarizeTurnTrace('turn-denied', '/tmp/turn-denied.jsonl', events);
    const rendered = formatTurnTraceMarkdown({
      id: 'turn-denied',
      filePath: '/tmp/turn-denied.jsonl',
      events,
      summary
    });

    expect(summary.permissionRequests).toBe(1);
    expect(summary.permissionDenials).toBe(1);
    expect(summary.status).toBe('blocked');
    expect(rendered).toContain('Permissions: 1 prompts · 0 decisions · 1 denials');
    expect(rendered).toContain('`permission-denied` — source:user · run_command');
  });
});
