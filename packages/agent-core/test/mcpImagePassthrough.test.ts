/**
 * MCP image passthrough and declared risk on both sides of the bridge.
 *
 * Client side (toolAdapter): an `image` content block becomes
 * ToolResult.images plus a one-line marker, `_meta.origin` becomes
 * ToolResult.origin, and a server's annotations can only RAISE the declared
 * risk. Server side (serveBanditMcp's helpers): a ToolResult's images go out
 * as image blocks and its origin as `_meta.origin`, so a Bandit on the other
 * end of `bandit chrome mcp` rebuilds the same result.
 */
import { describe, expect, it } from 'vitest';
import { mcpToolToAgentTool, renderMcpResult, riskFromAnnotations } from '../src/mcp/toolAdapter';
import { annotationsFromRisk, mcpResultFromToolResult } from '../src/mcp/server';
import type { McpClientPool } from '../src/mcp/clientPool';
import { testCtx } from './_helpers';

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('renderMcpResult', () => {
  it('turns image blocks into images and keeps a marker in the text', () => {
    const out = renderMcpResult({
      content: [
        { type: 'text', text: 'Screenshot of the page' },
        { type: 'image', data: B64, mimeType: 'image/png' }
      ]
    });
    expect(out.images).toEqual([`data:image/png;base64,${B64}`]);
    expect(out.output).toContain('Screenshot of the page');
    expect(out.output).toMatch(/\[image attached: image\/png, about \d+ KB\]/);
    expect(out.output).not.toContain('non-text content omitted');
  });

  it('still marks other non-text blocks as omitted', () => {
    const out = renderMcpResult({ content: [{ type: 'resource' }] });
    expect(out.output).toBe('[mcp:resource] (non-text content omitted)');
    expect(out.images).toBeUndefined();
  });

  it('reads provenance from _meta.origin', () => {
    const out = renderMcpResult({ content: [{ type: 'text', text: 'hi' }], _meta: { origin: 'https://acme.example' } });
    expect(out.origin).toBe('https://acme.example');
    expect(renderMcpResult({ content: [{ type: 'text', text: 'hi' }], _meta: { origin: 7 } }).origin).toBeUndefined();
  });
});

describe('riskFromAnnotations', () => {
  it('declares critical for destructiveHint and elevated+network for openWorldHint', () => {
    expect(riskFromAnnotations({ destructiveHint: true })).toMatchObject({ tier: 'critical' });
    expect(riskFromAnnotations({ openWorldHint: true })).toMatchObject({ tier: 'elevated', network: true });
  });

  it("never lowers the classification on a server's read-only claim alone", () => {
    expect(riskFromAnnotations({ readOnlyHint: true })).toBeUndefined();
    expect(riskFromAnnotations({ readOnlyHint: true, openWorldHint: true })).toBeUndefined();
    expect(riskFromAnnotations(undefined)).toBeUndefined();
  });

  it('lands on the adapted AgentTool', async () => {
    const pool = {
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    } as unknown as McpClientPool;
    const tool = mcpToolToAgentTool('mail', { name: 'deleteMessage', annotations: { destructiveHint: true } }, pool);
    expect(tool.name).toBe('mail.deleteMessage');
    expect(tool.risk?.tier).toBe('critical');
    const plain = mcpToolToAgentTool('mail', { name: 'listMessages' }, pool);
    expect('risk' in plain).toBe(false);
    expect((await plain.execute({}, testCtx)).output).toBe('ok');
  });
});

describe('server-side result shaping', () => {
  it('emits image blocks and _meta.origin from a ToolResult', () => {
    const out = mcpResultFromToolResult({
      output: 'Screenshot',
      images: [`data:image/jpeg;base64,${B64}`, B64],
      origin: 'https://acme.example'
    });
    expect(out.isError).toBe(false);
    expect(out.content[0]).toEqual({ type: 'text', text: 'Screenshot' });
    expect(out.content[1]).toEqual({ type: 'image', data: B64, mimeType: 'image/jpeg' });
    expect(out.content[2]).toEqual({ type: 'image', data: B64, mimeType: 'image/png' });
    expect(out._meta).toEqual({ origin: 'https://acme.example' });
  });

  it('round-trips through renderMcpResult', () => {
    const back = renderMcpResult(mcpResultFromToolResult({ output: 'x', images: [`data:image/png;base64,${B64}`], origin: 'https://acme.example' }));
    expect(back.images).toEqual([`data:image/png;base64,${B64}`]);
    expect(back.origin).toBe('https://acme.example');
  });

  it('maps declared risk to annotations', () => {
    expect(annotationsFromRisk({ tier: 'critical', network: true })).toEqual({ destructiveHint: true, openWorldHint: true });
    expect(annotationsFromRisk({ tier: 'routine', readOnly: true })).toEqual({ readOnlyHint: true, destructiveHint: false });
  });
});
