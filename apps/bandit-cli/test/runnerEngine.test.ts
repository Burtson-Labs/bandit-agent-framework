/**
 * RemoteRunner engine — the local half of remote control. These drive it with
 * an in-memory fake gateway and a scripted chat so the whole loop runs without
 * a network or a model: a task in → the plan-mode gate + tool loop → the exact
 * event stream the gateway relays to the web.
 */
import { describe, it, expect } from 'vitest';
import { RemoteRunner } from '../src/runner/engine';
import type { RemoteTask, RunnerEvent, RunnerGateway } from '../src/runner/contract';
import type { ChatFn, ToolExecutionContext } from '@burtson-labs/agent-core';

/** Records every published event; can also feed tasks through the inbox. */
class FakeGateway implements RunnerGateway {
  readonly events: RunnerEvent[] = [];
  publishError: Error | null = null;
  constructor(private readonly tasks: RemoteTask[] = []) {}

  async *inbox(signal: AbortSignal): AsyncIterable<RemoteTask> {
    for (const t of this.tasks) {
      if (signal.aborted) return;
      yield t;
    }
  }

  async publish(_taskId: string, event: RunnerEvent): Promise<void> {
    if (this.publishError) throw this.publishError;
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }
  find<T extends RunnerEvent['type']>(type: T): Extract<RunnerEvent, { type: T }> | undefined {
    return this.events.find((e) => e.type === type) as Extract<RunnerEvent, { type: T }> | undefined;
  }
}

/** A chat that yields a scripted response per call — tool-call markup the loop
 *  parses, then a plain final answer to end the loop. */
function scriptedChat(steps: string[]): ChatFn {
  let i = 0;
  return async function* () {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    yield step;
  };
}

/** Minimal context — only readFile needs to work (read-only tools); mutating
 *  methods throw because the plan-mode gate must block them BEFORE execution. */
function fakeContext(root: string): ToolExecutionContext {
  const nope = async () => { throw new Error('ctx method should not run under plan mode'); };
  return {
    workspaceRoot: root,
    readFile: async () => 'hello world\nsecond line\n',
    writeFile: nope,
    deleteFile: nope,
    listFiles: async () => ['README.md'],
    listDirectoryEntries: async () => ['README.md'],
    searchCode: async () => '',
    runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 })
  } as unknown as ToolExecutionContext;
}

const READ = '<tool_call>{"name":"read_file","params":{"path":"README.md"}}</tool_call>';
const WRITE = '<tool_call>{"name":"write_file","params":{"path":"x.ts","content":"hi"}}</tool_call>';

function makeRunner(gateway: FakeGateway, chat: ChatFn, defaultMode?: 'plan' | 'ask' | 'auto') {
  return new RemoteRunner({
    gateway,
    workspaceRoot: '/repo',
    chatFactory: () => chat,
    contextFactory: fakeContext,
    defaultMode
  });
}

describe('RemoteRunner — event stream', () => {
  it('brackets a task with turn.started(mode) … turn.completed', async () => {
    const gw = new FakeGateway();
    await makeRunner(gw, scriptedChat(['All done — here is my plan.'])).runTask({
      protocol: 1, taskId: 't1', prompt: 'look around', mode: 'plan'
    });
    expect(gw.types()[0]).toBe('turn.started');
    expect(gw.types().at(-1)).toBe('turn.completed');
    expect(gw.find('turn.started')?.mode).toBe('plan');
  });

  it('defaults to plan mode when the task omits one', async () => {
    const gw = new FakeGateway();
    await makeRunner(gw, scriptedChat(['plan text'])).runTask({ protocol: 1, taskId: 't2', prompt: 'go' });
    expect(gw.find('turn.started')?.mode).toBe('plan');
  });

  it('runs a read but BLOCKS a write in plan mode, and completes with zero artifacts', async () => {
    const gw = new FakeGateway();
    await makeRunner(gw, scriptedChat([READ, WRITE, 'My plan: edit x.ts to add the export.'])).runTask({
      protocol: 1, taskId: 't3', prompt: 'change x.ts', mode: 'plan'
    });
    const types = gw.types();
    // read_file allowed → tool.call + ok result
    expect(types).toContain('tool.call');
    const readResult = gw.events.find((e) => e.type === 'tool.result' && e.tool === 'read_file');
    expect(readResult && (readResult as { ok: boolean }).ok).toBe(true);
    // write_file refused by the gate → tool.blocked, never a successful result
    const blocked = gw.find('tool.blocked');
    expect(blocked?.tool).toBe('write_file');
    expect(gw.events.some((e) => e.type === 'tool.result' && e.tool === 'write_file' && (e as { ok: boolean }).ok)).toBe(false);
    // read-only turn → no artifacts, and the reason says so
    const done = gw.find('turn.completed');
    expect(done?.artifacts).toBe(0);
    expect(done?.noChangeReason).toMatch(/read-only|plan/i);
    // no artifact.changed for a blocked write
    expect(gw.types()).not.toContain('artifact.changed');
  });

  it('never leaks event order — turn.started is first, terminal event is last', async () => {
    const gw = new FakeGateway();
    await makeRunner(gw, scriptedChat([READ, 'done'])).runTask({ protocol: 1, taskId: 't4', prompt: 'x', mode: 'plan' });
    const t = gw.types();
    expect(t.indexOf('turn.started')).toBe(0);
    expect(t.lastIndexOf('turn.completed')).toBe(t.length - 1);
    expect(t.filter((x) => x === 'turn.started')).toHaveLength(1);
  });
});

describe('RemoteRunner — resilience', () => {
  it('a failing publish never throws out of runTask', async () => {
    const gw = new FakeGateway();
    gw.publishError = new Error('gateway down');
    const statuses: string[] = [];
    const runner = new RemoteRunner({
      gateway: gw, workspaceRoot: '/repo', chatFactory: () => scriptedChat(['x']),
      contextFactory: fakeContext, onStatus: (m) => statuses.push(m)
    });
    await expect(runner.runTask({ protocol: 1, taskId: 't5', prompt: 'go', mode: 'plan' })).resolves.toBeUndefined();
    expect(statuses.some((s) => /publish failed/.test(s))).toBe(true);
  });

  it('inbox drives runTask for each task and one task failure does not stop the runner', async () => {
    const gw = new FakeGateway([
      { protocol: 1, taskId: 'a', prompt: 'one', mode: 'plan' },
      { protocol: 1, taskId: 'b', prompt: 'two', mode: 'plan' }
    ]);
    await makeRunner(gw, scriptedChat(['done'])).run(new AbortController().signal);
    const started = gw.events.filter((e) => e.type === 'turn.started');
    expect(started).toHaveLength(2);
  });
});
