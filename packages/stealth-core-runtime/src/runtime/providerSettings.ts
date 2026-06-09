import type { ProviderKind, ProviderSettings } from '../internalTypes';

export const DEFAULT_OLLAMA_MODEL = 'gemma4:12b';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface ProviderConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

export function getProviderKind(configuration: ProviderConfiguration): ProviderKind {
  const rawProvider = configuration.get<string>('provider', 'ollama');
  const normalized = typeof rawProvider === 'string' ? rawProvider.trim().toLowerCase() : 'ollama';
  return normalized === 'ollama' ? 'ollama' : 'bandit';
}

export function getProviderModel(
  configuration: ProviderConfiguration,
  providerKind: ProviderKind
): string {
  if (providerKind === 'ollama') {
    return configuration.get<string>('ollamaModel', DEFAULT_OLLAMA_MODEL) || DEFAULT_OLLAMA_MODEL;
  }
  return configuration.get<string>('model', 'bandit-core-1') || 'bandit-core-1';
}

/**
 * Returns the model ID to use for agent rewrite/coding tasks.
 * When `banditStealth.agentOllamaModel` is set (Ollama provider only), that model
 * is used instead of `ollamaModel`, allowing a separate coding model (e.g.
 * `qwen2.5-coder:32b`) while keeping a different chat model (`bandit-core:27b-it-qat`).
 * Falls back to `getProviderModel` when no agent-specific model is configured.
 */
export function getAgentProviderModel(
  configuration: ProviderConfiguration,
  providerKind: ProviderKind
): string {
  if (providerKind === 'ollama') {
    const agentModel = configuration.get<string>('agentOllamaModel', '');
    if (agentModel) {return agentModel;}
    const codingModel = configuration.get<string>('ollamaCodingModel', '');
    if (codingModel) {return codingModel;}
  }
  return getProviderModel(configuration, providerKind);
}

export function buildProviderSettings(
  configuration: ProviderConfiguration,
  apiKey: string
): ProviderSettings {
  const rawHeaders = configuration.get<Record<string, string>>('ollamaHeaders', {}) || {};
  const ollamaHeaders = sanitizeOllamaHeaders(rawHeaders);
  return {
    kind: getProviderKind(configuration),
    apiKey,
    apiUrl: configuration.get<string>('apiUrl', 'https://api.burtson.ai/completions'),
    // ollamaUrl: primary local endpoint (Mac localhost or LAN). Never RunPod.
    // Accepts both ollamaUrl (legacy) and ollamaBaseUrl (new setting name).
    ollamaUrl:
      configuration.get<string>('ollamaBaseUrl', '') ||
      configuration.get<string>('ollamaUrl', DEFAULT_OLLAMA_URL) ||
      DEFAULT_OLLAMA_URL,
    // ollamaNodeUrl: optional secondary endpoint for external node (e.g. RTX 5090).
    // When set, Ollama requests are routed here instead of ollamaUrl.
    ollamaNodeUrl: configuration.get<string>('ollamaNodeUrl', '') || undefined,
    ollamaModel:
      configuration.get<string>('ollamaModel', DEFAULT_OLLAMA_MODEL) || DEFAULT_OLLAMA_MODEL,
    // ollamaHeaders: extra HTTP headers (Bearer token, Cloudflare Access, etc.).
    // Undefined when empty so banditEngineProvider can skip the merge fast-path.
    ollamaHeaders: Object.keys(ollamaHeaders).length > 0 ? ollamaHeaders : undefined
  };
}

/**
 * Resolves the actual Ollama URL + headers the chat engine will use, mirroring
 * the resolution in {@link ../banditEngineProvider.ts}. Shared so the model
 * picker and other UI never show a different endpoint than chat actually hits.
 */
export function resolveOllamaEndpoint(configuration: ProviderConfiguration): {
  url: string;
  headers: Record<string, string>;
  isNodeOverride: boolean;
} {
  const base =
    configuration.get<string>('ollamaBaseUrl', '') ||
    configuration.get<string>('ollamaUrl', DEFAULT_OLLAMA_URL) ||
    DEFAULT_OLLAMA_URL;
  const nodeRaw = configuration.get<string>('ollamaNodeUrl', '') ?? '';
  const node = typeof nodeRaw === 'string' ? nodeRaw.trim() : '';
  const rawUrl = node.length > 0 ? node : base;
  const url = (rawUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const headers = sanitizeOllamaHeaders(
    configuration.get<Record<string, string>>('ollamaHeaders', {}) || {}
  );
  return { url, headers, isNodeOverride: node.length > 0 };
}

function sanitizeOllamaHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof key !== 'string') {continue;}
    if (key.toLowerCase() === 'content-type') {continue;} // always forced to JSON
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}
