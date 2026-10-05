import * as http from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { buildChat, contextWindowProblem, resolveModelRuntime, type RunnerProvider } from '../src/__eval__/runner';

const chat: RunnerProvider['chat'] = async function* () { yield 'x'; };
const provider = (kind: RunnerProvider['kind'], model: string): RunnerProvider =>
  ({ kind, model, settings: {} as RunnerProvider['settings'], chat });

describe('eval runner: the model is driven the way production drives it', () => {
  it('refuses a context window the prompt and tool schemas do not fit', () => {
    // Measured on the 26-fixture run: 12.8k chars of system prompt + 22.6k of tool schemas
    // (8,099 tokens for qwen3) against the 8,192-token fallback window.
    expect(contextWindowProblem(12_781, 22_558, 8192)).toMatch(/about 8835 tokens.*8192-token/);
    expect(contextWindowProblem(12_781, 22_558, 24_576)).toBeNull();
    expect(contextWindowProblem(12_781, 0, 8192)).toBeNull();
    expect(contextWindowProblem(12_781, 22_558, undefined)).toBeNull();
  });

  it('resolves tool channel, window and loop limits from the capability tables', async () => {
    const known = await resolveModelRuntime(provider('ollama', 'qwen3.6:27b'));
    expect(known).toMatchObject({ nativeTools: true, numCtx: 32768, tier: 'large', messageTokenBudget: 24576, maxParallelTools: 6, compactToolBlock: false });
    const medium = await resolveModelRuntime(provider('ollama', 'gemma4:12b-it-qat'));
    expect(medium).toMatchObject({ nativeTools: true, numCtx: 24576, tier: 'medium' });
  });

  it('uses the hosted compaction budget when the window is not ours to set', async () => {
    const hosted = await resolveModelRuntime(provider('bandit', 'bandit-logic'));
    expect(hosted.numCtx).toBeUndefined();
    expect(hosted.messageTokenBudget).toBe(24576);
  });

  it('resolves once per provider', () => {
    const p = provider('ollama', 'qwen3.6:27b');
    expect(resolveModelRuntime(p)).toBe(resolveModelRuntime(p));
  });
});

describe('eval runner: chat requests', () => {
  /** A stand-in Ollama that records each /api/chat body and answers with one chunk. */
  async function fakeOllama(): Promise<{ url: string; bodies: Array<Record<string, unknown>>; close: () => Promise<void> }> {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end('{"message":{"role":"assistant","content":"ok"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true}\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise(resolve => server.close(() => resolve())) };
  }

  it("forwards the loop's per-call thinking override, as the CLI chat function does", async () => {
    const ollama = await fakeOllama();
    try {
      const chatFn = await buildChat({ kind: 'ollama', model: 'some-unprofiled-model:8b', settings: { kind: 'ollama', ollamaUrl: ollama.url } as RunnerProvider['settings'] });
      const drain = async (options?: { think?: boolean }): Promise<string> => {
        let text = '';
        for await (const chunk of chatFn([{ role: 'user', content: 'hi' }], undefined, options)) text += chunk;
        return text;
      };
      expect(await drain()).toBe('ok');
      expect(await drain({ think: false })).toBe('ok');
      expect('think' in ollama.bodies[0]).toBe(false);   // no profile default, no override: field not sent
      expect(ollama.bodies[1].think).toBe(false);        // the loop's thinking-off recovery reaches Ollama
      expect((ollama.bodies[1].options as { num_ctx?: number }).num_ctx).toBeGreaterThan(0);
    } finally {
      await ollama.close();
    }
  });
});
