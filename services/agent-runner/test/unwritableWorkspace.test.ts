/**
 * A workspace the runner's user cannot write (16 Nov 2026: the gateway cloned
 * as root, the runner runs as uid 1000). Every apply_edit failed with a raw
 * EACCES and the turn burned its give-up nudges before ending
 * NO_CHANGES_FOR_MUTATION. Pinned here: a change request fails up front with
 * WORKSPACE_NOT_WRITABLE, a question still runs, and a write refused mid-turn
 * reads as a platform fault rather than a puzzle.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeWriteFailure, runTurn } from '../src/turn';
import type { RunnerEvent, TurnRequest } from '../src/contract';

// Root ignores permission bits, so none of this is observable as uid 0.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let graphFlag: string | undefined;
const dirs: string[] = [];

beforeAll(() => {
  graphFlag = process.env.RUNNER_GRAPH;
  process.env.RUNNER_GRAPH = '0';
});

afterAll(() => {
  if (graphFlag === undefined) delete process.env.RUNNER_GRAPH;
  else process.env.RUNNER_GRAPH = graphFlag;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o755);
    for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-ro-')));
  dirs.push(ws);
  fs.writeFileSync(path.join(ws, 'README.md'), '# Site\n');
  return ws;
}

function request(ws: string, script: string[], prompt: string): TurnRequest {
  return {
    protocol: 1,
    taskId: 'task-ro',
    workspacePath: ws,
    prompt,
    provider: { kind: 'deterministic', script },
    maxIterations: 4,
  };
}

async function collect(req: TurnRequest): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  await runTurn(req, (e) => events.push(e), { permissionMode: 'standard', maxNudges: 0 });
  return events;
}

describe.skipIf(asRoot)('unwritable workspace', () => {
  it('fails a change request up front with WORKSPACE_NOT_WRITABLE', async () => {
    const ws = workspace();
    fs.chmodSync(ws, 0o555);

    const events = await collect(
      request(ws, ['should never be asked'], 'Add a comment to the top of the README please.'),
    );

    expect(events.map((e) => e.type)).toEqual(['turn.started', 'turn.error']);
    expect(events[1]).toMatchObject({ type: 'turn.error', code: 'WORKSPACE_NOT_WRITABLE' });
  });

  it('still answers a read-only question', async () => {
    const ws = workspace();
    fs.chmodSync(ws, 0o555);

    const events = await collect(request(ws, ['It is a website.'], 'What is this repo?'));

    expect(events[events.length - 1].type).toBe('turn.completed');
  });

  it('reports a refused write as a platform fault, without the mount path', async () => {
    const ws = workspace();
    fs.chmodSync(path.join(ws, 'README.md'), 0o444);
    const edit =
      '<tool_call>{"name": "apply_edit", "params": {"path": "README.md", "find": "# Site", "replace": "<!-- hi -->\\n# Site"}}</tool_call>';

    const events = await collect(request(ws, [edit, 'Done.'], 'Add a comment to the top of the README please.'));
    const result = events.find((e) => e.type === 'tool.result') as { ok: boolean; summary: string };

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not writable by the agent runner');
    expect(result.summary).not.toContain(ws);
  });
});

describe('describeWriteFailure', () => {
  it('maps permission errors and passes others through', () => {
    const eacces = Object.assign(new Error('EACCES: permission denied, open /app/app_data/x'), { code: 'EACCES' });
    expect(describeWriteFailure(eacces, 'README.md').message).toMatch(/^the workspace is not writable .*EACCES on README\.md/);

    const enospc = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    expect(describeWriteFailure(enospc, 'README.md')).toBe(enospc);
  });
});
