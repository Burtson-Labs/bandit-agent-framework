export type ProviderBackend = 'bandit' | 'openai' | 'azure-openai' | 'anthropic' | 'ollama' | 'xai';
export type ProviderType = ProviderBackend | 'gateway';

export interface AIMessageImageURL {
  url: string;
}

export type AIMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: AIMessageImageURL };

export type AIMessageContent = string | AIMessageContentPart[];

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: AIMessageContent;
}

/**
 * Ollama native tool schema — passed via the `tools` field of
 * /api/chat on models that advertise `supportsToolCalling: true`.
 * Shape matches Ollama's OpenAPI contract (itself a subset of
 * OpenAI's function-calling schema).
 */
export interface OllamaToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
}

export interface AIChatRequest {
  model: string;
  messages: AIMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  options?: Record<string, unknown>;
  images?: string[];
  /**
   * When populated AND the target model supports native tool calling,
   * Ollama will surface tool-call intents in a structured `tool_calls`
   * field on the response instead of free-text. The provider layer
   * translates those back into inline `<tool_call>{...}</tool_call>`
   * markup so the downstream ToolUseLoop parses them identically to
   * the text-based path. Saves ~1500-3000 tokens per turn because the
   * schemas no longer have to live in the system prompt.
   */
  tools?: OllamaToolSchema[];
  /**
   * Per-request chain-of-thought override for reasoning-capable models
   * (Qwen 3.x, DeepSeek R1). Ollama accepts `think` as a top-level
   * field (NOT nested under `options`). Precedence:
   *   - `true`  → force thinking ON for this request
   *   - `false` → force thinking OFF
   *   - `undefined` → fall back to the runtime default (off for
   *                   reasoning models, not sent for non-reasoning)
   * Hosts surface this via UI controls — the CLI `/think on|off|auto`
   * slash command or the extension's `banditStealth.thinkingMode`
   * setting. Most agent turns leave it undefined.
   */
  think?: boolean;
  /**
   * Cancels the request. On the direct Ollama provider aborting also stops
   * generation server-side (Ollama cancels on disconnect), so a host whose
   * watchdog gives up on a call — or a user pressing Esc — does not leave
   * the model generating behind the next request. Never serialized.
   */
  signal?: AbortSignal;
  /**
   * Idle window for a streamed reply, in ms (direct Ollama provider). Unset:
   * 300 s on native-tool streams, 90 s otherwise. A host that capped the
   * reply with `options.num_predict` can pass a longer window: the server
   * ends a capped reply by itself, so the guard only has to catch a hang and
   * must not cut a slow model that is still generating. Never serialized.
   */
  streamIdleMs?: number;
}

export interface AIChatResponse {
  message: {
    content: string;
    role: 'assistant';
    /**
     * Chain-of-thought reasoning emitted by models with thinking mode
     * on (Qwen 3.x, DeepSeek R1). Arrives as a separate field from
     * Ollama — kept out of `content` so the reasoning doesn't land in
     * the visible assistant transcript by default. Hosts render it in
     * a collapsed disclosure block or dimmed prefix line.
     */
    thinking?: string;
  };
  done?: boolean;
}

export interface AIGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}

export interface AIGenerateResponse {
  response: string;
  done?: boolean;
}

export interface AIModel {
  name: string;
  size?: number;
  details?: Record<string, unknown>;
  digest?: string;
  modified_at?: string;
}

export interface AIProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  apiVersion?: string;
  deploymentName?: string;
  gatewayUrl?: string;
  provider?: ProviderBackend;
  tokenFactory?: () => string | null;
}
