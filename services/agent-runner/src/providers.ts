/**
 * Real model providers for cloud turns — by reusing the framework's own
 * provider layer, not reimplementing it.
 *
 * stealth-core-runtime's createProvider() is 1,200 lines of accumulated
 * production behaviour: retry with error hints, control-token stripping,
 * thinking-field separation, and — the important one — translation of
 * native `tool_calls` (both Ollama and OpenAI shapes) back into inline
 * `<tool_call>` markup so the ToolUseLoop parses every model identically.
 * A fresh HTTP client here would rediscover each of those lessons as a
 * production incident.
 *
 * The text (XML) tool channel is the default; the native channel is
 * gated per model by toolChannel.ts (AGENT_RUNNER_NATIVE_TOOLS=auto) and
 * changes nothing in the runner contract.
 */
import {
  createProvider,
  type ProviderSettings,
} from '@burtson-labs/stealth-core-runtime';
import type { AIChatRequest, AIMessage } from '@burtson-labs/stealth-core-runtime';
import type { ChatFn, ToolLoopMessage } from '@burtson-labs/agent-core';
import { DeterministicProviderClient } from '@burtson-labs/agent-core';
import type { TurnProvider } from './contract.js';
import { createPublicOnlyFetch, NO_ALLOWANCE, type EgressAllowance } from './egress.js';

/**
 * Scripted provider for seam proofs and load tests: each chat() call pops
 * the next scripted response, letting CI drive a full multi-iteration
 * tool turn with no model attached.
 */
class ScriptedChat {
  private i = 0;
  constructor(private script: string[]) {}
  next(): string {
    const out = this.script[this.i] ?? 'Done.';
    this.i += 1;
    return out;
  }
}

/**
 * The fetch every request to this provider goes through. A user-chosen
 * endpoint gets the egress-checking fetch (connect-time address check, no
 * redirects); operator endpoints use the global fetch. Exported so the
 * capability probe obeys the same policy as the turn.
 */
export function providerFetchFor(spec: TurnProvider, opts: ChatFnOptions = {}): typeof fetch | undefined {
  return spec.kind !== 'deterministic' && spec.egress === 'public-only'
    ? createPublicOnlyFetch(opts.egressAllowance ?? NO_ALLOWANCE)
    : undefined;
}

function settingsFor(spec: TurnProvider, opts: ChatFnOptions): ProviderSettings {
  const fetchImpl = opts.fetchImpl ?? providerFetchFor(spec, opts);
  return { ...baseSettingsFor(spec), ...(fetchImpl ? { fetchImpl } : {}) };
}

export interface ChatFnOptions {
  egressAllowance?: EgressAllowance;
  /** A fetch already built for this provider (shared with the capability
   *  probe); built from `egressAllowance` when absent. */
  fetchImpl?: typeof fetch;
}

function baseSettingsFor(spec: TurnProvider): ProviderSettings {
  switch (spec.kind) {
    case 'ollama':
      // Ollama Cloud auth: the runtime's ollama path reads ollamaHeaders —
      // NOT the generic apiKey field, which it ignores (verified with a
      // live 401: apiKey mapped, header absent, ollama.com refused). The
      // error hint says as much: "set an Ollama Cloud API key as the
      // Authorization header (CLI: ollama.headers)". Local daemons omit it.
      return {
        kind: 'ollama',
        ollamaUrl: spec.baseUrl,
        ollamaModel: spec.model,
        ...(spec.apiKey
          ? { ollamaHeaders: { Authorization: `Bearer ${spec.apiKey}` } }
          : {}),
      };
    case 'openai-compat':
      return {
        kind: 'openai-compatible',
        openaiBaseUrl: spec.baseUrl,
        openaiApiKey: spec.apiKey,
        openaiModel: spec.model,
      };
    default:
      throw new Error(`no settings mapping for provider kind '${spec.kind}'`);
  }
}

function toAIMessages(messages: ToolLoopMessage[]): AIMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** The loop's ChatFn for a given provider spec. */
export async function chatFnFor(spec: TurnProvider, opts: ChatFnOptions = {}): Promise<ChatFn> {
  if (spec.kind === 'deterministic') {
    if (spec.script?.length) {
      const scripted = new ScriptedChat(spec.script);
      // eslint-disable-next-line @typescript-eslint/require-await
      return async function* scriptedChat() {
        yield scripted.next();
      };
    }
    const det = new DeterministicProviderClient();
    return (messages) => {
      const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
      return det.chat(prompt);
    };
  }

  const settings = settingsFor(spec, opts);
  const provider = await createProvider(settings);
  const model = spec.kind === 'ollama' || spec.kind === 'openai-compat' ? spec.model : '';

  return async function* providerChat(messages, tools) {
    const stream = provider.chat({
      model,
      messages: toAIMessages(messages),
      stream: true,
      // Native channel: the loop passes the registry's schemas on every
      // call when nativeTools is on (see toolChannel.ts); the provider
      // sends them as the request's `tools` field and translates the
      // model's tool_calls back into inline markup. Absent = text channel.
      ...(tools && tools.length > 0 ? { tools: tools as AIChatRequest['tools'] } : {}),
    });
    for await (const chunk of stream) {
      // `thinking` stays out of the transcript by design; the loop only
      // wants visible content, and tool_calls arrive already translated
      // to inline markup by the provider layer.
      const piece = chunk.message?.content;
      if (piece) yield piece;
    }
  };
}
