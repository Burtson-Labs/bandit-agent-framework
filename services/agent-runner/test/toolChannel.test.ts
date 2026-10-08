/**
 * Native tool-calls gating (ADR-001 phase 2): per model, from Ollama's own
 * `/api/show` capabilities first and the runtime's table second, with the
 * behavior profile having the last word — the same rule the desktop IDE
 * and the CLI apply. Off by default; `auto` turns the rule on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatFn } from '@burtson-labs/agent-core';
import { clearDiscoveredCapabilities } from '@burtson-labs/stealth-core-runtime';
import { parseNativeToolsMode, resetToolChannelCache, resolveToolChannel } from '../src/toolChannel';
import { runTurn } from '../src/turn';
import type { RunnerEvent, TurnProvider } from '../src/contract';

afterEach(() => {
  resetToolChannelCache();
  clearDiscoveredCapabilities();
});

function showFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, impl };
}

const failingFetch = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

const ollama = (model: string, extra: Partial<Extract<TurnProvider, { kind: 'ollama' }>> = {}): TurnProvider => ({
  kind: 'ollama',
  baseUrl: 'http://ollama.test:11434',
  model,
  ...extra,
});

describe('parseNativeToolsMode', () => {
  it('defaults to off and accepts auto', () => {
    expect(parseNativeToolsMode(undefined)).toBe('off');
    expect(parseNativeToolsMode('')).toBe('off');
    expect(parseNativeToolsMode('AUTO')).toBe('auto');
  });

  it('refuses a typo at startup rather than guessing', () => {
    expect(() => parseNativeToolsMode('yes please')).toThrow(/AGENT_RUNNER_NATIVE_TOOLS/);
  });
});

describe('resolveToolChannel', () => {
  it('keeps every turn on the text channel when off, without asking Ollama', async () => {
    const { calls, impl } = showFetch({ capabilities: ['tools'] });
    expect(await resolveToolChannel(ollama('qwen2.5-coder:14b'), 'off', impl)).toEqual({ native: false, source: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('never goes native for the scripted provider', async () => {
    expect((await resolveToolChannel({ kind: 'deterministic' }, 'auto')).native).toBe(false);
  });

  it('goes native for openai-compatible servers', async () => {
    const spec: TurnProvider = { kind: 'openai-compat', baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm' };
    expect(await resolveToolChannel(spec, 'auto')).toEqual({ native: true, source: 'openai-compat' });
  });

  it('trusts Ollama for a model the table does not know', async () => {
    const { calls, impl } = showFetch({ capabilities: ['completion', 'tools'], model_info: { 'acme.context_length': 65536 } });
    const channel = await resolveToolChannel(ollama('acme-coder:7b'), 'auto', impl);
    expect(channel).toEqual({ native: true, source: 'ollama-show' });
    expect(calls[0].url).toBe('http://ollama.test:11434/api/show');
    expect(JSON.parse(calls[0].body)).toEqual({ model: 'acme-coder:7b' });
  });

  it('stays on text when Ollama says the model takes no tools', async () => {
    const { impl } = showFetch({ capabilities: ['completion'] });
    expect((await resolveToolChannel(ollama('acme-chat:7b'), 'auto', impl)).native).toBe(false);
  });

  it('falls back to the table when Ollama cannot be asked', async () => {
    expect(await resolveToolChannel(ollama('qwen2.5-coder:14b'), 'auto', failingFetch)).toEqual({
      native: true,
      source: 'capability-table',
    });
    expect((await resolveToolChannel(ollama('acme-unknown:1b'), 'auto', failingFetch)).native).toBe(false);
  });

  it('lets a behavior profile that prefers text win over a tool-capable model', async () => {
    // llama3.1 takes tools but is steadier on the text envelope
    // (hand-tuned bake-off) — the same answer the IDE and CLI give.
    const { impl } = showFetch({ capabilities: ['completion', 'tools'] });
    expect((await resolveToolChannel(ollama('llama3.1:8b'), 'auto', impl)).native).toBe(false);
  });

  it('sends the Ollama Cloud bearer to /api/show', async () => {
    const { calls, impl } = showFetch({ capabilities: ['tools'] });
    await resolveToolChannel(ollama('acme-cloud:70b', { baseUrl: 'https://ollama.com', apiKey: 'bearer-x' }), 'auto', impl);
    expect(calls[0].headers.Authorization).toBe('Bearer bearer-x');
  });

  it('asks Ollama once per endpoint and model, and again after a failure', async () => {
    const { calls, impl } = showFetch({ capabilities: ['tools'] });
    await resolveToolChannel(ollama('acme-coder:7b'), 'auto', impl);
    await resolveToolChannel(ollama('acme-coder:7b'), 'auto', impl);
    expect(calls).toHaveLength(1);

    await resolveToolChannel(ollama('acme-other:7b'), 'auto', failingFetch);
    const second = showFetch({ capabilities: ['tools'] });
    await resolveToolChannel(ollama('acme-other:7b'), 'auto', second.impl);
    expect(second.calls).toHaveLength(1);
  });
});

describe('runTurn with the native channel', () => {
  let graphFlag: string | undefined;
  const dirs: string[] = [];
  beforeAll(() => {
    graphFlag = process.env.RUNNER_GRAPH;
    process.env.RUNNER_GRAPH = '0';
  });
  afterAll(() => {
    if (graphFlag === undefined) {
      delete process.env.RUNNER_GRAPH;
    } else {
      process.env.RUNNER_GRAPH = graphFlag;
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function turnWith(nativeTools: boolean) {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-native-')));
    dirs.push(ws);
    const seenTools: unknown[] = [];
    const seenSystem: string[] = [];
    const replies = [
      '<tool_call>{"name": "write_file", "params": {"path": "hello.md", "content": "# Hello\\n"}}</tool_call>',
      'Created hello.md.',
    ];
    let i = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    const chat: ChatFn = async function* (messages, tools) {
      seenTools.push(tools);
      seenSystem.push(messages.find((m) => m.role === 'system')?.content ?? '');
      yield replies[Math.min(i++, replies.length - 1)];
    };
    const events: RunnerEvent[] = [];
    await runTurn(
      {
        protocol: 1,
        taskId: 't1',
        workspacePath: ws,
        prompt: 'Create hello.md with a greeting.',
        provider: { kind: 'deterministic' },
        maxIterations: 4,
      },
      (e) => events.push(e),
      { permissionMode: 'standard', chat, nativeTools },
    );
    return { seenTools, seenSystem, events };
  }

  it('hands the tool schemas to the model and reports the channel', async () => {
    const { seenTools, events } = await turnWith(true);
    const schemas = seenTools[0] as Array<{ function?: { name?: string } }>;
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas.map((s) => s.function?.name)).toContain('write_file');
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed', artifacts: 1, toolChannel: 'native' });
  });

  it('sends no schemas on the text channel', async () => {
    const { seenTools, events } = await turnWith(false);
    expect(seenTools.every((t) => t === undefined || (Array.isArray(t) && t.length === 0))).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed', toolChannel: 'text' });
  });
});
