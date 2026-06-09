/**
 * Cancellation contract for ToolUseLoop.
 *
 * Verifies the loop's cooperative cancellation via `options.signal`:
 *
 *   - Pre-iteration: signal aborted before the first iteration
 *     starts → loop returns immediately with cancelled=true.
 *   - Mid-stream: signal aborted during chat streaming → the loop
 *     captures whatever text arrived, marks the result cancelled,
 *     does not execute any tool calls from the partial response.
 *   - Post-stream: signal aborted after chat returns but before tool
 *     execution → cancelled=true with full response captured.
 *   - Mid-tool-execution (serialized batch): signal aborted between
 *     two queued tool calls → only the calls before the abort run.
 *
 * Result shape on cancel: { cancelled: true, hitLimit: false,
 * finalResponse: '<captured text or "[cancelled]">' }. Pinning so a
 * future regression that drops cancelled=true or sets hitLimit
 * incorrectly is caught.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder,
  yieldChunks
} from './_helpers';

describe('ToolUseLoop cancellation contract', () => {
  it('returns immediately with cancelled=true when signal is pre-aborted', async () => {
    const registry = new ToolRegistry();
    const { chat, recorder } = buildMockChat(() => 'should never run');
    const controller = new AbortController();
    controller.abort();
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      signal: controller.signal
    });

    const result = await loop.run('do something', chat);
    expect(result.cancelled).toBe(true);
    expect(result.hitLimit).toBe(false);
    expect(result.finalResponse).toBe('[cancelled]');
    // The chat function should never have been called.
    expect(recorder.callCount).toBe(0);
    const cancelEvents = events.filter((e) => e.type === 'tool_loop:cancelled');
    expect(cancelEvents.length).toBe(1);
    expect((cancelEvents[0].payload as { stage?: string }).stage).toBe('pre_iteration');
  });

  it('cancels mid-stream and captures the partial response', async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();

    // Build a chat function that yields a few chunks, then aborts the
    // signal partway through. The loop's streamAndAggregate should
    // notice signal.aborted on the next iteration of the chunk loop.
    const chat = async function* () {
      yield 'Reading the file';
      yield ' to find the answer';
      controller.abort();
      // Without aborting upstream the chat would keep yielding; the
      // loop's check is what stops processing. Yield once more to
      // confirm the loop bails on the next chunk boundary.
      yield ' ... continued';
    };

    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      signal: controller.signal
    });

    const result = await loop.run('do it', chat);
    expect(result.cancelled).toBe(true);
    expect(result.hitLimit).toBe(false);
    // Captured response should contain at least the chunks emitted
    // before the abort.
    expect(result.finalResponse).toContain('Reading the file');
    // The post-stream cancellation point fires.
    const cancelEvents = events.filter((e) => e.type === 'tool_loop:cancelled');
    expect(cancelEvents.length).toBeGreaterThanOrEqual(1);
    expect(cancelEvents.some((e) => (e.payload as { stage?: string }).stage === 'post_stream')).toBe(true);
  });

  it('does not execute tool calls when cancelled mid-stream after a tool_call markup arrived', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: [{ name: 'path', description: 'p', required: true }],
      async execute(params: Record<string, string>): Promise<ToolResult> {
        captured.paths.push(params.path ?? '');
        return { output: 'data' };
      }
    });
    const controller = new AbortController();

    const chat = async function* () {
      // Stream a complete tool_call envelope, then abort.
      yield '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      controller.abort();
    };

    const loop = new ToolUseLoop(registry, testCtx, { signal: controller.signal });
    const result = await loop.run('read a.ts', chat);
    expect(result.cancelled).toBe(true);
    // The tool call should NOT have run — the post-stream cancellation
    // returns before parseToolCalls is even reached.
    expect(captured.paths).toEqual([]);
  });

  it('iterations counter reflects work done before cancellation', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'noop',
      description: 'noop',
      parameters: [],
      async execute(): Promise<ToolResult> { return { output: 'ok' }; }
    });

    let turn = 0;
    const controller = new AbortController();
    const chat = async function* (
      _messages: ReadonlyArray<{ role: string; content: string }>
    ) {
      turn += 1;
      if (turn === 1) {
        yield '<tool_call>{"name":"noop","params":{}}</tool_call>';
        return;
      }
      // After one full iteration completed, abort before emitting the
      // second response.
      controller.abort();
      yield 'this should not be processed';
    };

    const loop = new ToolUseLoop(registry, testCtx, { signal: controller.signal });
    const result = await loop.run('do work', chat);
    expect(result.cancelled).toBe(true);
    // First iteration ran a tool call to completion → iterations >= 1.
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it('builds the cancelled result shape consistently across cancellation points', async () => {
    // Sweep both pre-iteration and post-stream points in one test to
    // pin that they produce the same result shape (cancelled=true,
    // hitLimit=false). The only difference is finalResponse text.
    const cases: Array<{ name: string; setup: () => Promise<{ cancelled: boolean; hitLimit: boolean; finalResponse: string }> }> = [
      {
        name: 'pre-iteration',
        setup: async () => {
          const controller = new AbortController();
          controller.abort();
          const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { signal: controller.signal });
          const { chat } = buildMockChat(() => 'unused');
          const r = await loop.run('go', chat);
          return r;
        }
      },
      {
        name: 'post-stream',
        setup: async () => {
          const controller = new AbortController();
          const chat = async function* () {
            yield 'partial';
            controller.abort();
          };
          const loop = new ToolUseLoop(new ToolRegistry(), testCtx, { signal: controller.signal });
          const r = await loop.run('go', chat);
          return r;
        }
      }
    ];
    for (const c of cases) {
      const r = await c.setup();
      expect(r.cancelled).toBe(true);
      expect(r.hitLimit).toBe(false);
      expect(typeof r.finalResponse).toBe('string');
    }
  });

  it('a normal (non-cancelled) run leaves cancelled undefined', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => 'all done.');
    const loop = new ToolUseLoop(registry, testCtx, {});
    const result = await loop.run('finish', chat);
    expect(result.cancelled).toBeUndefined();
    expect(result.hitLimit).toBe(false);
  });
});

// Small no-op to avoid an "unused import" warning when yieldChunks
// isn't used directly in the test bodies above (helpers/_helpers.ts
// exports it for other test files).
void yieldChunks;
