/**
 * The turn itself, driven by the scripted provider — no model, no network.
 *
 * Three things are pinned here:
 *  - the event grammar and the terminal-honesty rule (a zero-artifact
 *    completion must carry a reason a human can read);
 *  - cancellation (COMP-004): once the caller is gone the turn stops, and
 *    critically stops WRITING — an abandoned turn must not keep editing a
 *    workspace nobody is watching;
 *  - the permission gate (SEC-005): read-only mode refuses a write and the
 *    refusal is visible upstream instead of silently succeeding.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatFn } from '@burtson-labs/agent-core';
import { runTurn } from '../src/turn';
import type { RunnerEvent, TurnRequest } from '../src/contract';

const WRITE_HELLO =
  '<tool_call>{"name": "write_file", "params": {"path": "hello.md", "content": "# Hello\\n"}}</tool_call>';

let graphFlag: string | undefined;
const dirs: string[] = [];

beforeAll(() => {
  // The graph route adds a planner completion the scripted provider would
  // have to satisfy; these tests are about the plain loop.
  graphFlag = process.env.RUNNER_GRAPH;
  process.env.RUNNER_GRAPH = '0';
});

afterAll(() => {
  if (graphFlag === undefined) delete process.env.RUNNER_GRAPH;
  else process.env.RUNNER_GRAPH = graphFlag;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-turn-'));
  dirs.push(ws);
  return fs.realpathSync(ws);
}

function request(ws: string, script: string[], prompt = 'Create hello.md with a greeting.'): TurnRequest {
  return {
    protocol: 1,
    taskId: 'task-1',
    workspacePath: ws,
    prompt,
    provider: { kind: 'deterministic', script },
    maxIterations: 4,
  };
}

async function collect(
  req: TurnRequest,
  deps?: Parameters<typeof runTurn>[2],
): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  await runTurn(req, (e) => events.push(e), { permissionMode: 'standard', ...deps });
  return events;
}

describe('runTurn — happy path', () => {
  it('writes the file and reports it, ending with turn.completed', async () => {
    const ws = workspace();

    const events = await collect(request(ws, [WRITE_HELLO, 'I created hello.md.']));
    const types = events.map((e) => e.type);

    expect(fs.readFileSync(path.join(ws, 'hello.md'), 'utf8')).toBe('# Hello\n');
    expect(types).toContain('tool.call');
    expect(types).toContain('artifact.changed');
    expect(types[0]).toBe('turn.started');
    expect(types[types.length - 1]).toBe('turn.completed');
    expect(events[events.length - 1]).toMatchObject({ artifacts: 1 });
  });

  it('explains itself when it completes without changing anything', async () => {
    const ws = workspace();

    const events = await collect(request(ws, ['Nothing to do here.']));
    const last = events[events.length - 1];

    expect(last.type).toBe('turn.completed');
    expect(last).toMatchObject({ artifacts: 0 });
    expect(String((last as { noChangeReason?: string }).noChangeReason)).toMatch(/\S/);
  });
});

describe('runTurn — cancellation (COMP-004)', () => {
  it('stops before any tool runs when the signal is already aborted', async () => {
    const ws = workspace();
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));

    const events = await collect(request(ws, [WRITE_HELLO, 'done']), { signal: controller.signal });

    expect(events.map((e) => e.type)).toEqual(['turn.started', 'turn.error']);
    expect(events[1]).toMatchObject({ code: 'TURN_CANCELLED', message: 'client disconnected' });
    expect(fs.existsSync(path.join(ws, 'hello.md'))).toBe(false);
  });

  it('writes nothing more once the caller disconnects mid-turn', async () => {
    const ws = workspace();
    const controller = new AbortController();
    // The model "responds" with a write, but the caller vanished while it
    // was streaming — the write must never land.
    const chat: ChatFn = async function* aborting() {
      controller.abort(new Error('client disconnected'));
      yield WRITE_HELLO;
    };

    const events = await collect(request(ws, []), { signal: controller.signal, chat });
    const last = events[events.length - 1];

    expect(last.type).toBe('turn.error');
    expect(last).toMatchObject({ code: 'TURN_CANCELLED' });
    expect(events.map((e) => e.type)).not.toContain('artifact.changed');
    expect(fs.existsSync(path.join(ws, 'hello.md'))).toBe(false);
  });

  it('never reports a cancelled turn as completed', async () => {
    const ws = workspace();
    const controller = new AbortController();
    const chat: ChatFn = async function* aborting() {
      controller.abort();
      yield 'All done!';
    };

    const events = await collect(request(ws, []), { signal: controller.signal, chat });

    expect(events.map((e) => e.type)).not.toContain('turn.completed');
  });
});

describe('runTurn — permission gate (SEC-005)', () => {
  it('refuses a write in read-only mode and surfaces the refusal', async () => {
    const ws = workspace();

    const events = await collect(request(ws, [WRITE_HELLO, 'I could not write.']), {
      permissionMode: 'read-only',
    });
    const results = events.filter((e) => e.type === 'tool.result') as Array<{ ok: boolean; summary: string }>;

    expect(fs.existsSync(path.join(ws, 'hello.md'))).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results[0].summary).toMatch(/read-only/i);
  });

  it('allows a workspace write in standard mode', async () => {
    const ws = workspace();

    await collect(request(ws, [WRITE_HELLO, 'done']), { permissionMode: 'standard' });

    expect(fs.existsSync(path.join(ws, 'hello.md'))).toBe(true);
  });
});
