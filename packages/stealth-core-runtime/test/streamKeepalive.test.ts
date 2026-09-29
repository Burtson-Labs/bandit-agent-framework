/**
 * Keepalive bytes on chat streams must be invisible to the model output.
 *
 * Behind Cloudflare (100 s idle cut) the gateway writes heartbeats while a
 * model cold-loads or a tool call runs: `: ping` comments and `event: ping`
 * heartbeat events on SSE, and a bare space between lines on NDJSON. None of
 * them may surface as content, end the stream early, or throw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '../src/banditEngineProvider';
import type { AIChatResponse } from '../src/types/bandit';

const enc = new TextEncoder();

function streamResponse(chunks: string[], contentType: string): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {controller.enqueue(enc.encode(chunks[i++]));}
      else {controller.close();}
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

async function collect(it: AsyncIterable<AIChatResponse>): Promise<AIChatResponse[]> {
  const out: AIChatResponse[] = [];
  for await (const r of it) {out.push(r);}
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], stream: true };

describe('chat stream keepalives', () => {
  it('SSE: ignores comment pings and event: ping heartbeats', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          [
            ': ping\n\n',
            'event: ping\ndata: {"message":"heartbeat"}\n\n',
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            ': ping\r\n\r\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n'
          ],
          'text/event-stream'
        )
      )
    );
    const provider = await createProvider({ kind: 'bandit', apiUrl: 'https://gw.test/api/bandit/chat' });
    const out = await collect(provider.chat(request));

    expect(out.filter((r) => !r.done).map((r) => r.message.content).join('')).toBe('Hello');
    expect(out.filter((r) => r.done)).toHaveLength(1);
    expect(out[out.length - 1].done).toBe(true);
  });

  it('NDJSON: tolerates whitespace keepalives between lines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          [
            ' ',
            ' ',
            '{"message":{"role":"assistant","content":"Hel"},"done":false}\n',
            ' ',
            '{"message":{"role":"assistant","content":"lo"},"done":false}\n',
            ' {"message":{"role":"assistant","content":""},"done":true}\n'
          ],
          'application/x-ndjson'
        )
      )
    );
    const provider = await createProvider({ kind: 'ollama', ollamaUrl: 'http://ollama.test', ollamaModel: 'm' });
    const out = await collect(provider.chat(request));

    expect(out.filter((r) => !r.done).map((r) => r.message.content).join('')).toBe('Hello');
    expect(out[out.length - 1].done).toBe(true);
  });
});
