/**
 * Contract tests for `buildTaskTool` — the subagent spawn surface.
 *
 * The tool has lived through five major fixes in two days
 * . These tests pin the contracts
 * those fixes added so a future change can't silently regress them:
 *
 * - Foreground execution returns a synopsis from the subagent.
 * - Empty goal returns an error result, no spawn.
 * - parentSystemPrompt (string OR getter) is inherited verbatim
 * and the scope wrapper is appended.
 * - subagentLoopOptions forwards parent runtime contract
 * (nativeTools / messageTokenBudget / output budgets) into the
 * inner ToolUseLoop — this was the root cause of the multi-day
 * subagent stall fixed in .
 * - subagent:task:spawn telemetry fires with the right payload
 * shape (systemPromptChars, inheritedFromParent, registryToolCount).
 * - The subagent's tool registry includes every parent tool EXCEPT
 * `task` (no nested subagent spawning).
 * - Background path returns a task id immediately when a
 * backgroundStore is wired up; falls back to synchronous when
 * it isn't.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@burtson-labs/agent-core';
import { buildTaskTool } from '../src/tools/taskTool';
import type { BackgroundTaskStore, BackgroundTaskRecord } from '../src/backgroundTasks';
import {
  testCtx,
  buildScriptedChat,
  buildRecordingTool
} from './_helpers';

/** Minimal in-memory background store implementing the interface. */
function buildInMemoryBackgroundStore(): BackgroundTaskStore & { records: Map<string, BackgroundTaskRecord> } {
  const records = new Map<string, BackgroundTaskRecord>();
  let counter = 0;
  return {
    records,
    start(goal) {
      const id = `bg-${++counter}`;
      records.set(id, {
        id,
        goal,
        status: 'running',
        synopsis: undefined,
        iterations: 0,
        toolCalls: 0,
        startedAt: Date.now()
      } as BackgroundTaskRecord);
      return id;
    },
    progress(id, info) {
      const rec = records.get(id);
      if (rec) {
        Object.assign(rec, info);
      }
    },
    complete(id, synopsis) {
      const rec = records.get(id);
      if (rec) {
        rec.status = 'done';
        rec.synopsis = synopsis;
      }
    },
    fail(id, reason) {
      const rec = records.get(id);
      if (rec) {
        rec.status = 'failed';
        rec.error = reason;
      }
    },
    get(id) {
      return records.get(id);
    },
    list() {
      return Array.from(records.values());
    },
    listByStatus(status) {
      return Array.from(records.values()).filter((r) => r.status === status);
    },
    drainPending() {
      const out = Array.from(records.values()).filter((r) => r.status === 'done' && !r.delivered);
      for (const r of out) r.delivered = true;
      return out;
    }
  };
}

describe('buildTaskTool', () => {
  it('exposes name="task" and a required goal parameter', () => {
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => 'unused');
    const tool = buildTaskTool({ chat, parentRegistry, ctx: testCtx });
    expect(tool.name).toBe('task');
    const goalParam = tool.parameters.find((p) => p.name === 'goal');
    expect(goalParam?.required).toBe(true);
  });

  it('returns an error result when goal is missing or empty', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => 'unused');
    const tool = buildTaskTool({ chat, parentRegistry, ctx: testCtx });
    const r1 = await tool.execute({ goal: '' }, testCtx);
    expect(r1.isError).toBe(true);
    expect(r1.output).toMatch(/goal parameter is required/);
    const r2 = await tool.execute({ goal: '   ' }, testCtx);
    expect(r2.isError).toBe(true);
  });

  it('runs a foreground subagent and returns its synopsis', async () => {
    const parentRegistry = new ToolRegistry();
    const recRead = { calls: 0 };
    parentRegistry.register(buildRecordingTool('read_file', recRead));

    let turn = 0;
    const { chat } = buildScriptedChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      }
      return 'Read a.ts and confirmed the export shape.';
    });

    const tool = buildTaskTool({ chat, parentRegistry, ctx: testCtx });
    const result = await tool.execute({ goal: 'check a.ts exports' }, testCtx);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Read a.ts');
    expect(recRead.calls).toBe(1);
  });

  it('wraps the synopsis with a directive header pushing the parent to synthesize, not restate its iter-0 hypothesis (v1.7.247 — regression for the Gemma 4 4kec turn)', async () => {
    // Pre- , the parent model could see the subagent's synopsis
    // in the tool result and still respond as if the subagent were
    // still running ("while it digs into…"), restating its iter-0
    // hypothesis verbatim instead of integrating the actual findings.
    // The directive header is a structural signal ("=== SUBAGENT
    // REPORT ===") so the parent treats this as the answer, not raw
    // data it can ignore. Pinning the header so future cleanup
    // doesn't accidentally strip it.
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => 'Concrete finding: the foo function has a bug.');
    const tool = buildTaskTool({ chat, parentRegistry, ctx: testCtx });
    const result = await tool.execute({ goal: 'audit the foo function' }, testCtx);
    expect(result.isError).toBe(false);
    // Directive header is present and unambiguous.
    expect(result.output).toContain('=== SUBAGENT REPORT');
    expect(result.output).toMatch(/answer to your delegation/i);
    // Forbidden behaviors are spelled out so the prompt itself documents
    // the failure mode.
    expect(result.output).toMatch(/Do NOT/);
    expect(result.output).toMatch(/while it digs/i);
    expect(result.output).toMatch(/restate your initial hypothesis/i);
    // Subagent's actual content still flows through unchanged.
    expect(result.output).toContain('Concrete finding: the foo function has a bug.');
    // Header comes BEFORE the synopsis (so the model reads the
    // directive first, then the findings).
    const headerIdx = result.output.indexOf('=== SUBAGENT REPORT');
    const synopsisIdx = result.output.indexOf('Concrete finding');
    expect(headerIdx).toBeLessThan(synopsisIdx);
  });

  it('inherits parentSystemPrompt verbatim (string form) and appends the scope wrapper', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat, capturedSystemPrompts } = buildScriptedChat(() => 'Done.');
    const parentPrompt = '## I am the parent. Do all the parent things.';
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      parentSystemPrompt: parentPrompt
    });

    await tool.execute({ goal: 'just answer' }, testCtx);
    expect(capturedSystemPrompts.length).toBeGreaterThan(0);
    const seen = capturedSystemPrompts[0];
    expect(seen.startsWith(parentPrompt)).toBe(true);
    // Scope wrapper is appended.
    expect(seen).toContain('## Subagent Scope');
    expect(seen).toContain('Your goal: just answer');
  });

  it('inherits parentSystemPrompt via a getter (resolved at spawn time)', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat, capturedSystemPrompts } = buildScriptedChat(() => 'Done.');
    let dynamic = '## first version';
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      parentSystemPrompt: () => dynamic
    });

    // Mutate the value before invoking — the getter should resolve to
    // the latest value when the subagent actually spawns.
    dynamic = '## resolved at spawn time, not registration';
    await tool.execute({ goal: 'go' }, testCtx);
    expect(capturedSystemPrompts[0]).toContain('resolved at spawn time');
  });

  it('falls back to SUBAGENT_PROMPT_FALLBACK when parentSystemPrompt is unset', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat, capturedSystemPrompts } = buildScriptedChat(() => 'Done.');
    const tool = buildTaskTool({ chat, parentRegistry, ctx: testCtx });

    await tool.execute({ goal: 'go' }, testCtx);
    const seen = capturedSystemPrompts[0];
    // The fallback's distinguishing line — qwen-parser-safe inline
    // tool-call format example after a colon.
    expect(seen).toMatch(/Call tools by outputting on a single line/);
    expect(seen).toContain('## Subagent Scope');
  });

  it('forwards subagentLoopOptions.nativeTools so inner loop calls chat with native schemas', async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('read_file', { calls: 0 }));
    const { chat, capturedToolsArg } = buildScriptedChat(() => 'Done.');
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      subagentLoopOptions: { nativeTools: true }
    });

    await tool.execute({ goal: 'go' }, testCtx);
    // Native-tools mode: chat receives schemas as the second arg
    // (and the system prompt drops the XML tool block).
    expect(Array.isArray(capturedToolsArg[0])).toBe(true);
    expect((capturedToolsArg[0] as unknown[]).length).toBeGreaterThan(0);
  });

  it('forwards subagentLoopOptions via getter form', async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('read_file', { calls: 0 }));
    const { chat, capturedToolsArg } = buildScriptedChat(() => 'Done.');
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      subagentLoopOptions: () => ({ nativeTools: true })
    });

    await tool.execute({ goal: 'go' }, testCtx);
    expect(Array.isArray(capturedToolsArg[0])).toBe(true);
  });

  it('emits subagent:task:spawn with systemPromptChars, inheritedFromParent, registryToolCount', async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('a', { calls: 0 }));
    parentRegistry.register(buildRecordingTool('b', { calls: 0 }));
    parentRegistry.register(buildRecordingTool('c', { calls: 0 }));
    const events: Array<{ type: string; payload: unknown }> = [];
    const { chat } = buildScriptedChat(() => 'Done.');

    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      parentSystemPrompt: '## inherited from parent',
      onEvent: (type, payload) => events.push({ type, payload })
    });

    await tool.execute({ goal: 'go' }, testCtx);
    const spawn = events.find((e) => e.type === 'subagent:task:spawn');
    expect(spawn).toBeDefined();
    const payload = spawn?.payload as {
      systemPromptChars?: number;
      inheritedFromParent?: boolean;
      registryToolCount?: number;
      goal?: string;
    };
    expect(payload.systemPromptChars).toBeGreaterThan(0);
    expect(payload.inheritedFromParent).toBe(true);
    // Subagent's registry should have the 3 parent tools (no `task`
    // since we didn't register one — but the helper would exclude it
    // anyway).
    expect(payload.registryToolCount).toBe(3);
    expect(payload.goal).toBe('go');
  });

  it('excludes `task` from the subagent registry to prevent nested spawning', async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('a', { calls: 0 }));
    // Pretend `task` is already registered on the parent (the host
    // wires it up that way).
    parentRegistry.register({
      name: 'task',
      description: 'parent task tool',
      parameters: [],
      async execute() { return { output: 'should not be in subagent registry' }; }
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const { chat } = buildScriptedChat(() => 'Done.');

    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      onEvent: (type, payload) => events.push({ type, payload })
    });
    await tool.execute({ goal: 'go' }, testCtx);
    const spawn = events.find((e) => e.type === 'subagent:task:spawn');
    const payload = spawn?.payload as { registryToolCount?: number };
    // Parent registry has 2 tools; subagent gets only 1 (task excluded).
    expect(payload.registryToolCount).toBe(1);
  });

  it('updates the background-store record with real iteration + tool counts as the subagent runs (regression for v1.7.235 silent-zero bug)', async () => {
    // Pre- , the progress emitter listened for `iteration:start`
    // and `tool:call` — events the loop never emits. Result: every
    // background-task record showed `0 iter / 0 tools` forever in the
    // host's grouped-subagent panel, even after a 6-minute run that
    // really did 6 iterations and 30 tool calls. This test pins the
    // canonical event wiring (`tool_loop:llm_start` for iter,
    // `tool_loop:tool_execute` for tools) so that regression can't
    // sneak back.
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('read_file', { calls: 0 }));
    let turn = 0;
    const { chat } = buildScriptedChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      if (turn === 2) return '<tool_call>{"name":"read_file","params":{"path":"b.ts"}}</tool_call>';
      return 'Two files read; the export shape is unchanged.';
    });
    const store = buildInMemoryBackgroundStore();
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store
    });

    await tool.execute({ goal: 'count two files', run_in_background: 'true' }, testCtx);

    // Wait one microtask tick for the detached subagent run to drain.
    // The mock chat resolves synchronously, so the run completes
    // before the next macrotask.
    await new Promise((r) => setImmediate(r));

    const record = Array.from(store.records.values())[0];
    expect(record).toBeDefined();
    // 3 LLM calls (2 tool-call iterations + 1 final-response iteration).
    expect(record.iterations).toBeGreaterThanOrEqual(2);
    // 2 tool executions.
    expect(record.toolCalls).toBe(2);
    // Last tool seen.
    expect(record.lastTool).toBe('read_file');
  });

  it('returns a task id immediately when run_in_background is true and a backgroundStore is wired', async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('read_file', { calls: 0 }));
    let turn = 0;
    const { chat } = buildScriptedChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"read_file","params":{}}</tool_call>';
      return 'Eventually done.';
    });
    const store = buildInMemoryBackgroundStore();

    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store
    });

    const result = await tool.execute(
      { goal: 'long investigation', run_in_background: 'true' },
      testCtx
    );
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/Spawned background subagent/i);
    expect(result.output).toMatch(/bg-\d+/);
    // The store should have a record.
    expect(store.records.size).toBe(1);
  });

  it('falls back to synchronous run when run_in_background is true but no store is wired', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => 'Resolution complete after research.');
    const tool = buildTaskTool({ chat, parentRegistry, ctx: testCtx });

    const result = await tool.execute(
      { goal: 'do it sync', run_in_background: 'true' },
      testCtx
    );
    // Synchronous fallback returns the synopsis directly, not a task id.
    // The fallback note explains why background was requested but ran sync.
    expect(result.output).toMatch(/run_in_background was requested/i);
    expect(result.output).not.toMatch(/bg-\d+/);
    expect(result.isError).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Concurrency cap: keeps the model from fanning out unbounded background
  // subagents ( with 7 in flight, all hitting Ollama
  // simultaneously and starving the host's token budget). Default cap is 3.
  // ────────────────────────────────────────────────────────────────────────

  it('refuses to spawn a new background subagent when the default cap (3) is reached', async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(buildRecordingTool('read_file', { calls: 0 }));
    // Chat that NEVER resolves so the spawned subagents stay 'running'
    // (they never reach complete/fail). This is the precondition for
    // hitting the cap — three live tasks blocking a fourth.
    const neverResolves: typeof testCtx.runCommand = async function* () {
      yield 'still thinking';
      // Hang forever. The test is only interested in the cap response;
      // we never await these subagent runs to completion.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } as unknown as typeof testCtx.runCommand;
    const chat = neverResolves as unknown as Parameters<typeof buildTaskTool>[0]['chat'];
    const store = buildInMemoryBackgroundStore();
    const events: Array<{ type: string; payload: unknown }> = [];

    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store,
      onEvent: (type, payload) => events.push({ type, payload })
    });

    // Fill the cap.
    const r1 = await tool.execute({ goal: 'one', run_in_background: 'true' }, testCtx);
    const r2 = await tool.execute({ goal: 'two', run_in_background: 'true' }, testCtx);
    const r3 = await tool.execute({ goal: 'three', run_in_background: 'true' }, testCtx);
    expect(r1.output).toMatch(/Spawned background subagent/i);
    expect(r2.output).toMatch(/Spawned background subagent/i);
    expect(r3.output).toMatch(/Spawned background subagent/i);
    expect(store.records.size).toBe(3);

    // The 4th is refused with a calm flow-control message — NOT an error.
    const r4 = await tool.execute({ goal: 'four', run_in_background: 'true' }, testCtx);
    expect(r4.isError).toBe(false);
    expect(r4.output).toMatch(/Background subagent limit reached/);
    expect(r4.output).toMatch(/3 \/ 3/);
    // Surfaces the running ids so the model can call check_task on one.
    expect(r4.output).toMatch(/bg-1/);
    expect(r4.output).toMatch(/bg-2/);
    expect(r4.output).toMatch(/bg-3/);
    // No 4th record was created — the cap blocked store.start.
    expect(store.records.size).toBe(3);
    // task:cap-hit telemetry fires so hosts can show a hint.
    const capEvent = events.find((e) => e.type === 'task:cap-hit');
    expect(capEvent).toBeDefined();
    expect((capEvent!.payload as { runningCount: number }).runningCount).toBe(3);
  });

  it('honours an explicit maxConcurrentBackground option', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => {
      // Hang forever so spawns stay 'running' and the cap is observable.
      return new Promise<string>(() => undefined) as unknown as string;
    });
    const store = buildInMemoryBackgroundStore();
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store,
      maxConcurrentBackground: 1
    });

    const r1 = await tool.execute({ goal: 'one', run_in_background: 'true' }, testCtx);
    expect(r1.output).toMatch(/Spawned background subagent/i);
    const r2 = await tool.execute({ goal: 'two', run_in_background: 'true' }, testCtx);
    expect(r2.output).toMatch(/Background subagent limit reached/);
    expect(r2.output).toMatch(/1 \/ 1/);
  });

  it('disables the cap entirely when maxConcurrentBackground is 0', async () => {
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => {
      return new Promise<string>(() => undefined) as unknown as string;
    });
    const store = buildInMemoryBackgroundStore();
    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store,
      maxConcurrentBackground: 0
    });

    // Spawn 5 in a row — none should be capped.
    for (let i = 0; i < 5; i++) {
      const r = await tool.execute({ goal: `t${i}`, run_in_background: 'true' }, testCtx);
      expect(r.output).toMatch(/Spawned background subagent/i);
    }
    expect(store.records.size).toBe(5);
  });

  it('treats foreground (synchronous) tasks as exempt from the cap', async () => {
    // Sync tasks are serial by construction — they can never run
    // concurrently with anything else from the same parent. Cap should
    // not apply to them even when a backgroundStore is wired up.
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => 'Quick foreground answer.');
    const store = buildInMemoryBackgroundStore();
    // Pre-load the store with 3 fake running records to simulate cap-hit.
    for (let i = 0; i < 3; i++) store.start(`bg goal ${i}`);

    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store,
      maxConcurrentBackground: 3
    });

    // Foreground call (no run_in_background) should still execute.
    const r = await tool.execute({ goal: 'sync work' }, testCtx);
    expect(r.isError).toBe(false);
    expect(r.output).not.toMatch(/Background subagent limit reached/);
    expect(r.output).toMatch(/Quick foreground answer/);
  });

  it('frees a slot when a running subagent reaches a terminal state', async () => {
    // The cap is computed against listByStatus('running'), so a task
    // that completes / fails / is cancelled should free its slot for
    // the next call. Pre-load 3 running tasks then mark one done.
    const parentRegistry = new ToolRegistry();
    const { chat } = buildScriptedChat(() => 'done.');
    const store = buildInMemoryBackgroundStore();
    const id1 = store.start('a');
    store.start('b');
    store.start('c');
    // Mark the first one as done (the helper uses 'done' as its terminal
    // status — listByStatus('running') still excludes it, so the cap math
    // sees only 2 running).
    store.complete(id1, 'a is done');

    const tool = buildTaskTool({
      chat,
      parentRegistry,
      ctx: testCtx,
      backgroundStore: store,
      maxConcurrentBackground: 3
    });

    const r = await tool.execute({ goal: 'fourth — but a slot just opened', run_in_background: 'true' }, testCtx);
    expect(r.output).toMatch(/Spawned background subagent/i);
  });
});
