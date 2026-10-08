/**
 * Which tool channel a turn uses: the model's NATIVE tool calling (schemas
 * in the request's `tools` field, rendered by the model's own chat
 * template) or the TEXT channel (Bandit's tool block in the system prompt,
 * `<tool_call>` markup parsed from the reply).
 *
 * Same rule as the desktop IDE (`resolveNativeTools` in Stealth's
 * agentChatFns.ts) and the CLI's eval runner, so a model behaves the same
 * on every host:
 *
 *  - openai-compat: native — `tools` is part of the Chat Completions
 *    contract; a server that refuses it falls back to text mid-turn (the
 *    loop's nativeToolFailureFallback).
 *  - ollama: native when the model takes tools AND its behavior profile
 *    prefers the native envelope (hand-tuned bake-off results). Whether
 *    the model takes tools comes from Ollama's live `/api/show`
 *    `capabilities` first, the static table only when Ollama cannot be
 *    asked — the table lags new tags.
 *  - deterministic: text (scripted replies are text-channel markup).
 *
 * `AGENT_RUNNER_NATIVE_TOOLS` gates the whole thing: `off` (default — v1
 * behaviour, every turn on the text channel) or `auto` (the rule above).
 * The probe goes through the provider's own fetch, so a user-supplied
 * endpoint is probed under the same egress policy as the turn.
 */
import {
  getModelCapabilities,
  registerModelCapabilities,
  resolvePreferredToolProtocol,
} from '@burtson-labs/stealth-core-runtime';
import type { TurnProvider } from './contract.js';

export type NativeToolsMode = 'off' | 'auto';

export function parseNativeToolsMode(raw: string | undefined): NativeToolsMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off' || v === '0' || v === 'false') {
    return 'off';
  }
  if (v === 'auto' || v === 'on' || v === '1' || v === 'true') {
    return 'auto';
  }
  throw new Error(`invalid AGENT_RUNNER_NATIVE_TOOLS '${raw}' — expected off or auto`);
}

export interface ToolChannel {
  native: boolean;
  /** Why — logged and emitted on turn.started so a turn's channel is
   *  explainable after the fact. */
  source: 'disabled' | 'deterministic' | 'openai-compat' | 'ollama-show' | 'capability-table';
}

/** Live `/api/show` answers per base URL + model. Failures are not cached:
 *  an Ollama that was down for one turn is asked again on the next. */
const probed = new Map<string, boolean>();

/** Test hook. */
export function resetToolChannelCache(): void {
  probed.clear();
}

async function probeOllamaTools(
  spec: Extract<TurnProvider, { kind: 'ollama' }>,
  fetchImpl: typeof fetch,
): Promise<boolean | null> {
  const root = spec.baseUrl.replace(/\/+$/, '');
  const key = `${root}|${spec.model}`;
  const hit = probed.get(key);
  if (hit !== undefined) {
    return hit;
  }
  try {
    const res = await fetchImpl(`${root}/api/show`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(spec.apiKey ? { Authorization: `Bearer ${spec.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: spec.model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { capabilities?: unknown; model_info?: Record<string, unknown> };
    if (!Array.isArray(data.capabilities)) {
      return null; // an Ollama too old to say — the table answers
    }
    const caps = new Set(data.capabilities.map((c) => String(c).toLowerCase()));
    const takesTools = caps.has('tools');
    // Teach the runtime's table what Ollama said, for the models it does
    // not know (built-in profiles still win — see getModelCapabilities).
    const base = getModelCapabilities(spec.model);
    const ctxEntry = Object.entries(data.model_info ?? {}).find(([k]) => k.endsWith('.context_length'));
    registerModelCapabilities(spec.model, {
      ...base,
      contextWindow: typeof ctxEntry?.[1] === 'number' ? ctxEntry[1] : base.contextWindow,
      supportsToolCalling: takesTools,
      supportsVision: caps.has('vision') || base.supportsVision,
      label: base.label || spec.model,
    });
    probed.set(key, takesTools);
    return takesTools;
  } catch {
    return null;
  }
}

export async function resolveToolChannel(
  spec: TurnProvider,
  mode: NativeToolsMode,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolChannel> {
  if (mode === 'off') {
    return { native: false, source: 'disabled' };
  }
  if (spec.kind === 'deterministic') {
    return { native: false, source: 'deterministic' };
  }
  if (spec.kind === 'openai-compat') {
    return { native: true, source: 'openai-compat' };
  }
  const live = await probeOllamaTools(spec, fetchImpl);
  const takesTools = live ?? getModelCapabilities(spec.model).supportsToolCalling;
  return {
    native: takesTools && resolvePreferredToolProtocol(spec.model) === 'native-tools',
    source: live === null ? 'capability-table' : 'ollama-show',
  };
}
