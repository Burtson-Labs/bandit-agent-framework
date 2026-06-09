import { describe, it, expect } from 'vitest';
import { resolveTelemetryConfig, TelemetryExporter, type TelemetryConfig } from '@burtson-labs/agent-core';

describe('resolveTelemetryConfig', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('is disabled by default (opt-in)', () => {
    expect(resolveTelemetryConfig({ env })).toBeNull();
    expect(resolveTelemetryConfig({ telemetry: {}, env })).toBeNull();
  });

  it('enables via config and defaults endpoint + bearer from the bandit token', () => {
    const cfg = resolveTelemetryConfig({ telemetry: { enabled: true }, banditApiKey: 'jwt-123', env });
    expect(cfg).not.toBeNull();
    expect(cfg!.endpoint).toBe('https://otlp.burtson.ai');
    expect(cfg!.headers.Authorization).toBe('Bearer jwt-123');
    expect(cfg!.mode).toBe('metrics+traces');
  });

  it('env overrides config (enable, endpoint, token) and trims trailing slash', () => {
    const cfg = resolveTelemetryConfig({
      telemetry: { enabled: false, endpoint: 'https://x' },
      banditApiKey: 'jwt',
      env: { BANDIT_TELEMETRY: '1', BANDIT_OTLP_ENDPOINT: 'https://collector.example/', BANDIT_OTLP_TOKEN: 'tok' } as NodeJS.ProcessEnv
    });
    expect(cfg!.endpoint).toBe('https://collector.example');
    expect(cfg!.headers.Authorization).toBe('Bearer tok');
  });

  it('respects an explicit Authorization header over the default bearer', () => {
    const cfg = resolveTelemetryConfig({ telemetry: { enabled: true, headers: { Authorization: 'Bearer explicit' } }, banditApiKey: 'jwt', env });
    expect(cfg!.headers.Authorization).toBe('Bearer explicit');
  });

  it('BANDIT_TELEMETRY=0 force-disables even when config enables', () => {
    expect(resolveTelemetryConfig({ telemetry: { enabled: true }, env: { BANDIT_TELEMETRY: '0' } as NodeJS.ProcessEnv })).toBeNull();
  });
});

function captureExporter(cfg: Partial<TelemetryConfig> = {}) {
  const posts: Array<{ path: string; body: any }> = [];
  let t = 1_000;
  const clock = () => (t += 100); // each call advances 100ms
  const full: TelemetryConfig = { endpoint: 'https://otlp.test', headers: {}, mode: 'metrics+traces', serviceName: 'bandit-cli', ...cfg };
  const exp = new TelemetryExporter(full, { now: clock, sink: async (path, body) => { posts.push({ path, body }); } });
  return { exp, posts };
}

async function runTurn(exp: TelemetryExporter) {
  exp.startTurn('refactor the auth module', 'claude-opus-4-8');
  exp.onEvent('tool_loop:llm_start', {});
  exp.onEvent('tool_loop:llm_chunk', { chunk: 'hello world here is some streamed content' }); // 40 chars
  exp.onEvent('tool_loop:llm_response', { llmDurationMs: 1234, responseLength: 40 });
  exp.onEvent('tool_loop:tool_execute', { name: 'write_file', params: { path: '/tmp/x.ts' } });
  exp.onEvent('tool_loop:tool_result', { name: 'write_file', isError: true });
  await exp.endTurn();
}

describe('TelemetryExporter', () => {
  it('emits one traces post and one metrics post for a turn', async () => {
    const { exp, posts } = captureExporter();
    await runTurn(exp);
    const paths = posts.map((p) => p.path).sort();
    expect(paths).toEqual(['/v1/metrics', '/v1/traces']);
  });

  it('builds a turn trace with parented llm + tool child spans', async () => {
    const { exp, posts } = captureExporter();
    await runTurn(exp);
    const spans = posts.find((p) => p.path === '/v1/traces')!.body.resourceSpans[0].scopeSpans[0].spans;
    const turn = spans.find((s: any) => s.name === 'agent.turn');
    const llm = spans.find((s: any) => s.name === 'llm.generate');
    const tool = spans.find((s: any) => s.name === 'tool.write_file');
    expect(turn.parentSpanId).toBeUndefined();
    expect(llm.parentSpanId).toBe(turn.spanId);
    expect(tool.parentSpanId).toBe(turn.spanId);
    // tool_result.isError -> span status ERROR (code 2)
    expect(tool.status.code).toBe(2);
    // all spans share one trace
    const traceIds = new Set(spans.map((s: any) => s.traceId));
    expect(traceIds.size).toBe(1);
  });

  it('emits token sum + ttft + duration metrics', async () => {
    const { exp, posts } = captureExporter();
    await runTurn(exp);
    const metrics = posts.find((p) => p.path === '/v1/metrics')!.body.resourceMetrics[0].scopeMetrics[0].metrics;
    const names = metrics.map((m: any) => m.name).sort();
    expect(names).toEqual(['bandit.llm.tokens', 'bandit.llm.ttft', 'bandit.turn.duration']);
    const tokens = metrics.find((m: any) => m.name === 'bandit.llm.tokens');
    expect(tokens.sum.dataPoints[0].asInt).toBe('10'); // 40 chars / 4
    const ttft = metrics.find((m: any) => m.name === 'bandit.llm.ttft');
    expect(ttft.histogram.dataPoints[0].count).toBe('1');
  });

  it('metrics-only mode skips traces', async () => {
    const { exp, posts } = captureExporter({ mode: 'metrics-only' });
    await runTurn(exp);
    expect(posts.map((p) => p.path)).toEqual(['/v1/metrics']);
  });

  it('redacts secrets from the turn goal attribute', async () => {
    const { exp, posts } = captureExporter();
    exp.startTurn('deploy with AKIAIOSFODNN7EXAMPLE as the key', 'm');
    await exp.endTurn();
    const turn = posts.find((p) => p.path === '/v1/traces')!.body.resourceSpans[0].scopeSpans[0].spans[0];
    const goal = turn.attributes.find((a: any) => a.key === 'bandit.turn.goal').value.stringValue;
    expect(goal).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('marks a cancelled turn as error', async () => {
    const { exp, posts } = captureExporter();
    exp.startTurn('do the thing', 'm');
    await exp.endTurn({ error: 'cancelled' });
    const turn = posts.find((p) => p.path === '/v1/traces')!.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(turn.status.code).toBe(2);
    expect(turn.status.message).toBe('cancelled');
  });
});
