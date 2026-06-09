/**
 * Detector contracts: the "structured output instead of tool call" cluster.
 *
 *   - tool_loop:code_fence_nudge — model emits a substantial fenced
 *     code block (8+ non-empty lines) instead of calling apply_edit /
 *     write_file. Only fires when the user goal implies an edit.
 *   - tool_loop:json_todo_auto_promoted — model pastes a fenced
 *     ```json todo list instead of calling todo_write. The loop
 *     synthesizes a real todo_write call from the parsed JSON.
 *
 * Both detectors are one-shot per turn (model gets one chance to
 * stop pasting before the loop pivots). Tests verify the firing
 * conditions, the precondition gates that prevent false positives,
 * and (for the JSON case) that the synthesized tool call actually
 * executes.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolResult } from '../src/index';
import {
  testCtx,
  buildMockChat,
  buildEmitRecorder
} from './_helpers';

/** Minimal write_file used to verify code-fence detector preconditions. */
function buildWriteFileTool(captured: { writes: number }): AgentTool {
  return {
    name: 'write_file',
    description: 'Write a file.',
    parameters: [
      { name: 'path', description: 'Target path.', required: true },
      { name: 'content', description: 'Full file content.', required: true }
    ],
    async execute(): Promise<ToolResult> {
      captured.writes += 1;
      return { output: 'wrote ok' };
    }
  };
}

/** Minimal todo_write that records the items it received. */
function buildTodoWriteTool(captured: { items: unknown[][] }): AgentTool {
  return {
    name: 'todo_write',
    description: 'Write the agent todo list.',
    parameters: [{ name: 'items', description: 'JSON array of items.', required: true }],
    async execute(params: Record<string, string>): Promise<ToolResult> {
      try {
        const parsed = JSON.parse(params.items ?? '[]');
        captured.items.push(parsed);
      } catch {
        // ignore
      }
      return { output: 'todo list updated' };
    }
  };
}

const TWELVE_LINE_FENCE = [
  '```ts',
  'export function calcTotal(items: Item[]): number {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    if (item.included) {',
  '      sum += item.price;',
  '    }',
  '  }',
  '  if (sum < 0) sum = 0;',
  '  return sum;',
  '}',
  '```'
].join('\n');

describe('code-fence detector (tool_loop:code_fence_nudge)', () => {
  it('fires when model returns a substantial code fence with no edit and the goal implies a file change', async () => {
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool({ writes: 0 }));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Hands back code instead of calling write_file.
        return `Here is the helper. Replace your current logic with this:\n\n${TWELVE_LINE_FENCE}`;
      }
      return 'OK, calling the tool now.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    // Goal contains an edit verb ("update") so promptImpliesFileEdit is true.
    await loop.run('update the score calculation', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:code_fence_nudge');
    expect(fires.length).toBe(1);
  });

  it('does NOT fire when the goal does not imply a file edit', async () => {
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool({ writes: 0 }));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return `Here is the helper:\n\n${TWELVE_LINE_FENCE}`;
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    // Pure analysis goal — no edit verb, no file extension. The same
    // big fenced response should NOT trip the detector.
    await loop.run('explain how scoring works', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:code_fence_nudge');
    expect(fires.length).toBe(0);
  });

  it('does NOT fire when an edit tool successfully ran first', async () => {
    const captured = { writes: 0 };
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return '<tool_call>{"name":"write_file","params":{"path":"a.ts","content":"x"}}</tool_call>';
      }
      if (turn === 2) {
        // Wrap-up includes a code fence after a real edit landed —
        // detector should stay silent.
        return `Done. For reference, here is what I wrote:\n\n${TWELVE_LINE_FENCE}`;
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('update the score calculation', chat);
    expect(captured.writes).toBe(1);
    const fires = events.filter((e) => e.type === 'tool_loop:code_fence_nudge');
    expect(fires.length).toBe(0);
  });

  it('does NOT fire on a small fenced block (under 8 non-empty lines)', async () => {
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool({ writes: 0 }));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          'Try this snippet:',
          '',
          '```ts',
          'const x = 1;',
          'const y = 2;',
          'console.log(x + y);',
          '```'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('update the helper', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:code_fence_nudge');
    expect(fires.length).toBe(0);
  });

  it('is one-shot per turn even when multiple matching responses arrive', async () => {
    const registry = new ToolRegistry();
    registry.register(buildWriteFileTool({ writes: 0 }));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 2) {
        return `Here it is:\n\n${TWELVE_LINE_FENCE}`;
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('refactor the score calculation', chat);
    const fires = events.filter((e) => e.type === 'tool_loop:code_fence_nudge');
    expect(fires.length).toBe(1);
  });
});

describe('JSON-todo auto-promote (tool_loop:json_todo_auto_promoted)', () => {
  it('promotes a pasted ```json todo array to a real todo_write call', async () => {
    const captured = { items: [] as unknown[][] };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          'Here is my plan:',
          '',
          '```json',
          '[',
          '  {"content":"Read package.json", "status":"pending"},',
          '  {"content":"Survey the entry points", "status":"pending"}',
          ']',
          '```'
        ].join('\n');
      }
      return 'Plan recorded. Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('plan the work', chat);
    const promoted = events.filter((e) => e.type === 'tool_loop:json_todo_auto_promoted');
    expect(promoted.length).toBe(1);
    expect((promoted[0].payload as { itemCount?: number }).itemCount).toBe(2);
    // The synthesized tool call should have actually executed.
    expect(captured.items.length).toBe(1);
    expect(captured.items[0]).toHaveLength(2);
  });

  it('does NOT promote a generic ```json block that is not a todo array', async () => {
    const captured = { items: [] as unknown[][] };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Object, not array. Detector should pass through.
        return [
          'Here is the schema:',
          '',
          '```json',
          '{ "name": "thing", "version": "1.0" }',
          '```'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('describe the schema', chat);
    const promoted = events.filter((e) => e.type === 'tool_loop:json_todo_auto_promoted');
    expect(promoted.length).toBe(0);
    expect(captured.items.length).toBe(0);
  });

  it('does NOT promote when the model emitted a real tool call alongside the JSON', async () => {
    const captured = { items: [] as unknown[][] };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        // Includes a real tool call — auto-promote should defer to it.
        return [
          'Here is my plan:',
          '',
          '```json',
          '[',
          '  {"content":"Step one", "status":"pending"}',
          ']',
          '```',
          '',
          '<tool_call>{"name":"todo_write","params":{"items":"[{\\"content\\":\\"Step one\\",\\"status\\":\\"pending\\"}]"}}</tool_call>'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('plan the work', chat);
    const promoted = events.filter((e) => e.type === 'tool_loop:json_todo_auto_promoted');
    expect(promoted.length).toBe(0);
    // The real tool call still executed — detector did not double-call.
    expect(captured.items.length).toBe(1);
  });

  it('is one-shot per turn (a second matching response does not refire)', async () => {
    const captured = { items: [] as unknown[][] };
    const registry = new ToolRegistry();
    registry.register(buildTodoWriteTool(captured));
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn <= 2) {
        return [
          'Plan:',
          '```json',
          '[{"content":"a","status":"pending"}]',
          '```'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    await loop.run('plan it', chat);
    const promoted = events.filter((e) => e.type === 'tool_loop:json_todo_auto_promoted');
    expect(promoted.length).toBe(1);
  });

  it('does NOT promote when no todo_write tool is registered', async () => {
    const registry = new ToolRegistry();
    // No todo_write registered.
    let turn = 0;
    const { chat } = buildMockChat(() => {
      turn += 1;
      if (turn === 1) {
        return [
          'Plan:',
          '```json',
          '[{"content":"a","status":"pending"}]',
          '```'
        ].join('\n');
      }
      return 'Done.';
    });
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 4 });

    // Detector still EMITS the auto_promoted event (the shape was
    // recognized) but cannot actually execute without the tool. We
    // pin both halves so a future regression that silently drops the
    // event when the tool is missing is caught.
    await loop.run('plan it', chat);
    const promoted = events.filter((e) => e.type === 'tool_loop:json_todo_auto_promoted');
    expect(promoted.length).toBe(1);
    const executed = events.filter(
      (e) =>
        e.type === 'tool_loop:tool_execute' &&
        (e.payload as { name?: string })?.name === 'todo_write'
    );
    expect(executed.length).toBe(0);
  });
});
