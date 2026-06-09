/**
 * Detector contracts: the "loop" cluster.
 *
 *   - tool_loop:prose_loop_nudge — fires when consecutive non-tool
 *     responses share >60% prefix (the model is repeating itself), OR
 *     when a single response self-contradicts ("Wait, I see X /
 *     Actually I'll try X" 3+ times each), OR when the streamer
 *     aborted mid-loop.
 *   - tool_loop:todo_churn_nudge — fires when the agent has emitted
 *     todo_write-only iterations 3+ consecutive times. Drops the
 *     redundant todo_write and tells the model to execute, not
 *     replan. Re-arms once a real tool call fires.
 *
 * Both are bounded one-shots that protect against pathological model
 * behavior. Tests pin the firing conditions, the precondition gates,
 * and the recovery behavior (window reset / nudge re-arm).
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildReadFileTool,
  buildEmitRecorder
} from './_helpers';

/** Minimal todo_write that records the items it received. */
function buildTodoWriteTool(captured: { calls: number }): AgentTool {
  return {
    name: 'todo_write',
    description: 'Write the agent todo list.',
    parameters: [{ name: 'items', description: 'JSON array.', required: true }],
    async execute(): Promise<ToolResult> {
      captured.calls += 1;
      return { output: 'todo updated' };
    }
  };
}

describe('prose-loop detector (tool_loop:prose_loop_nudge)', () => {
  // Crafting test inputs that reach the prose-loop check is harder
  // than it looks. The detector lives at line ~945 of the loop and
  // only fires when a no-tool-call iteration reaches it twice with
  // similar text. Several earlier detectors (shouldNudge for empty
  // / reasoning-only / narratedButNoAction) intercept and `continue`
  // before the push to recentNonToolResponses ever happens. So the
  // test inputs here are deliberately:
  //   - long enough (>240 chars) to skip narratedButNoAction's gate
  //   - short enough (<600 chars) to let announce-intent fire as the
  //     "earlier detector" that keeps the loop going for a second
  //     pass at iter 0
  //   - structured to start with "Let me explore" so announce-intent
  //     matches on iter 0's first pass; the SECOND pass through
  //     reaches prose-loop with the prior set
  const stuckProse =
    'Let me explore the package layout to understand the project organization. ' +
    'It might be a monorepo with apps and packages. There could be configuration ' +
    'files and lockfiles to inspect carefully. The codebase organization tells us ' +
    'a lot about how to navigate it.';

  it('fires on cross-iteration similarity (>60% prefix overlap)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Iter 0 first pass: announce-intent fires + continue.
      // Iter 0 second pass: prose-loop fires (prior matches).
      if (turn <= 2) return stuckProse;
      return 'OK, real answer.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('explore the repo', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:prose_loop_nudge');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { reason?: string }).reason).toBe('cross_iteration_similarity');
  });

  it('fires on self-contradicting "Wait... Actually..." pattern in one response', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 2) {
        // Long enough to skip narratedButNoAction (>240). Includes
        // both an announce-intent verb (so an earlier detector keeps
        // the loop going for a second pass) AND the wait/actually
        // pattern (which is what we're testing fires).
        return [
          'Let me explore the codebase carefully to understand it.',
          'Wait, I see config.ts is not listed in the directory output.',
          "Actually, I'll try checking package.json instead of guessing.",
          'Wait, I see the manifest seems to be missing from the listing too.',
          "Actually, I'll try inspecting the lockfile next as a fallback.",
          'Wait, I see the lockfile appears to be gone as well from this view.',
          "Actually, I'll try probing a different folder structure entirely."
        ].join(' ');
      }
      return 'OK.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('explore the project', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:prose_loop_nudge');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { reason?: string }).reason).toBe('self_contradict');
  });

  it('does NOT fire on a single iteration with prose (no prior to compare)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return stuckProse;
      return 'OK, switching tactic completely.'; // dissimilar response
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('explore the repo', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:prose_loop_nudge');
    expect(fires.length).toBe(0);
  });

  it('is one-per-turn — three matching responses fire only once', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 3) return stuckProse;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('explore', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:prose_loop_nudge');
    expect(fires.length).toBe(1);
  });
});

describe('todo-churn detector (tool_loop:todo_churn_nudge)', () => {
  const todoCall = '<tool_call>{"name":"todo_write","params":{"items":"[{\\"content\\":\\"step\\",\\"status\\":\\"pending\\"}]"}}</tool_call>';

  it('fires after 3 consecutive todo_write-only iterations', async () => {
    const captured = { calls: 0 };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // 4 todo_write-only iterations in a row — should trip the
      // breaker on the 3rd. The 4th wouldn't fire (already nudged)
      // but we don't reach it because the breaker drops the call
      // and injects a nudge.
      if (turn <= 4) return todoCall;
      return 'OK, done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('plan and execute', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:todo_churn_nudge');
    expect(fires.length).toBe(1);
    expect((fires[0].payload as { consecutive?: number }).consecutive).toBe(3);
  });

  it('does NOT fire under the 3-iteration threshold', async () => {
    const captured = { calls: 0 };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 2) return todoCall; // only 2, under TODO_ONLY_LIMIT (3)
      return 'OK, done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 6 });

    await loop.run('plan', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:todo_churn_nudge');
    expect(fires.length).toBe(0);
    // Both todo_writes ran for real.
    expect(captured.calls).toBe(2);
  });

  it('resets when a real (non-todo) tool call fires between todos', async () => {
    const todoCaptured = { calls: 0 };
    const readCaptured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(todoCaptured));
    registry.register(buildReadFileTool(readCaptured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return todoCall;
      if (turn === 2) return todoCall;
      if (turn === 3) return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      // After a real tool call the consecutive counter resets, so
      // the next two todos should NOT trip the breaker.
      if (turn === 4) return todoCall;
      if (turn === 5) return todoCall;
      return 'OK.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('plan and execute', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:todo_churn_nudge');
    expect(fires.length).toBe(0);
    expect(readCaptured.paths).toEqual(['a.ts']);
    // All four todo_writes ran (counter never reached the cap).
    expect(todoCaptured.calls).toBe(4);
  });

  it('drops the redundant todo_write on the firing iteration', async () => {
    const captured = { calls: 0 };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 4) return todoCall;
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('plan', chat);
    // The breaker fires ON the iteration where consecutive >= 3 —
    // BEFORE the synthesized todo_write would execute. So:
    //   iter 0: count=1, fires? no (1<3) → executes (calls=1)
    //   iter 1: count=2, fires? no (2<3) → executes (calls=2)
    //   iter 2: count=3, fires? YES (3>=3) → toolCalls=[], drops it
    // Only 2 todo_writes actually ran.
    expect(captured.calls).toBe(2);
  });
});

describe('no-tool-call hard cap (tool_loop:no_tool_call_hard_cap)', () => {
  // Mark Portfolio session 2026-05-26 turn-02-30-37: model emitted 6
  // sequential reasoning-only responses within iteration 4 before the
  // loop terminated with a useless final answer. Each individual
  // detector (empty_retry, narratedButNoAction, thinking_off_recovery)
  // had its own cap but they chained — thinking_off_recovery resets
  // consecutiveEmptyRetries=0, so the cycle could repeat. New
  // turn-level hard cap doesn't reset; once 4 no-tool-call attempts
  // pile up in one turn we force-terminate with a clear final answer
  // that names the stuck state.

  const reasoningOnlyResponse = '\n```bandit-reasoning\nThe patch format wasn\'t recognized. Let me use proper unified diff format.\n```\n';

  it('terminates after 4 consecutive reasoning-only responses with a clear final answer', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => reasoningOnlyResponse);
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 20 });

    const result = await loop.run('fix the typescript errors', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:no_tool_call_hard_cap');
    // Hard cap should have fired once.
    expect(fires.length).toBe(1);
    // Final answer names the stuck state, suggests recovery actions.
    expect(result.finalResponse).toMatch(/got stuck/);
    expect(result.finalResponse).toMatch(/Suggested next steps/);
    // Original goal echoed back so the user remembers what was asked.
    expect(result.finalResponse).toMatch(/fix the typescript errors/);
  });

  it('does NOT fire when the model emits a tool_call before the cap', async () => {
    const captured = { paths: [] as string[] };
    const registry = new ToolRegistry();
    registry.register(buildReadFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Two reasoning-only, then a real tool call, then a final answer.
      if (turn <= 2) return reasoningOnlyResponse;
      if (turn === 3) return '<tool_call>{"name":"read_file","params":{"path":"a.ts"}}</tool_call>';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 10 });

    await loop.run('read a file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:no_tool_call_hard_cap');
    expect(fires.length).toBe(0);
    expect(captured.paths).toEqual(['a.ts']);
  });
});
