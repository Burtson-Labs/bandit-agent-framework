/**
 * Detector contracts: the "model fabricates tool output" cluster.
 *
 * - tool_loop:fake_tool_result_detected — fires when the model
 * emits a `<tool_result>` envelope mid-iteration (it should
 * never — those envelopes are system output between turns).
 * Capped at FAKE_TOOL_RESULT_CAP=2. The loop scrubs the response,
 * pushes a corrective nudge, and retries.
 * - tool_loop:hallucinated_tool_result — fires at the END of a
 * no-tool-calls iteration when the final response still contains
 * `<tool_result>` markup (typically because the cap on the
 * fake-tool-result detector has been exhausted). Telemetry only;
 * the markup is stripped from the user-visible answer regardless.
 *
 * The two detectors form a sequence: fake-tool-result fires first
 * (and retries), and only after its cap is exhausted does the
 * hallucinated-tool-result telemetry fire as the loop terminates.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder
} from './_helpers';

describe('fake-tool-result detector (tool_loop:fake_tool_result_detected)', () => {
  it('fires when the model emits a <tool_result> envelope', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          'I checked the file and here is what it contains:',
          '<tool_result name="read_file">',
          '  fake content here',
          '</tool_result>',
          'That confirms the implementation.'
        ].join('\n');
      }
      return 'OK, real prose answer this time.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('check the file', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fires.length).toBe(1);
  });

  it('scrubs the envelope before showing the assistant message back to the model', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat, recorder } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return 'Result: <tool_result name="read_file">fake</tool_result> done.';
      }
      return 'OK.';
    });
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('check', chat);
    // Look at the messages the loop sends back on the retry call.
    // The previously-pushed assistant message should have the
    // fabricated envelope scrubbed so the model doesn't see its own
    // hallucination in the next turn's context.
    const retryMessages = recorder.calls[1].messages;
    const lastAssistant = [...retryMessages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant?.content ?? '').not.toMatch(/<tool_result/);
  });

  it('caps at FAKE_TOOL_RESULT_CAP (2)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // Keep returning fabricated envelopes — the cap should hold
      // detector fires at exactly 2 even though the model never
      // recovers. After the cap, the loop pivots to the
      // hallucinated_tool_result telemetry at termination time.
      if (turn <= 5) {
        return '<tool_result name="x">fabricated</tool_result>';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do the thing', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fires.length).toBe(2);
  });

  it('also fires on truncated <tool_result envelope (no closing tag)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      // The FAKE_TOOL_RESULT_RE regex has a fallback for truncated
      // envelopes: `<tool_result\b[^<]*$` matches the start of an
      // envelope at end-of-string with no closing tag. Mid-stream
      // aborts can leave the model emitting the opener and then
      // stopping before the closer.
      if (turn === 1) return 'Here is the result: <tool_result name="read_file"';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('read', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fires.length).toBe(1);
  });

  it('does NOT fire on normal prose with no <tool_result> markup', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) return 'The file looks fine. No issues found.';
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('check', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fires.length).toBe(0);
  });
});

describe('hallucinated-tool-result telemetry (tool_loop:hallucinated_tool_result)', () => {
  it('fires after the fake-tool-result cap is exhausted and the markup persists into the final response', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => {
      // Always returns fabricated markup. After the cap exhausts,
      // the loop falls through to the no-tool-calls branch where
      // hasFabricatedToolResult triggers the telemetry event.
      return '<tool_result name="x">fake</tool_result> Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('do it', chat);
    const fakes = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    const hallucinated = events.filter((e) => e.type === 'tool_loop:hallucinated_tool_result');
    expect(fakes.length).toBe(2); // cap exhausted
    expect(hallucinated.length).toBe(1);
  });

  it('strips the fabricated envelope from the final response that reaches the user', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => {
      return 'Result: <tool_result name="x">secret fake content</tool_result> Done.';
    });
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    const result = await loop.run('do it', chat);
    expect(result.finalResponse).not.toMatch(/<tool_result/);
    expect(result.finalResponse).not.toMatch(/secret fake content/);
  });

  it('does NOT fire on a clean final response with no fabricated markup', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => 'Plain answer with no fake markup.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('check', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:hallucinated_tool_result');
    expect(fires.length).toBe(0);
  });
});

// new detector branch for the bandit-tl / bandit-run /
// bandit-subagent fenced-JSON hallucination Gemma 4 was caught doing
// on 2026-05-12 turns (mks3, pnf1, d88r). The host emits these fences
// to log REAL tool execution in the chat UI; the model learned the
// shape from conversation history and was emitting them in prose to
// fake having edited code. `<tool_result>` regex didn't match this
// shape — needed its own arm.
describe('fake-tool-result detector — bandit-tl fenced-JSON shape', () => {
  it('fires when the response emits a ```bandit-tl fence in prose with no real <tool_call>', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          '```bandit-tl',
          '{"id":"apply_patch-mp21p86a-x1y2","name":"apply_patch","status":"done","durationMs":12}',
          '```',
          'I have upgraded the registry.'
        ].join('\n');
      }
      return 'Acknowledged. I will use a real tool call next time.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    const result = await loop.run('fix the registry', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fires.length).toBeGreaterThan(0);
    expect((fires[0].payload as { shape?: string }).shape).toBe('bandit-tl');
    // Final response (after retry) doesn't carry the hallucinated fence.
    expect(result.finalResponse).not.toContain('```bandit-tl');
  });

  it('also catches bandit-run and bandit-subagent fences (same family)', async () => {
    const registry = new ToolRegistry();
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '```bandit-run\n{"id":"x","status":"done"}\n```\nDone.';
      }
      if (turn === 2) {
        return '```bandit-subagent\n{"goal":"x","result":"y","iterations":1,"hitLimit":false,"tools":[],"isError":false}\n```\nAlso done.';
      }
      return 'OK, will not do that.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 5 });

    await loop.run('go', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fires.length).toBe(2);
  });

  it('does NOT fire when the response has a REAL <tool_call> alongside the fence (no false positive on legitimate retry)', async () => {
    // Edge case: a model could emit a bandit-tl card in prose AND a
    // real tool call. That's still a problem but the detector is
    // narrowly scoped to "fence present, no real tool call" so
    // legitimate tool-using responses aren't penalized. The fence
    // gets scrubbed elsewhere by the markdown sanitizer; here we just
    // verify the retry detector doesn't fire.
    const registry = new ToolRegistry();
    const recordingTool = {
      name: 'read_file',
      description: 'read',
      parameters: [{ name: 'path', description: 'p', required: true }],
      async execute() { return { output: 'contents' }; }
    };
    registry.register(recordingTool);
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '```bandit-tl\n{"id":"x","status":"done"}\n```\n<tool_call>{"name":"read_file","params":{"path":"a"}}</tool_call>';
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('go', chat);
    const banditFires = events.filter(
      (e) => e.type === 'tool_loop:fake_tool_result_detected' &&
      (e.payload as { shape?: string }).shape === 'bandit-tl'
    );
    expect(banditFires.length).toBe(0);
  });

  it('caps retries at FAKE_TOOL_RESULT_CAP (2) so a stubborn model can\'t loop forever', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => {
      // Always emit the fake card, never a real tool call.
      return '```bandit-tl\n{"id":"x","status":"done"}\n```\nI did the work.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    await loop.run('do it', chat);
    const fires = events.filter(
      (e) => e.type === 'tool_loop:fake_tool_result_detected' &&
      (e.payload as { shape?: string }).shape === 'bandit-tl'
    );
    expect(fires.length).toBe(2); // cap reached, loop gave up nudging
  });
});
