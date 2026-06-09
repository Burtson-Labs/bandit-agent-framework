/**
 * Preset registry for the `/connect` wizard.
 *
 * Each preset is a one-click pick that fills the openaiBaseUrl (and a
 * sensible default model id). Users can edit the values during the
 * wizard or pick "Custom" to type their own URL.
 *
 * Adding a new preset: append an entry below. The wizard renders them
 * in the order declared; keep local-first options at the top so users
 * starting their first session land on something private by default.
 */

export interface OpenAICompatiblePreset {
  /** Stable identifier — saved alongside the URL in case the wizard
   *  ever wants to re-pick the same preset. Not user-visible. */
  id: string;
  /** Human-readable label shown in the picker. */
  label: string;
  /** Default base URL. The wizard appends `/chat/completions` at
   *  request time; this should end at the API root (typically `/v1`). */
  baseUrl: string;
  /** Whether this provider needs an API key. Local servers usually
   *  don't; cloud providers always do. Drives the wizard's prompt. */
  requiresApiKey: boolean;
  /** Suggested default model id. Provider-specific naming — Together
   *  uses `meta-llama/...`, OpenRouter uses `openai/...`, LM Studio
   *  takes whatever you loaded. Pre-fills the model prompt; the user
   *  can override. */
  sampleModel?: string;
  /** Doc / API-key page URL surfaced when the user picks this preset
   *  and we ask for a key. Cuts the "where do I get the key" round
   *  trip. */
  docsUrl?: string;
  /** Optional one-liner shown after the preset is picked. Use for
   *  setup hints ("make sure LM Studio is running and a model is
   *  loaded") that aren't obvious from the URL alone. */
  hint?: string;
}

export const OPENAI_PRESETS: OpenAICompatiblePreset[] = [
  {
    id: 'lm-studio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false,
    sampleModel: 'qwen2.5-coder-32b-instruct',
    hint: 'Make sure LM Studio is running and a model is loaded.'
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp (local)',
    baseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
    sampleModel: 'qwen2.5-coder',
    hint: 'Default port 8080 for llama.cpp server. vLLM uses 8000 or whatever you started it on.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    sampleModel: 'gpt-4o',
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (300+ models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    sampleModel: 'anthropic/claude-sonnet-4',
    docsUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    requiresApiKey: true,
    sampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    docsUrl: 'https://api.together.xyz/settings/api-keys'
  },
  {
    id: 'groq',
    label: 'Groq (fast inference)',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    sampleModel: 'llama-3.3-70b-versatile',
    docsUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
    sampleModel: 'deepseek-coder',
    docsUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    sampleModel: 'grok-3',
    docsUrl: 'https://console.x.ai'
  },
  {
    id: 'custom',
    label: 'Custom URL',
    baseUrl: '',
    requiresApiKey: false
  }
];
