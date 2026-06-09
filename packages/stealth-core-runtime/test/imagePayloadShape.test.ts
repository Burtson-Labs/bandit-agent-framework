/**
 * Provider-specific image payload round-trip tests.
 *
 * Why this exists: the VS Code extension, CLI, and any future host all
 * talk to two provider backends with non-trivially different image
 * payload conventions:
 *
 *   Ollama   → message.images[] = raw base64 (no data: prefix)
 *   Bandit   → message.content = [{type:"text"}, {type:"image_url", image_url:{url}}]
 *
 * For two weeks in April 2026, the tool-use adapter attached images via
 * request.images (top-level) and the Bandit branch of the provider left
 * them at the top level without promoting them onto message.content
 * parts — the hosted backend reads content parts only, so every
 * bandit-core-1 image turn silently got a text-only prompt and the
 * model replied "I cannot see images." These tests assert the final
 * serialized payload shape for both providers so that class of bug
 * cannot regress silently.
 */

import { describe, expect, it } from 'vitest';
import { serializeBanditPayload, normalizeOllamaMessages } from '../src/banditEngineProvider';
import type { AIChatRequest } from '../src/types/bandit';

const BASE64_PAYLOAD = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DATA_URL = `data:image/png;base64,${BASE64_PAYLOAD}`;

describe('Ollama payload shape', () => {
  it('strips the data: prefix and splices top-level images onto the last user message', () => {
    const request: AIChatRequest = {
      model: 'gemma3:12b-it-qat',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'what is in this image?' }
      ],
      images: [DATA_URL],
      stream: true
    };

    const normalized = normalizeOllamaMessages(request);
    const lastUser = normalized.filter((m) => m.role === 'user').pop();

    expect(lastUser).toBeDefined();
    expect(lastUser!.images).toEqual([BASE64_PAYLOAD]);
    expect(lastUser!.images?.[0]).not.toMatch(/^data:/);
    expect(lastUser!.content).toBe('what is in this image?');
    // System message should not sprout an images array.
    const system = normalized.find((m) => m.role === 'system');
    expect(system?.images).toBeUndefined();
  });

  it('preserves message-level images supplied directly in content parts', () => {
    const request: AIChatRequest = {
      model: 'gemma3:12b-it-qat',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', image_url: { url: DATA_URL } }
          ] as unknown as string
        }
      ],
      stream: true
    };

    const normalized = normalizeOllamaMessages(request);
    const lastUser = normalized.filter((m) => m.role === 'user').pop();

    expect(lastUser!.images).toEqual([BASE64_PAYLOAD]);
    expect(lastUser!.content).toBe('look at this');
  });
});

describe('Bandit payload shape', () => {
  it('promotes top-level request.images onto the last user message as image_url parts', () => {
    const request: AIChatRequest = {
      model: 'bandit-core-1',
      messages: [
        { role: 'system', content: 'You are Bandit Stealth.' },
        { role: 'user', content: 'what is in this image?' }
      ],
      images: [DATA_URL],
      stream: true
    };

    const payload = serializeBanditPayload(request);
    const lastUser = payload.messages.filter((m) => m.role === 'user').pop();

    expect(lastUser).toBeDefined();
    // Must be an OpenAI-style parts array, NOT a bare string.
    expect(Array.isArray(lastUser!.content)).toBe(true);
    const parts = lastUser!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const textParts = parts.filter((p) => p.type === 'text');
    const imageParts = parts.filter((p) => p.type === 'image_url');
    expect(textParts[0]?.text).toBe('what is in this image?');
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.image_url?.url).toBe(DATA_URL);
    // data: prefix is kept on the Bandit path.
    expect(imageParts[0]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it('does not duplicate an image that is already present in message content', () => {
    const request: AIChatRequest = {
      model: 'bandit-core-1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', image_url: { url: DATA_URL } }
          ] as unknown as string
        }
      ],
      // Same image also listed at the top level — should NOT double.
      images: [DATA_URL],
      stream: true
    };

    const payload = serializeBanditPayload(request);
    const lastUser = payload.messages.filter((m) => m.role === 'user').pop();
    const parts = lastUser!.content as Array<{ type: string }>;
    const imageParts = parts.filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(1);
  });

  it('omits image fields entirely when no images are attached', () => {
    const request: AIChatRequest = {
      model: 'bandit-core-1',
      messages: [{ role: 'user', content: 'plain text prompt' }],
      stream: true
    };

    const payload = serializeBanditPayload(request) as { images?: unknown; messages: Array<{ content: unknown }> };
    expect(payload.images).toBeUndefined();
    const parts = payload.messages[0].content as Array<{ type: string }>;
    expect(parts.every((p) => p.type === 'text')).toBe(true);
  });

  it('keeps backward-compat top-level images field in addition to content parts', () => {
    const request: AIChatRequest = {
      model: 'bandit-core-1',
      messages: [{ role: 'user', content: 'hi' }],
      images: [DATA_URL],
      stream: true
    };

    const payload = serializeBanditPayload(request) as { images?: string[] };
    expect(payload.images).toEqual([DATA_URL]);
  });
});
