/**
 * ToolResult.images and ToolResult.origin through the loop.
 *
 * A screenshot tool returns the picture; the next chat call must carry it on
 * the results message (ToolLoopMessage.images) next to the envelope that
 * describes it, and the envelope must name the page's origin. Until these
 * fields existed a screenshot reached the model as a file path and page text
 * carried no provenance (ADR-004's two open gaps).
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, ToolUseLoop } from '../src/index';
import type { AgentTool, ToolLoopMessage } from '../src/index';
import { createToolDispatcher } from '../src/tools/loop/singleToolExecute';
import { buildEmitRecorder, buildMockChat, testCtx } from './_helpers';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function screenshotTool(): AgentTool {
  return {
    name: 'browser_screenshot',
    description: 'picture of the page',
    parameters: [],
    risk: { tier: 'routine', readOnly: true, why: 'Reads the page.' },
    async execute() {
      return { output: 'Screenshot of https://acme.example/ (800x600).', images: [PNG], origin: 'https://acme.example' };
    }
  };
}

const call = (name: string, params: Record<string, string> = {}): string =>
  `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;

describe('images and origin through the loop', () => {
  it('puts a result image on the results message and the origin on the envelope', async () => {
    const registry = new ToolRegistry();
    registry.register(screenshotTool());
    const { chat, recorder } = buildMockChat((turn) => (turn === 1 ? call('browser_screenshot') : 'The page shows a form.'));
    const { emit, events } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit });
    const result = await loop.run('what is on the page?', chat);

    expect(result.finalResponse).toContain('form');
    const secondCall = recorder.calls[1].messages as ToolLoopMessage[];
    const resultsMessage = secondCall.find((m) => m.role === 'user' && m.content.includes('<tool_result'));
    expect(resultsMessage).toBeDefined();
    expect(resultsMessage!.content).toContain('<tool_result name="browser_screenshot" origin="https://acme.example">');
    expect(resultsMessage!.images).toEqual([PNG]);

    // The event stream names the provenance and the attachment count, never the bytes.
    const resultEvent = events.find((e) => e.type === 'tool_loop:tool_result') as { payload?: Record<string, unknown> } | undefined;
    expect(resultEvent?.payload?.origin).toBe('https://acme.example');
    expect(resultEvent?.payload?.imageCount).toBe(1);
    expect(JSON.stringify(resultEvent?.payload ?? {})).not.toContain('iVBORw0KGgo');
  });

  it('leaves messages without images untouched (no empty images field)', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_thing',
      description: 'reads',
      parameters: [],
      async execute() {
        return { output: 'plain' };
      }
    });
    const { chat, recorder } = buildMockChat((turn) => (turn === 1 ? call('read_thing') : 'Done.'));
    const loop = new ToolUseLoop(registry, testCtx, {});
    await loop.run('read', chat);
    const resultsMessage = (recorder.calls[1].messages as ToolLoopMessage[]).find(
      (m) => m.role === 'user' && m.content.includes('<tool_result')
    );
    expect(resultsMessage).toBeDefined();
    expect('images' in resultsMessage!).toBe(false);
    expect(resultsMessage!.content).toContain('<tool_result name="read_thing">');
  });

  it('registry keeps the declared risk on the tool', () => {
    const registry = new ToolRegistry();
    registry.register(screenshotTool());
    expect(registry.get('browser_screenshot')?.risk).toEqual({ tier: 'routine', readOnly: true, why: 'Reads the page.' });
  });
});

describe('createToolDispatcher — passthrough', () => {
  it('carries images and origin from the tool result and omits them otherwise', async () => {
    const registry = new ToolRegistry();
    registry.register(screenshotTool());
    registry.register({
      name: 'plain',
      description: 'plain',
      parameters: [],
      async execute() {
        return { output: 'ok' };
      }
    });
    const { emit } = buildEmitRecorder();
    const dispatch = createToolDispatcher({
      registry,
      ctx: testCtx,
      beforeToolExecute: () => ({ allow: true }),
      emit,
      recentCallKeys: [],
      repeatLimit: 3,
      filesReadThisTurn: new Set(),
      filesWrittenThisTurn: new Set(),
      isFileEditTool: () => false,
      onEditToolSucceeded: () => undefined
    });
    const shot = await dispatch({ id: '1', name: 'browser_screenshot', params: {}, raw: '' } as never);
    expect(shot.images).toEqual([PNG]);
    expect(shot.origin).toBe('https://acme.example');
    const plain = await dispatch({ id: '2', name: 'plain', params: {}, raw: '' } as never);
    expect('images' in plain).toBe(false);
    expect('origin' in plain).toBe(false);
  });
});
