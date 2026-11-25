/**
 * MCP results are third-party output with no size bound of their own; the
 * adapter caps the text that reaches the model, like web_fetch (16 KB) and
 * commands (32 KB) do.
 */
import { describe, expect, it } from 'vitest';
import { MAX_MCP_RESULT_CHARS, renderMcpResult } from '../src/mcp/toolAdapter';

describe('renderMcpResult size cap', () => {
  it('passes results under the cap through unchanged', () => {
    const text = 'x'.repeat(MAX_MCP_RESULT_CHARS);
    expect(renderMcpResult({ content: [{ type: 'text', text }] }).output).toBe(text);
  });

  it('truncates an oversized result with a clear marker', () => {
    const text = 'a'.repeat(300 * 1024);
    const r = renderMcpResult({ content: [{ type: 'text', text }], _meta: { origin: 'https://mcp.example' } });
    expect(r.output.length).toBeLessThan(MAX_MCP_RESULT_CHARS + 300);
    expect(r.output.startsWith('a'.repeat(1000))).toBe(true);
    expect(r.output).toMatch(/\[MCP result truncated: showing the first 64 KB of 300 KB/);
    // Provenance survives truncation.
    expect(r.origin).toBe('https://mcp.example');
  });

  it('caps the joined text of many blocks, not each block', () => {
    const block = { type: 'text', text: 'b'.repeat(40 * 1024) };
    const r = renderMcpResult({ content: [block, block, block] });
    expect(r.output).toMatch(/MCP result truncated/);
    expect(r.output.length).toBeLessThan(MAX_MCP_RESULT_CHARS + 300);
  });
});
