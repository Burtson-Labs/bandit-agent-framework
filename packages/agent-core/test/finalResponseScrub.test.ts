/**
 * Contract: the terminal finalResponse is answer-only.
 *
 * Reasoning channels (```bandit-reasoning fences, <think> blocks) are
 * streamed live by the host for display — leaving them in the returned
 * final answer double-renders them. Replays the 2026-06-12T20-19
 * Portfolio turn (gemma4:e4b): the model fabricated <tool_result>
 * envelopes through BOTH fabrication retries, and the accepted final
 * response carried three reasoning blocks of nudge-confusion narrative
 * ("the user is correcting my formatting error…") above the real
 * answer. After the scrub, hosts get only the prose answer.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import { testCtx, buildMockChat, buildEmitRecorder } from './_helpers';

const FABRICATING_RESPONSE =
  '\n```bandit-reasoning\nThe user is correcting my formatting error: I included a ' +
  '`<tool_result>` envelope in my last response. I will re-issue the final answer.\n```\n' +
  '<tool_result name="todo_write">{"ok":true}</tool_result>\n' +
  'This repo is a Vite + React portfolio site with source in src/.';

describe('final response scrub', () => {
  it('strips reasoning fences and fabricated envelopes from the accepted final answer', async () => {
    const registry = new ToolRegistry();
    // Same fabricating shape every time — burns both fabrication
    // retries, then the loop must accept and scrub.
    const { chat } = buildMockChat(() => FABRICATING_RESPONSE);
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 8 });

    const result = await loop.run('tell me about this repo', chat);

    expect(result.finalResponse).toContain('Vite + React portfolio');
    expect(result.finalResponse).not.toContain('bandit-reasoning');
    expect(result.finalResponse).not.toContain('<tool_result');
    expect(result.finalResponse).not.toContain('correcting my formatting error');
    // Both fabrication retries fired before acceptance.
    const fabricationRetries = events.filter((e) => e.type === 'tool_loop:fake_tool_result_detected');
    expect(fabricationRetries.length).toBe(2);
  });

  it('strips <think> blocks from the final answer too', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() =>
      '<think>plan: answer directly, no tools needed</think>The build uses Vite with TypeScript.');
    const { emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    const result = await loop.run('what build tool is used', chat);

    expect(result.finalResponse).toBe('The build uses Vite with TypeScript.');
  });
});
