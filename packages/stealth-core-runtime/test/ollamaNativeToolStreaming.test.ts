import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import {
  AGENT_NUM_PREDICT_BACKSTOP,
  THINKING_ONLY_BUDGET_CHARS,
  createProvider,
  isModelOutputLoopError,
  OLLAMA_OUTPUT_TRUNCATED_SENTINEL
} from '../src';

/**
 * Native-tools turns on the direct Ollama provider stream (they used to be
 * sent with stream:false, which hid every token from the host's watchdog).
 * Chunk shapes below are what Ollama 0.35.1 sends — checked live on
 * 2026-10-19: thinking/content deltas, then each tool call whole in its own
 * non-terminal chunk, then a terminal `done` chunk with done_reason.
 */

type Chunk = Record<string, unknown>;

function ndjsonFetch(chunks: Chunk[] | (() => AsyncGenerator<Chunk>), opts: { json?: boolean } = {}) {
  const seen: { body?: Record<string, unknown>; signal?: AbortSignal } = {};
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body));
    seen.signal = init?.signal ?? undefined;
    if (opts.json) {
      return new Response(JSON.stringify((chunks as Chunk[])[0]), { status: 200 });
    }
    const encoder = new TextEncoder();
    const source = typeof chunks === 'function' ? chunks() : (async function* () { yield* chunks; })();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (seen.signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
        const next = await source.next();
        if (next.done) { controller.close(); return; }
        controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n'));
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }) as typeof fetch;
  return { seen, impl };
}

const TOOLS = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const msg = (m: Record<string, unknown>, extra: Chunk = {}): Chunk => ({ model: 'gemma4:12b', message: { role: 'assistant', content: '', ...m }, done: false, ...extra });

async function collect(provider: Awaited<ReturnType<typeof createProvider>>, request: Record<string, unknown>) {
  const out: Array<{ content: string; thinking?: string; done?: boolean }> = [];
  for await (const r of provider.chat({ model: 'gemma4:12b', messages: [{ role: 'user', content: 'x' }], ...request } as never)) {
    out.push({ content: r.message.content, thinking: r.message.thinking, done: r.done });
  }
  return out;
}

const textOf = (out: Array<{ content: string }>) => out.map((o) => o.content).join('');

describe('Ollama native-tools streaming', () => {
  it('streams, yields thinking/content as they arrive, and appends the same tool_call markers', async () => {
    const { seen, impl } = ndjsonFetch([
      msg({ thinking: 'Let me ' }),
      msg({ thinking: 'read it.' }),
      msg({ content: 'Reading' }),
      msg({ content: ' the file.' }),
      msg({ tool_calls: [{ id: 'call_1', function: { index: 0, name: 'read_file', arguments: { path: 'rates/rates.go', limit: 20, flags: { a: true } } } }] }),
      msg({}, { done: true, done_reason: 'stop' })
    ]);
    const provider = await createProvider({ kind: 'ollama', ollamaModel: 'gemma4:12b', fetchImpl: impl });
    const out = await collect(provider, { stream: true, tools: TOOLS });

    expect(seen.body?.stream).toBe(true);
    expect((seen.body?.options as Record<string, unknown>).num_predict).toBe(AGENT_NUM_PREDICT_BACKSTOP);
    expect(out.filter((o) => o.thinking).map((o) => o.thinking)).toEqual(['Let me ', 'read it.']);
    // Same text the non-streaming translator produced: content + '\n' + markers,
    // params stringified.
    expect(textOf(out)).toBe(
      'Reading the file.\n<tool_call>{"name":"read_file","params":{"path":"rates/rates.go","limit":"20","flags":"{\\"a\\":true}"}}</tool_call>'
    );
    expect(out[out.length - 1].done).toBe(true);
  });

  it('matches the non-streaming translator byte for byte', async () => {
    const toolCalls = [
      { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
      { function: { name: 'read_file', arguments: { path: 'b.ts' } } }
    ];
    const streamed = ndjsonFetch([msg({ content: 'Two reads.' }), msg({ tool_calls: [toolCalls[0]] }), msg({ tool_calls: [toolCalls[1]] }), msg({}, { done: true, done_reason: 'stop' })]);
    const whole = ndjsonFetch([{ message: { role: 'assistant', content: 'Two reads.', tool_calls: toolCalls }, done: true, done_reason: 'stop' }], { json: true });
    const a = textOf(await collect(await createProvider({ kind: 'ollama', fetchImpl: streamed.impl }), { stream: true, tools: TOOLS }));
    const b = textOf(await collect(await createProvider({ kind: 'ollama', fetchImpl: whole.impl }), { stream: false, tools: TOOLS }));
    expect(a).toBe(b);
    expect(whole.seen.body?.stream).toBe(false);
  });

  it('tool call with no content yields only the markers', async () => {
    const { impl } = ndjsonFetch([msg({ thinking: 'hm' }), msg({ tool_calls: [{ function: { name: 'ls', arguments: {} } }] }), msg({}, { done: true, done_reason: 'stop' })]);
    const out = await collect(await createProvider({ kind: 'ollama', fetchImpl: impl }), { stream: true, tools: TOOLS });
    expect(textOf(out)).toBe('<tool_call>{"name":"ls","params":{}}</tool_call>');
  });

  it('keeps a caller-supplied num_predict and adds none without tools', async () => {
    const withTools = ndjsonFetch([msg({}, { done: true })]);
    await collect(await createProvider({ kind: 'ollama', fetchImpl: withTools.impl }), { stream: true, tools: TOOLS, options: { num_predict: 500 } });
    expect((withTools.seen.body?.options as Record<string, unknown>).num_predict).toBe(500);
    const plain = ndjsonFetch([msg({}, { done: true })]);
    await collect(await createProvider({ kind: 'ollama', fetchImpl: plain.impl }), { stream: true });
    expect((plain.seen.body?.options as Record<string, unknown>).num_predict).toBeUndefined();
  });

  it('done_reason "length" drops the cut-off tool call and appends the truncation sentinel', async () => {
    // Real Ollama shape: the truncated call arrives whole, with half its arguments.
    const { impl } = ndjsonFetch([
      msg({ content: 'Writing.' }),
      msg({ tool_calls: [{ function: { name: 'write_file', arguments: { content: 'export const a = [\n  { id: 1, na' } } }] }, { done: true, done_reason: 'length' })
    ]);
    const text = textOf(await collect(await createProvider({ kind: 'ollama', fetchImpl: impl }), { stream: true, tools: TOOLS }));
    expect(text).toBe(`Writing.\n\n${OLLAMA_OUTPUT_TRUNCATED_SENTINEL}`);
    expect(text).not.toContain('<tool_call>');
  });

  it('streamIdleMs sets the idle window and is never sent to Ollama', async () => {
    // A stream that sends one chunk and then nothing.
    const { seen, impl } = ndjsonFetch(async function* () {
      yield msg({ content: 'x' });
      await new Promise(() => undefined);
    });
    const provider = await createProvider({ kind: 'ollama', fetchImpl: impl });
    const started = Date.now();
    await expect(collect(provider, { stream: true, tools: TOOLS, streamIdleMs: 60 })).rejects.toThrow(/stalled — no data for 60ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.body).not.toHaveProperty('streamIdleMs');
  });

  it('non-streaming done_reason "length" is also marked truncated', async () => {
    const { impl } = ndjsonFetch([{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { content: 'x' } } }] }, done: true, done_reason: 'length' }], { json: true });
    const text = textOf(await collect(await createProvider({ kind: 'ollama', fetchImpl: impl }), { stream: false, tools: TOOLS }));
    expect(text).toBe(OLLAMA_OUTPUT_TRUNCATED_SENTINEL);
  });

  it('stops a degenerate thinking loop, aborts the request and throws a recognisable error', async () => {
    let produced = 0;
    const { seen, impl } = ndjsonFetch(async function* () {
      yield msg({ thinking: 'The user wants a rename. ' });
      for (;;) {
        produced++;
        if (produced > 5000) {throw new Error('detector never fired');}
        yield msg({ thinking: '<|channel>thought ' });
      }
    });
    const provider = await createProvider({ kind: 'ollama', fetchImpl: impl });
    const err = await collect(provider, { stream: true, tools: TOOLS }).then(() => null, (e: unknown) => e);
    expect(isModelOutputLoopError(err)).toBe(true);
    expect((err as Error).message).toMatch(/^Model output loop detected/);
    expect(seen.signal?.aborted).toBe(true);
    expect(produced * '<|channel>thought '.length).toBeLessThan(4600);
  });

  it('a long varied thinking stream (under the thinking-only budget) is never stopped by the loop detector', async () => {
    const { impl } = ndjsonFetch(async function* () {
      // ~28k chars: well past the loop detector's 4000-char window, under the 32k budget.
      for (let i = 0; i < 1000; i++) {yield msg({ thinking: `step ${i}: check case ${i % 7}. ` });}
      yield msg({ content: 'done' });
      yield msg({}, { done: true, done_reason: 'stop' });
    });
    const out = await collect(await createProvider({ kind: 'ollama', fetchImpl: impl }), { stream: true, tools: TOOLS });
    expect(textOf(out)).toBe('done');
  });

  it("the caller's signal aborts the request", async () => {
    const controller = new AbortController();
    const { seen, impl } = ndjsonFetch(async function* () {
      yield msg({ thinking: 'a' });
      controller.abort();
      yield msg({ thinking: 'b' });
      yield msg({}, { done: true });
    });
    await collect(await createProvider({ kind: 'ollama', fetchImpl: impl }), { stream: true, tools: TOOLS, signal: controller.signal }).catch(() => undefined);
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.body).not.toHaveProperty('signal');
  });
});

describe('Ollama thinking-only budget', () => {
  const prevEnv = process.env.BANDIT_THINKING_BUDGET_CHARS;
  afterEach(() => {
    if (prevEnv === undefined) {delete process.env.BANDIT_THINKING_BUDGET_CHARS;}
    else {process.env.BANDIT_THINKING_BUDGET_CHARS = prevEnv;}
  });
  /** Varied (never periodic) reasoning text, ~40 chars per chunk. */
  const step = (i: number) => `step ${i}: weigh option ${(i * 7919) % 1013}. `;
  const run = async (gen: () => AsyncGenerator<Chunk>) => {
    const { seen, impl } = ndjsonFetch(gen);
    const provider = await createProvider({ kind: 'ollama', fetchImpl: impl });
    const result = await collect(provider, { stream: true, tools: TOOLS }).then((out) => ({ out }), (error: unknown) => ({ error }));
    return { ...result, seen } as { out?: Awaited<ReturnType<typeof collect>>; error?: unknown; seen: typeof seen };
  };

  it('is a named constant of ~8k tokens', () => {
    expect(THINKING_ONLY_BUDGET_CHARS).toBe(32_000);
  });

  it('stops a reply that has only thought past the budget, aborts it and takes the loop-recovery path', async () => {
    let chars = 0;
    const r = await run(async function* () {
      for (let i = 0; i < 5000; i++) { const t = step(i); chars += t.length; yield msg({ thinking: t }); }
      yield msg({}, { done: true });
    });
    expect(isModelOutputLoopError(r.error)).toBe(true);
    expect((r.error as Error).message).toMatch(/^Model thinking budget exceeded/);
    expect((r.error as { code?: string }).code).toBe('MODEL_THINKING_BUDGET');
    expect(r.seen.signal?.aborted).toBe(true);
    expect(chars).toBeLessThan(THINKING_ONLY_BUDGET_CHARS + 200);
  });

  it('never stops long legitimate thinking under the budget', async () => {
    const r = await run(async function* () {
      let n = 0;
      for (let i = 0; n < 31_000; i++) { const t = step(i); n += t.length; yield msg({ thinking: t }); }
      yield msg({ content: 'Answer.' });
      yield msg({}, { done: true, done_reason: 'stop' });
    });
    expect(r.error).toBeUndefined();
    expect(textOf(r.out!)).toBe('Answer.');
  });

  it('never fires once content has started, however long the thinking after it', async () => {
    const r = await run(async function* () {
      yield msg({ thinking: 'plan. ' });
      yield msg({ content: 'Here is the plan:' });
      for (let i = 0; i < 3000; i++) {yield msg({ thinking: step(i) });}
      yield msg({}, { done: true, done_reason: 'stop' });
    });
    expect(r.error).toBeUndefined();
  });

  it('never fires once a tool call has arrived', async () => {
    const r = await run(async function* () {
      yield msg({ tool_calls: [{ function: { name: 'ls', arguments: {} } }] });
      for (let i = 0; i < 3000; i++) {yield msg({ thinking: step(i) });}
      yield msg({}, { done: true, done_reason: 'stop' });
    });
    expect(r.error).toBeUndefined();
    expect(textOf(r.out!)).toContain('<tool_call>{"name":"ls"');
  });

  it('never fires on output without thinking, however long', async () => {
    const r = await run(async function* () {
      for (let i = 0; i < 4000; i++) {yield msg({ content: step(i) });}
      yield msg({}, { done: true, done_reason: 'stop' });
    });
    expect(r.error).toBeUndefined();
  });

  it('whitespace-only content deltas (qwen) do not switch the budget off', async () => {
    const r = await run(async function* () {
      for (let i = 0; i < 5000; i++) {yield msg({ thinking: step(i), content: '\n' });}
      yield msg({}, { done: true });
    });
    expect((r.error as Error)?.message).toMatch(/^Model thinking budget exceeded/);
  });

  it('BANDIT_THINKING_BUDGET_CHARS overrides it; 0 disables it', async () => {
    const think = async function* () {
      for (let i = 0; i < 2000; i++) {yield msg({ thinking: step(i) });}
      yield msg({ content: 'ok' });
      yield msg({}, { done: true });
    };
    process.env.BANDIT_THINKING_BUDGET_CHARS = '0';
    expect((await run(think)).error).toBeUndefined();
    process.env.BANDIT_THINKING_BUDGET_CHARS = '5000';
    expect((await run(think)).error).toBeInstanceOf(Error);
  });
});

