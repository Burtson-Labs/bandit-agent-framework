/**
 * Constructor-options contract for ToolUseLoop.
 *
 * Every field on `ToolUseLoopOptions` that can be passed at
 * construction must be honored at runtime when `run()` is called
 * without a per-call options bag. The original fix exposed
 * this gap on `isSubagent` and `nativeTools`; this test pins the
 * full surface so the next dropped option is caught here, not in
 * production.
 *
 * Per option, the test:
 * 1. Constructs ToolUseLoop with the option set.
 * 2. Calls run(...) with NO per-call options bag.
 * 3. Asserts on observable runtime behavior that proves the option
 * was applied (an emit, a result field, a chat() call shape).
 *
 * If you add a field to ToolUseLoopOptions, add a case here. The
 * compile-time exhaustiveness check at the bottom of this file
 * fails build until you do.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop, type ChatFn, type ToolLoopMessage, type ToolUseLoopOptions } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildReadFileTool,
  buildEmitRecorder
} from './_helpers';

describe('ToolUseLoop constructor options contract', () => {
  it('honors maxIterations', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    // Model emits a tool call every turn — loop wants to keep going.
    const { chat } = buildMockChat(() =>
      '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>'
    );
    const loop = new ToolUseLoop(registry, testCtx, { maxIterations: 1 });

    const result = await loop.run('keep going', chat);
    expect(result.hitLimit).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(2);
  });

  it('honors emitEvent', async () => {
    const registry = new ToolRegistry();
    const { events, emit } = buildEmitRecorder();
    const { chat } = buildMockChat(() => 'Just answering with prose, no tool needed.');
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit });

    await loop.run('say hi', chat);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_loop:llm_start');
    expect(types).toContain('tool_loop:llm_response');
  });

  it('honors beforeToolExecute (deny path)', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      return 'Tool was denied — wrapping up.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      beforeToolExecute: () => ({ allow: false, reason: 'denied for test' })
    });

    await loop.run('do it', chat);
    expect(captured.paths).toEqual([]);
    const blocked = events.find((e) => e.type === 'tool_loop:tool_blocked');
    expect(blocked).toBeDefined();
  });

  it('honors signal (pre-aborted)', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => 'should never run');
    const controller = new AbortController();
    controller.abort();
    const loop = new ToolUseLoop(registry, testCtx, { signal: controller.signal });

    const result = await loop.run('cancelled before start', chat);
    expect(result.cancelled).toBe(true);
  });

  it('honors maxParallelTools (excess calls are dropped, signal fires)', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Five distinct tool calls in one turn; with cap=1 the loop
        // keeps the first one and drops the rest.
        return [
          '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>',
          '<tool_call>{"name":"read_file","params":{"path":"b.ts"}}</tool_call>',
          '<tool_call>{"name":"read_file","params":{"path":"c.ts"}}</tool_call>',
          '<tool_call>{"name":"read_file","params":{"path":"d.ts"}}</tool_call>',
          '<tool_call>{"name":"read_file","params":{"path":"e.ts"}}</tool_call>'
        ].join('\n');
      }
      return 'Done reading.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxParallelTools: 1
    });

    await loop.run('read everything', chat);
    expect(captured.paths.length).toBe(1);
    const capped = events.find((e) => e.type === 'tool_loop:tool_call_capped');
    expect(capped).toBeDefined();
    expect((capped?.payload as { kept?: number })?.kept).toBe(1);
    expect((capped?.payload as { dropped?: number })?.dropped).toBe(4);
  });

  it('honors maxTotalTools', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    // Every turn the model emits a fresh tool call; cap stops at 2.
    const { chat } = buildMockChat((n) =>
      `<tool_call>{"name":"read_file","params":{"path":"f${n}.ts"}}</tool_call>`
    );
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxTotalTools: 2,
      maxIterations: 10
    });

    const result = await loop.run('keep reading', chat);
    expect(captured.paths.length).toBeLessThanOrEqual(2);
    expect(result.hitLimit).toBe(true);
    const cap = events.find((e) => e.type === 'tool_loop:total_tool_cap');
    expect(cap).toBeDefined();
  });

  it('honors outputBudgetTokens (batch serialization gate)', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    // Use a write_file-shaped tool because the budget gate weighs
    // edit-tool params heavily (find/replace/content). Multiple
    // heavy calls trip the gate.
    registry.register({
      name: 'write_file',
      description: 'write',
      parameters: [
        { name: 'path', description: 'p', required: true },
        { name: 'content', description: 'c', required: true }
      ],
      async execute(params: Record<string, string>) {
        captured.paths.push(params.path ?? '');
        return { output: 'ok' };
      }
    });
    const heavyContent = 'x'.repeat(2000);
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          `<tool_call>{"name":"write_file","params":{"path":"a.ts","content":"${heavyContent}"}}</tool_call>`,
          `<tool_call>{"name":"write_file","params":{"path":"b.ts","content":"${heavyContent}"}}</tool_call>`,
          `<tool_call>{"name":"write_file","params":{"path":"c.ts","content":"${heavyContent}"}}</tool_call>`
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      outputBudgetTokens: 200,
      outputBudgetRatio: 0.6
    });

    await loop.run('write three files', chat);
    const serialized = events.find((e) => e.type === 'tool_loop:batch_serialized');
    expect(serialized).toBeDefined();
  });

  it('honors isSubagent (subagent first-iter recovery path)', async () => {
    const registry = new ToolRegistry();
    const captured = { paths: [] as string[] };
    registry.register(buildReadFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Plain prose, no tool call, no reasoning fence, no announce-
        // intent verbs ("let me / I'll"). This shape skips the
        // earlier shouldNudge / announce-intent / false-completion
        // detectors and falls through to the subagent-first-iter
        // recovery — which is the path this test is pinning.
        return 'This requires repository inspection before I can answer.';
      }
      if (turn === 2) {
        return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      }
      return 'I read a.ts and finished the analysis.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      isSubagent: true
    });

    const result = await loop.run('subagent goal', chat);
    const recovery = events.find((e) => e.type === 'tool_loop:subagent_first_iter_no_tool_call');
    expect(recovery).toBeDefined();
    expect(captured.paths).toEqual(['a.ts']);
    expect(result.finalResponse).toContain('analysis');
  });

  it('honors nativeTools (schemas forwarded as chat tools arg, no XML in system prompt)', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    const { chat, recorder } = buildMockChat(() => 'No tool needed.');
    const loop = new ToolUseLoop(registry, testCtx, { nativeTools: true });

    // Pass an explicit system prompt so we can verify the loop
    // doesn't append the XML toolBlock to it (the whole point of
    // nativeTools mode is reclaiming those tokens).
    await loop.run('answer me', chat, 'You are a test agent.');
    expect(recorder.callCount).toBeGreaterThanOrEqual(1);
    const firstCall = recorder.calls[0];
    // Native schemas should arrive as the chat function's second arg.
    expect(firstCall.tools).toBeDefined();
    expect(Array.isArray(firstCall.tools)).toBe(true);
    expect((firstCall.tools as unknown[]).length).toBeGreaterThan(0);
    // System message should be exactly the user-supplied prompt — no
    // XML <tool> block appended.
    const systemMsg = firstCall.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toBe('You are a test agent.');
    expect(systemMsg?.content).not.toMatch(/<tool/);
  });

  it('falls back from native tools to text tools after a retryable upstream failure (with same-channel backoff retries first)', async () => {
    // v1.7.343 widened the inner same-channel retry gate so native-tools
    // turns get the same backoff ladder text-only turns have always had.
    // Before the widening: 1 native call → throw → channel switch (with
    // a second blip on text → hard fail). After: 1 native call + 2 backoff
    // retries → throw → channel switch. The fallback still fires; it just
    // requires sustained native-channel failure, not a single blip.
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const { events, emit } = buildEmitRecorder();
    const calls: Array<{ messages: ToolLoopMessage[]; tools?: unknown }> = [];
    const chat: ChatFn = (messages, tools) => {
      calls.push({ messages: messages.map((m) => ({ ...m })), tools });
      return (async function* () {
        if (tools) {
          throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
        }
        const textCallsSoFar = calls.filter((c) => !c.tools).length;
        if (textCallsSoFar === 1) {
          yield '<tool_call>{"name":"read_file","params":{"path":"src/app.ts"}}</tool_call>';
          return;
        }
        yield 'Done after text fallback.';
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxIterations: 3,
      nativeTools: true
    });

    const result = await loop.run('read the app file', chat, 'base system prompt');

    expect(result.finalResponse).toContain('Done after text fallback.');
    expect(captured.paths).toEqual(['src/app.ts']);
    const nativeCalls = calls.filter((c) => c.tools !== undefined);
    const textCalls = calls.filter((c) => c.tools === undefined);
    // Inner same-channel retry layer: initial + MAX_TRANSIENT_RETRIES (=2)
    // backoff retries = 3 native attempts before the inner loop gives up.
    expect(nativeCalls.length).toBe(3);
    // Outer text fallback: envelope-emitting call + continuation = 2.
    expect(textCalls.length).toBe(2);
    // Inner retry events fire 2× before the channel switch.
    expect(events.filter((e) => e.type === 'tool_loop:llm_retry').length).toBe(2);
    // Outer fallback fires exactly once after the inner retries exhaust.
    expect(events.filter((e) => e.type === 'tool_loop:native_tool_fallback').length).toBe(1);
    // First text-channel call carries the system-prompt swap + the v1.7.299
    // synthetic user message explaining the channel change. Without that,
    // models anchored on the prior native-tools envelope and kept emitting
    // native-style payloads into the void.
    const firstTextCall = textCalls[0];
    expect(firstTextCall.messages[0]?.content).toContain('base system prompt');
    expect(firstTextCall.messages[0]?.content).toContain('<tool_call>');
    const syntheticMsg = firstTextCall.messages.find(
      (m) => m.role === 'user' && m.content.includes('Provider error mid-turn')
    );
    expect(syntheticMsg).toBeDefined();
    expect(syntheticMsg?.content).toMatch(/tool channel switched/);
    expect(syntheticMsg?.content).toMatch(/<tool_call>/);
  });

  it('recovers from a single transient 500 on the native channel without disturbing the user (no fallback fired)', async () => {
    // The payoff case for the gate widening. Most production 500s are a
    // single gateway/load-balancer blip. Pre-v1.7.343 those one-offs
    // immediately triggered the disruptive channel switch (with a second
    // blip on text → hard fail). Post-v1.7.343 a single retryable 500 with
    // zero streamed output replays the SAME native request on backoff. The
    // user sees nothing, no fallback event fires.
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const { events, emit } = buildEmitRecorder();
    const calls: Array<{ messages: ToolLoopMessage[]; tools?: unknown }> = [];
    let nativeAttempt = 0;
    const chat: ChatFn = (messages, tools) => {
      calls.push({ messages: messages.map((m) => ({ ...m })), tools });
      return (async function* () {
        if (tools) {
          nativeAttempt++;
          if (nativeAttempt === 1) {
            throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
          }
          // 2nd native attempt (the retry payoff): emit the tool_call.
          // 3rd+ native attempts (subsequent loop iterations after the
          // tool result is in scope): emit a final answer so the loop
          // terminates cleanly instead of re-running the same tool.
          if (nativeAttempt === 2) {
            yield '<tool_call>{"name":"read_file","params":{"path":"src/app.ts"}}</tool_call>';
            return;
          }
          yield 'Read it. App entry point looks fine.';
          return;
        }
        yield 'Should not reach text fallback.';
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxIterations: 3,
      nativeTools: true
    });

    const result = await loop.run('read the app file', chat, 'base system prompt');

    expect(captured.paths).toEqual(['src/app.ts']);
    expect(calls.filter((c) => c.tools === undefined).length).toBe(0);
    expect(events.filter((e) => e.type === 'tool_loop:llm_retry').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool_loop:native_tool_fallback').length).toBe(0);
    expect(result.finalResponse).not.toContain('text fallback');
  });

  it('honors nativeToolFailureFallback=false (native upstream failures do not degrade)', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    const { events, emit } = buildEmitRecorder();
    let calls = 0;
    const chat: ChatFn = (_messages, tools) => {
      calls += 1;
      return (async function* () {
        if (tools) {
          throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
        }
        yield 'should not reach text fallback';
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      nativeTools: true,
      nativeToolFailureFallback: false
    });

    await expect(loop.run('read the app file', chat, 'base system prompt')).rejects.toThrow(/500 Internal Server Error/);
    // v1.7.343: the inner same-channel retry layer fires INDEPENDENTLY of
    // nativeToolFailureFallback. Disabling fallback prevents the channel
    // switch, but transient blips still get the backoff ladder before the
    // error propagates — initial call + MAX_TRANSIENT_RETRIES = 3.
    expect(calls).toBe(3);
    expect(events.some((e) => e.type === 'tool_loop:native_tool_fallback')).toBe(false);
  });

  it('text channel gets one outer-layer retry after the native fallback before throwing terminally', { timeout: 30_000 }, async () => {
    // v1.7.343: a transient blip on the text channel right after the
    // native→text switch used to hard-throw `Upstream model request
    // failed` straight at the user — the worst UX moment of the whole
    // turn. The outer catch now has a one-shot retry slot
    // (`textFallbackRetryUsed`) that re-enters streamAndAggregate on the
    // text channel after a 2.4s backoff. If the second outer attempt
    // ALSO fails, then we throw — at that point the model server is
    // genuinely down and a clean error is the right answer.
    //
    // This test verifies the "transient on text → recovered" payoff
    // case. The companion test below verifies sustained text failure
    // still throws.
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const { events, emit } = buildEmitRecorder();
    const calls: Array<{ messages: ToolLoopMessage[]; tools?: unknown }> = [];
    let textCallCount = 0;
    const chat: ChatFn = (messages, tools) => {
      calls.push({ messages: messages.map((m) => ({ ...m })), tools });
      return (async function* () {
        if (tools) {
          throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
        }
        textCallCount += 1;
        // First THREE text calls throw → inner retry layer exhausts
        // (initial + MAX_TRANSIENT_RETRIES = 3), streamAndAggregate
        // throws, OUTER catches and the new textFallbackRetryUsed slot
        // fires its one shot with backoff. The 4th text call (entered
        // via the outer retry) succeeds and emits the tool_call.
        if (textCallCount <= 3) {
          throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed (text channel transient)."}');
        }
        if (textCallCount === 4) {
          yield '<tool_call>{"name":"read_file","params":{"path":"src/app.ts"}}</tool_call>';
          return;
        }
        yield 'Done after text recovery.';
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxIterations: 3,
      nativeTools: true
    });

    const result = await loop.run('read the app file', chat, 'base system prompt');

    expect(result.finalResponse).toContain('Done after text recovery.');
    expect(captured.paths).toEqual(['src/app.ts']);
    expect(events.filter((e) => e.type === 'tool_loop:native_tool_fallback').length).toBe(1);
    // The new outer-layer retry slot fires exactly once.
    expect(events.filter((e) => e.type === 'tool_loop:text_fallback_retry').length).toBe(1);
  });

  it('throws terminally when both native AND text channels exhaust their retries', { timeout: 30_000 }, async () => {
    // Companion to the test above: if the text channel ALSO sustains
    // failures after the outer retry slot is spent, we throw cleanly.
    // textFallbackRetryUsed is a one-shot — no infinite-retry risk.
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    const { events, emit } = buildEmitRecorder();
    let calls = 0;
    const chat: ChatFn = (_messages, _tools) => {
      calls += 1;
      return (async function* () {
        throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxIterations: 3,
      nativeTools: true
    });

    await expect(loop.run('read the app file', chat, 'base system prompt')).rejects.toThrow(/500 Internal Server Error/);
    // v1.7.346: a fourth retry layer fires after textFallbackRetryUsed
    // exhausts — the final-anchor re-prompt with a clean restatement of
    // the original user goal. Full ladder per channel-cycle is:
    //   Native:                      initial + 2 inner = 3
    //   → channel switch to text
    //   Text (first outer attempt):  initial + 2 inner = 3
    //   → outer text-fallback retry slot
    //   Text (second outer attempt): initial + 2 inner = 3
    //   → final-anchor re-prompt slot
    //   Text (final-anchor attempt): initial + 2 inner = 3
    //   → terminal throw
    // Total: 3 + 3 + 3 + 3 = 12 chat() invocations.
    expect(calls).toBe(12);
    expect(events.filter((e) => e.type === 'tool_loop:native_tool_fallback').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool_loop:text_fallback_retry').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool_loop:final_anchor_retry').length).toBe(1);
  });

  it('final-anchor re-prompt recovers after all other retry slots fail (the worst-case-but-not-dead path)', { timeout: 45_000 }, async () => {
    // The recovery payoff for the v1.7.346 final-anchor slot. Native
    // channel fails sustained, text channel's inner+outer retry slots
    // also fail, and just before the terminal throw the loop pushes a
    // fresh re-anchor of the originalGoal. The model now has a clean
    // recovery signal: a new user message saying "previous attempts
    // failed — here's the original goal restated." The 7th text-channel
    // chat call (the first under the final-anchor) succeeds and emits
    // the tool_call. The user sees a long wait but a working outcome
    // instead of `Upstream model request failed`.
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    const { events, emit } = buildEmitRecorder();
    const calls: Array<{ messages: ToolLoopMessage[]; tools?: unknown }> = [];
    let textCallCount = 0;
    const chat: ChatFn = (messages, tools) => {
      calls.push({ messages: messages.map((m) => ({ ...m })), tools });
      return (async function* () {
        if (tools) {
          throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
        }
        textCallCount += 1;
        // First SIX text calls throw — exhausts both the initial inner
        // retry run (3) and the outer text-fallback-retry run (3). The
        // 7th call is the first attempt under the final-anchor re-prompt
        // and we let it succeed, emitting the tool_call.
        if (textCallCount <= 6) {
          throw new Error('Bandit request failed: 500 Internal Server Error - {"error":"Upstream model request failed."}');
        }
        if (textCallCount === 7) {
          yield '<tool_call>{"name":"read_file","params":{"path":"src/app.ts"}}</tool_call>';
          return;
        }
        yield 'Done after final-anchor recovery.';
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      maxIterations: 3,
      nativeTools: true
    });

    const result = await loop.run('read the app file', chat, 'base system prompt');

    expect(result.finalResponse).toContain('Done after final-anchor recovery.');
    expect(captured.paths).toEqual(['src/app.ts']);
    expect(events.filter((e) => e.type === 'tool_loop:native_tool_fallback').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool_loop:text_fallback_retry').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool_loop:final_anchor_retry').length).toBe(1);
    // The re-anchor pushes a fresh user message; the 7th chat call (the
    // recovery attempt) must carry it as a user-channel message.
    const finalAnchorCall = calls.find(
      (c) =>
        c.tools === undefined &&
        c.messages.some(
          (m) => m.role === 'user' && m.content.includes('Recovery attempt') && m.content.includes('Original user goal restated')
        )
    );
    expect(finalAnchorCall).toBeDefined();
  });

  it('retries watchdog stalls when the text-tool transport produced no tokens', async () => {
    const registry = new ToolRegistry();
    const { events, emit } = buildEmitRecorder();
    let calls = 0;
    const chat: ChatFn = () => {
      calls += 1;
      return (async function* () {
        if (calls === 1) {
          const err = new Error('The model server did not respond within 120s.') as Error & { code?: string };
          err.code = 'WATCHDOG';
          throw err;
        }
        yield 'Recovered after retry.';
      })();
    };
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit });

    const result = await loop.run('answer me', chat, 'base system prompt');

    expect(result.finalResponse).toContain('Recovered after retry.');
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'tool_loop:llm_retry')).toBe(true);
  });

  it('default (no nativeTools) injects XML tool block and passes no tools arg', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    const { chat, recorder } = buildMockChat(() => 'No tool needed.');
    const loop = new ToolUseLoop(registry, testCtx, {});

    await loop.run('answer me', chat, 'You are a test agent.');
    const firstCall = recorder.calls[0];
    expect(firstCall.tools).toBeUndefined();
    const systemMsg = firstCall.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toMatch(/<tool/);
    // Make sure the user prompt still leads — the loop appends the
    // toolBlock, doesn't replace.
    expect(systemMsg?.content?.startsWith('You are a test agent.')).toBe(true);
  });

  it('honors messageTokenBudget (compaction fires when budget is tiny)', async () => {
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool({ paths: [] }));
    // Ten-iteration build-up with one tool call per iter keeps adding
    // tool-result messages that compaction should eventually collapse.
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn < 6) {
        return `<tool_call>{"name":"read_file","params":{"path":"f${turn}.ts"}}</tool_call>`;
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, {
      emitEvent: emit,
      messageTokenBudget: 50, // tiny — almost any history exceeds it
      maxIterations: 8
    });

    await loop.run('read all', chat);
    const compactionFired = events.some((e) =>
      e.type === 'tool_loop:compacted' ||
      e.type === 'tool_loop:goal_anchor'
    );
    expect(compactionFired).toBe(true);
  });
});

/**
 * Compile-time exhaustiveness reminder. If you add a field to
 * ToolUseLoopOptions, this object literal won't typecheck — TS will
 * complain about either the missing key (good — add a test) or the
 * extra key (good — remove the stale entry).
 *
 * The `outputBudgetRatio` doesn't get its own test because it only
 * matters relative to outputBudgetTokens; the batch-serialization
 * test exercises both together.
 */
const _coveredFields: Record<keyof ToolUseLoopOptions, true> = {
  maxIterations: true,
  emitEvent: true,
  beforeToolExecute: true,
  signal: true,
  maxParallelTools: true,
  maxTotalTools: true,
  outputBudgetTokens: true,
  outputBudgetRatio: true,
  isSubagent: true,
  nativeTools: true,
  nativeToolFailureFallback: true,
  messageTokenBudget: true
};
void _coveredFields;
