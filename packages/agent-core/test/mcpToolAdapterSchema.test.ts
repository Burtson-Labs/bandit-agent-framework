/**
 * Contract: MCP tool inputSchema (JSON Schema) round-trips through
 * AgentToolParameter and back out to the provider's native-tools
 * schema with object/array shapes intact.
 *
 * Captured 2026-05-25 — every nested-param MCP tool (createFilter,
 * modifyMessageLabels, etc.) failed against Google because the
 * adapter flattened object/array params to opaque strings. The model
 * saw "type: string" everywhere, emitted strings, and Google rejected
 * them with "Expected object, received string." These tests pin the
 * fix so a future refactor of the adapter can't silently regress.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, mcpToolToAgentTool } from '../src/index';
import type { McpClientPool } from '../src/index';

// Stub pool — we don't actually invoke tools in these tests, we just
// translate MCP tool defs into AgentTools and inspect the resulting
// schemas. `callTool` would only run if execute() were called.
const stubPool = {
  callTool: async () => ({ content: [{ type: 'text', text: 'noop' }] }),
} as unknown as McpClientPool;

describe('MCP → AgentTool schema passthrough', () => {
  it('preserves object parameter shape (createFilter-style)', () => {
    const remote = {
      name: 'createFilter',
      description: 'Create a Gmail filter',
      inputSchema: {
        type: 'object',
        properties: {
          criteria: {
            type: 'object',
            description: 'Match conditions.',
            properties: {
              from: { type: 'string', description: 'Match messages from this sender.' },
              subject: { type: 'string', description: 'Match subject substring.' },
            },
          },
          action: {
            type: 'object',
            properties: {
              addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to add.' },
              removeLabelIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['criteria', 'action'],
      },
    };
    const tool = mcpToolToAgentTool('burtson-labs', remote, stubPool);
    const registry = new ToolRegistry();
    registry.register(tool);
    const schemas = registry.buildNativeToolsSchema();
    const params = schemas[0].function.parameters.properties;

    // Critical assertion: criteria must be type:"object" with properties,
    // NOT type:"string". This is the contract that was broken.
    expect((params.criteria as { type: string }).type).toBe('object');
    expect((params.criteria as { properties: Record<string, unknown> }).properties).toBeDefined();
    expect((params.criteria as { properties: Record<string, { type: string }> }).properties.from.type).toBe('string');

    // action must also be an object
    expect((params.action as { type: string }).type).toBe('object');

    // Nested arrays preserve their item type
    const action = params.action as { properties: Record<string, { type: string; items?: { type: string } }> };
    expect(action.properties.addLabelIds.type).toBe('array');
    expect(action.properties.addLabelIds.items?.type).toBe('string');
  });

  it('preserves array<string> parameter shape (modifyMessageLabels-style)', () => {
    const remote = {
      name: 'modifyMessageLabels',
      description: 'Apply / remove labels on a message',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Gmail message id.' },
          addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to add (e.g. ["IMPORTANT"]).' },
          removeLabelIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
    };
    const tool = mcpToolToAgentTool('burtson-labs', remote, stubPool);
    const registry = new ToolRegistry();
    registry.register(tool);
    const props = registry.buildNativeToolsSchema()[0].function.parameters.properties;

    expect((props.id as { type: string }).type).toBe('string');
    expect((props.addLabelIds as { type: string }).type).toBe('array');
    expect((props.addLabelIds as { items: { type: string } }).items.type).toBe('string');
  });

  it('falls back to type:"string" when the MCP tool declares no schema (legacy)', () => {
    const remote = {
      name: 'noSchemaTool',
      description: 'Old-style MCP tool without inputSchema',
      // inputSchema deliberately omitted
    };
    const tool = mcpToolToAgentTool('burtson-labs', remote, stubPool);
    // Tool with no params at all → parameters array is empty
    expect(tool.parameters.length).toBe(0);
  });

  it('stringified-object params get re-parsed to objects before execute()', async () => {
    // Captured 2026-05-25 — the original regex `\[|\{` only matched
    // the literal single character, not full JSON. So createFilter
    // received the raw string `'{"from":"npm"}'` and the MCP server
    // rejected with "Expected object, received string" even though
    // both the schema and the model were doing the right thing.
    let capturedArgs: Record<string, unknown> = {};
    const recordingPool = {
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    } as unknown as McpClientPool;

    const remote = {
      name: 'createFilter',
      inputSchema: {
        type: 'object',
        properties: {
          criteria: { type: 'object', properties: { from: { type: 'string' } } },
          action: { type: 'object', properties: { addLabelIds: { type: 'array', items: { type: 'string' } } } },
          someNumber: { type: 'number' },
          someBool: { type: 'boolean' },
        },
        required: ['criteria', 'action'],
      },
    };
    const tool = mcpToolToAgentTool('burtson-labs', remote, recordingPool);

    // The loop hands us stringified versions (matches what tool-use-parser
    // produces for nested values). Verify they get re-parsed back.
    await tool.execute({
      criteria: '{"from":"npm"}',
      action: '{"addLabelIds":["IMPORTANT","Newsletters"]}',
      someNumber: '42',
      someBool: 'true',
    } as Record<string, string>, {} as never);

    expect(capturedArgs.criteria).toEqual({ from: 'npm' });
    expect(capturedArgs.action).toEqual({ addLabelIds: ['IMPORTANT', 'Newsletters'] });
    expect(capturedArgs.someNumber).toBe(42);
    expect(capturedArgs.someBool).toBe(true);
  });

  it('XML prompt block surfaces "(object — pass JSON like …)" hint for object params', () => {
    const remote = {
      name: 'createFilter',
      description: 'Create a Gmail filter',
      inputSchema: {
        type: 'object',
        properties: {
          criteria: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
          },
        },
        required: ['criteria'],
      },
    };
    const tool = mcpToolToAgentTool('burtson-labs', remote, stubPool);
    const registry = new ToolRegistry();
    registry.register(tool);
    const block = registry.buildSystemPromptBlock();
    // The non-native (XML) prompt block must tell the model to emit
    // a JSON object — without this hint the model emits a string and
    // the MCP server rejects it.
    expect(block).toMatch(/object — pass JSON/);
    expect(block).toMatch(/from/);
  });
});
