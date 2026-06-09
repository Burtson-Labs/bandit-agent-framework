/**
 * Golden-path contract tests for `ToolUseLoop.runWithMessages` — the
 * 2,250-LOC orchestrator that every host (CLI, extension, future MCP
 * server) drives through. Stood up as the safety net before any
 * extraction touches the loop body in Arc 3.
 *
 * These tests intentionally do NOT duplicate coverage that already
 * lives elsewhere:
 *
 *  - **maxIterations / hitLimit on iter cap**: see
 *    `constructorOptionsContract.test.ts > honors maxIterations`.
 *  - **beforeToolExecute deny**: see
 *    `constructorOptionsContract.test.ts > honors beforeToolExecute`.
 *  - **maxParallelTools**: see
 *    `constructorOptionsContract.test.ts > honors maxParallelTools`.
 *  - **maxTotalTools, outputBudgetTokens, isSubagent, native↔text
 *    channel failover, watchdog retries, final-anchor reprompt**: see
 *    the rest of `constructorOptionsContract.test.ts`.
 *  - **User-abort across pre/mid/post stages**: see
 *    `cancellationContract.test.ts`.
 *  - **Compaction + goal anchor**: see `compactionContract.test.ts`.
 *  - **Noticing-prompt detector + emit**: see
 *    `noticingPromptDetector.test.ts`.
 *
 * What lands here are the load-bearing behaviors NOT yet pinned:
 *
 *  1. Single-iteration happy path — prose-only response closes the loop
 *     after one chat call with the canonical result shape.
 *  2. Multi-iteration event sequence — tool_call → tool_execute →
 *     tool_result fire in order across multiple iterations, with the
 *     tool result reaching the next chat call.
 *  3. `drainExternalMessages` injection — host-supplied messages land in
 *     the conversation before the next chat() and the model sees them.
 *  4. `isContinuationPrompt` classifier — pinned at the unit level
 *     (the function is exported but had zero direct test coverage).
 *  5. Non-retryable LLM error bubbles — the loop does not swallow a
 *     non-retryable error (429, USER_ABORT) into a `hitLimit` shape.
 *
 * A break here signals the loop's contract has drifted, not that the
 * test is wrong — diff against the orchestrator body before "fixing".
 */
import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  ToolUseLoop,
  isContinuationPrompt
} from '../src/index';
import type { ToolLoopMessage } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildReadFileTool,
  buildNoopTool,
  buildEmitRecorder
} from './_helpers';

describe('runWithMessages — single-iteration happy path', () => {
  it('closes the loop after one chat call when the response is prose-only', async () => {
    const registry = new ToolRegistry();
    const { chat, recorder } = buildMockChat(() => 'Here is the answer. Done.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit });

    const result = await loop.run('what is 2 + 2?', chat);

    expect(recorder.callCount).toBe(1);
    // `iterations` is incremented per tool-call round, not per chat call —
    // a prose-only response exits the loop before that counter advances,
    // so the canonical "happy path" result is iterations === 0. Pinning
    // here so a future change to the counter semantics is caught.
    expect(result.iterations).toBe(0);
    expect(result.hitLimit).toBe(false);
    expect(result.cancelled).toBeUndefined();
    expect(result.finalResponse).toContain('Here is the answer');
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_loop:llm_start');
    expect(types).toContain('tool_loop:llm_response');
  });

  it('does NOT emit any tool-execution events on a prose-only response', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => 'pure prose, no tools.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit });

    await loop.run('hello', chat);
    const types = events.map((e) => e.type);
    expect(types).not.toContain('tool_loop:tool_execute');
    expect(types).not.toContain('tool_loop:tool_result');
  });
});

describe('runWithMessages — multi-iteration event sequence', () => {
  it('fires tool_execute then tool_result in order, with the result reaching the next chat call', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured, (p) => `contents-of-${p}`));
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      if (turn === 2) return '<tool_call>{"name":"read_file","params":{"path":"b.ts"}}</tool_call>';
      return 'Read both files. Final answer.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit });

    const result = await loop.run('read a.ts then b.ts', chat);

    // Both tools executed in order.
    expect(captured.paths).toEqual(['a.ts', 'b.ts']);
    // Three chat calls (turn 1 + turn 2 emitted tool calls, turn 3 was
    // the final prose). `iterations` counts tool-call rounds: 2.
    expect(recorder.callCount).toBe(3);
    expect(result.iterations).toBe(2);
    expect(result.hitLimit).toBe(false);
    expect(result.finalResponse).toContain('Final answer');

    // Event ordering — each iteration's tool_execute precedes its
    // tool_result, and both pairs precede the next iteration's
    // llm_start. The orchestrator's invariant.
    const sequence = events
      .map((e) => e.type)
      .filter((t) =>
        t === 'tool_loop:llm_start' ||
        t === 'tool_loop:tool_execute' ||
        t === 'tool_loop:tool_result'
      );
    // Expected: llm_start, tool_execute, tool_result, llm_start, tool_execute, tool_result, llm_start
    const llmStarts = sequence.filter((t) => t === 'tool_loop:llm_start').length;
    const executes = sequence.filter((t) => t === 'tool_loop:tool_execute').length;
    const results = sequence.filter((t) => t === 'tool_loop:tool_result').length;
    expect(llmStarts).toBe(3);
    expect(executes).toBe(2);
    expect(results).toBe(2);

    // Every tool_execute is immediately followed by its tool_result.
    for (let i = 0; i < sequence.length - 1; i++) {
      if (sequence[i] === 'tool_loop:tool_execute') {
        expect(sequence[i + 1]).toBe('tool_loop:tool_result');
      }
    }

    // Second chat call must have seen the first tool's result in its
    // message log — otherwise the model wouldn't know what happened.
    const secondCall = recorder.calls[1];
    const flat = secondCall.messages.map((m) => m.content).join('\n');
    expect(flat).toContain('contents-of-a.ts');
  });
});

describe('runWithMessages — drainExternalMessages injection', () => {
  it('appends host-supplied messages so a later iteration sees the injection', async () => {
    const registry = new ToolRegistry();
    registry.register(buildNoopTool('noop'));
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"name":"noop","params":{}}</tool_call>';
      return 'Saw the external note. Done.';
    });

    let drained = 0;
    const drainExternalMessages = (): ToolLoopMessage[] | undefined => {
      drained += 1;
      // Inject on the SECOND drain only — between iter 1 and iter 2.
      if (drained === 2) {
        return [{ role: 'user', content: 'SENTINEL_EXTERNAL_NOTE' }];
      }
      return undefined;
    };

    const loop = new ToolUseLoop(registry, testCtx, { drainExternalMessages });
    const result = await loop.run('do noop then report', chat);

    expect(result.finalResponse).toContain('Done');
    expect(drained).toBeGreaterThanOrEqual(2);
    // The recorder stores a *reference* to the messages array, which
    // the loop mutates across iterations — so `calls[i].messages` ends
    // up identical and reflects the final state. We can still verify
    // the injection landed: it must appear in SOME chat call's
    // accumulated history (the message log the model saw).
    const sawSentinel = recorder.calls.some((call) =>
      call.messages.some((m) => m.content.includes('SENTINEL_EXTERNAL_NOTE'))
    );
    expect(sawSentinel).toBe(true);
  });

  it('tolerates undefined / empty return without crashing', async () => {
    const registry = new ToolRegistry();
    const { chat, recorder } = buildMockChat(() => 'just prose.');
    const loop = new ToolUseLoop(registry, testCtx, {
      drainExternalMessages: () => undefined
    });
    const result = await loop.run('hi', chat);
    expect(result.cancelled).toBeUndefined();
    expect(recorder.callCount).toBe(1);

    const { chat: chat2, recorder: recorder2 } = buildMockChat(() => 'just prose.');
    const loop2 = new ToolUseLoop(registry, testCtx, {
      drainExternalMessages: () => []
    });
    const result2 = await loop2.run('hi', chat2);
    expect(result2.cancelled).toBeUndefined();
    expect(recorder2.callCount).toBe(1);
  });
});

describe('isContinuationPrompt classifier', () => {
  it('matches canonical continuation phrasings', () => {
    // The classifier's accept set is a closed phrase list — see
    // CONTINUATION_PROMPT_PHRASES in tool-use-loop.ts. These are the
    // user-visible forms it explicitly recognizes.
    expect(isContinuationPrompt('keep going')).toBe(true);
    expect(isContinuationPrompt('continue')).toBe(true);
    expect(isContinuationPrompt('keep going please')).toBe(true);
    expect(isContinuationPrompt('go on')).toBe(true);
    expect(isContinuationPrompt('proceed')).toBe(true);
    expect(isContinuationPrompt('next')).toBe(true);
    expect(isContinuationPrompt('finish')).toBe(true);
    expect(isContinuationPrompt('wrap up')).toBe(true);
  });

  it('does NOT match phrasings outside the accept set even if intuitive (regression guard)', () => {
    // These plausible-sounding continuations are NOT in the accept set
    // — pinning so a future expansion is deliberate, not accidental.
    expect(isContinuationPrompt('go ahead')).toBe(false);
    expect(isContinuationPrompt('keep at it')).toBe(false);
    expect(isContinuationPrompt('plow through')).toBe(false);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isContinuationPrompt('  CONTINUE  ')).toBe(true);
    expect(isContinuationPrompt('Keep Going')).toBe(true);
  });

  it('does NOT match fresh feature requests or substantive prompts', () => {
    expect(isContinuationPrompt('add a new component for X')).toBe(false);
    expect(isContinuationPrompt('refactor the auth module')).toBe(false);
    expect(isContinuationPrompt('what does this function do?')).toBe(false);
  });

  it('does NOT match the empty string', () => {
    expect(isContinuationPrompt('')).toBe(false);
    expect(isContinuationPrompt('   ')).toBe(false);
  });
});

describe('runWithMessages — non-retryable errors bubble', () => {
  it('throws a 429 / rate-limit error without converting it to hitLimit or cancelled', async () => {
    const registry = new ToolRegistry();
    // Chat throws a 429 — the loop's isRetryableLlmError returns
    // false for /\b429\b/, so the error must propagate to the caller.
    const chat = async function* (): AsyncGenerator<string> {
      const err = new Error('Upstream returned 429 Too Many Requests') as Error & { code?: string };
      // No yields before throw — simulating a transport-layer reject.
      throw err;
      yield ''; // unreachable; keeps TS happy about the AsyncGenerator return type
    };

    const loop = new ToolUseLoop(registry, testCtx, {});
    await expect(loop.run('hi', chat)).rejects.toThrow(/429/);
  });

  it('throws USER_ABORT-coded errors verbatim (not retried, not swallowed)', async () => {
    const registry = new ToolRegistry();
    const chat = async function* (): AsyncGenerator<string> {
      const err = new Error('aborted by user') as Error & { code?: string };
      err.code = 'USER_ABORT';
      throw err;
      yield '';
    };
    const loop = new ToolUseLoop(registry, testCtx, {});
    // USER_ABORT can either bubble OR resolve as cancelled depending
    // on whether the loop's signal also fired. Without a signal, the
    // error propagates. Pinning either-shape would over-specify; we
    // assert it does NOT silently succeed (the regression we're
    // guarding against is "error eaten, finalResponse empty, no flag
    // set").
    let threw = false;
    let result: Awaited<ReturnType<typeof loop.run>> | undefined;
    try {
      result = await loop.run('hi', chat);
    } catch {
      threw = true;
    }
    if (!threw) {
      // If it didn't throw, the only acceptable shape is cancelled.
      expect(result?.cancelled).toBe(true);
    } else {
      expect(threw).toBe(true);
    }
  });
});
