import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/index';
import type { AgentTool } from '../src/index';

/**
 * Contract for buildCompactSystemPromptBlock — the small-tier text tool
 * block. Three invariants:
 *   1. Edit-critical tools keep full XML; everything else is one line.
 *   2. The `## How to Use Tools` protocol envelope is byte-identical to
 *      the full block (the loop's parsers and detectors key off it).
 *   3. The compact form is materially smaller — that's its entire job.
 */

function makeTool(name: string, description: string, params: AgentTool['parameters']): AgentTool {
  return {
    name,
    description,
    parameters: params,
    async execute() { return { ok: true, output: '' }; }
  } as unknown as AgentTool;
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeTool('read_file', 'Reads a file from disk. Supports offset and limit pagination.', [
    { name: 'path', description: 'File path', required: true },
    { name: 'offset', description: '1-based start line', required: false, schema: { type: 'integer' } }
  ] as AgentTool['parameters']));
  registry.register(makeTool('todo_write', 'Creates and updates the visible task list. Re-send the full list each call.', [
    { name: 'todos', description: 'The full todo list', required: true, schema: { type: 'array', items: { type: 'object' } } }
  ] as AgentTool['parameters']));
  registry.register(makeTool('web_search', 'Searches the web for current information. Returns result snippets with URLs.', [
    { name: 'query', description: 'Search query', required: true },
    { name: 'max_results', description: 'Cap on results', required: false, schema: { type: 'integer' } }
  ] as AgentTool['parameters']));
  return registry;
}

describe('buildCompactSystemPromptBlock', () => {
  it('keeps full XML for edit-critical tools and one line for the rest', () => {
    const registry = buildRegistry();
    const compact = registry.buildCompactSystemPromptBlock();
    // read_file is in the edit-critical set → full XML definition.
    expect(compact).toContain('<tool name="read_file">');
    // todo_write / web_search render as one-line signatures.
    expect(compact).not.toContain('<tool name="todo_write">');
    expect(compact).toMatch(/- todo_write\(todos:array\) — Creates and updates the visible task list\./);
    expect(compact).toMatch(/- web_search\(query, max_results\?:integer\) — Searches the web for current information\./);
  });

  it('protocol envelope is byte-identical between full and compact blocks', () => {
    const registry = buildRegistry();
    const envelope = (block: string) => block.slice(block.indexOf('## How to Use Tools'));
    expect(envelope(registry.buildCompactSystemPromptBlock()))
      .toBe(envelope(registry.buildSystemPromptBlock()));
  });

  it('is materially smaller than the full block on a realistic registry', () => {
    const registry = buildRegistry();
    // Pad with a dozen long-described non-critical tools to mimic the
    // real CLI registry shape (~32 tools, most of them long-tail).
    for (let i = 0; i < 12; i++) {
      registry.register(makeTool(`aux_tool_${i}`,
        'A long-tail host tool with a description that runs well past one sentence. It explains edge cases, retry semantics, and parameter interactions in considerable detail across several clauses.',
        [
          { name: 'input', description: 'Primary input', required: true },
          { name: 'options', description: 'Behavior flags', required: false, schema: { type: 'object', properties: { a: {}, b: {} } } }
        ] as AgentTool['parameters']));
    }
    const full = registry.buildSystemPromptBlock().length;
    const compact = registry.buildCompactSystemPromptBlock().length;
    expect(compact).toBeLessThan(full * 0.55);
  });

  it('returns empty string for an empty registry, like the full block', () => {
    const registry = new ToolRegistry();
    expect(registry.buildCompactSystemPromptBlock()).toBe('');
  });
});
