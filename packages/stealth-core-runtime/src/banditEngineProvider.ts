import type {
  AIChatRequest,
  AIChatResponse,
  AIMessageContent,
  AIMessageContentPart
} from './types/bandit';
import { resolveOllamaRuntimeOptions } from './runtime/modelCapabilities';
import {
  DEFAULT_STREAM_IDLE_MS,
  DEFAULT_STREAM_WARN_MS,
  readWithIdleTimeout
} from './streamIdleTimeout';

export interface ChatProvider {
  chat(request: AIChatRequest): AsyncIterable<AIChatResponse>;
}

export type ProviderKind = 'bandit' | 'ollama' | 'openai-compatible';

export interface ProviderSettings {
  kind: ProviderKind;
  apiKey?: string;
  apiUrl?: string;
  /** Primary Ollama endpoint — local Mac (localhost:11434) or LAN. Never RunPod. */
  ollamaUrl?: string;
  /** Secondary Ollama endpoint — e.g. RTX 5090 node. Used when set, overrides ollamaUrl for Ollama requests. */
  ollamaNodeUrl?: string;
  ollamaModel?: string;
  /**
   * Extra HTTP headers sent on every Ollama request. Use this to target a
   * reverse-proxied / authenticated Ollama instance (Bearer token, basic auth,
   * Cloudflare Access headers, etc.). Content-Type is always forced to
   * application/json and cannot be overridden here.
   */
  ollamaHeaders?: Record<string, string>;
  /**
   * OpenAI-compatible base URL — e.g. `http://localhost:1234/v1` (LM Studio),
   * `http://localhost:8080/v1` (llama.cpp / vLLM), `https://api.together.xyz/v1`,
   * `https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1`,
   * `https://api.deepseek.com/v1`, `https://api.openai.com/v1`. The provider
   * appends `/chat/completions`. Required when `kind === 'openai-compatible'`.
   */
  openaiBaseUrl?: string;
  /** Bearer API key for the openai-compatible endpoint. Optional for local
   * servers (LM Studio, llama.cpp) which usually don't require auth. */
  openaiApiKey?: string;
  /** Model id to send. User-provided since each upstream uses its own naming —
   * e.g. `meta-llama/Llama-3.3-70B-Instruct-Turbo` (Together),
   * `openai/gpt-4o` (OpenRouter), `qwen2.5-coder-32b` (LM Studio local). */
  openaiModel?: string;
  /** Extra HTTP headers — e.g. `HTTP-Referer` + `X-Title` for OpenRouter
   * attribution, custom org headers, etc. Content-Type is always forced. */
  openaiHeaders?: Record<string, string>;
}

const DEFAULT_BANDIT_COMPLETIONS_URL = 'https://api.burtson.ai/completions';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma4:12b';

/** Control tokens emitted by Gemma3, Llama, and other local models that must be stripped. */
const CONTROL_TOKEN_PATTERNS = [
  /<\/?end_of_turn>/g,
  /<\/?start_of_turn>/g,
  /<\|eot_id\|>/g,
  /<\|start_header_id\|>/g,
  /<\|end_header_id\|>/g,
  /<\|begin_of_text\|>/g,
  /\[INST\]/g,
  /\[\/INST\]/g,
  /<<SYS>>/g,
  /<\/SYS>>/g,
];

function sanitizeOllamaOutput(text: string): string {
  // NOTE: called per streamed chunk — do NOT trim here. Word-break whitespace
  // lives on chunk boundaries ("Hello", " world"); trimming each chunk
  // collapses them into "Helloworld". Only control tokens are removed.
  let result = text;
  for (const pattern of CONTROL_TOKEN_PATTERNS) {
    result = result.replace(pattern, '');
  }
  result = stripBase64BlobsInline(result);
  return result;
}

/**
 * Stream-safe base64 blob stripper. A single streamed chunk may contain
 * the start of a base64 blob; replacing the partial contents would make
 * the blob detectable again when the next chunk arrives. We only strip
 * when we can prove the blob is fully contained in the current chunk
 * (bounded by whitespace or string edges). Partial blobs pass through
 * and the next chunk's sanitizer catches them when the whitespace hits.
 *
 * In practice, multimodal echos from the gateway arrive in a small
 * number of large chunks so the full-blob case is the common one.
 */
function stripBase64BlobsInline(text: string): string {
  const BLOB = /(?:data:[\w/.+-]+;base64,)?[A-Za-z0-9+/]{120,}={0,2}/g;
  return text.replace(BLOB, (match) => `[base64 stripped: ${match.length} chars]`);
}

/**
 * Returns true if the request looks like a plan-generation call that needs
 * structured JSON output. This is intentionally conservative to avoid forcing
 * JSON mode for normal conversational replies.
 */
function detectJsonRequest(request: AIChatRequest): boolean {
  const getLowerText = (content: AIMessageContent): string => {
    const text = typeof content === 'string'
      ? content
      : content.map(p => p.type === 'text' ? p.text : '').join(' ');
    return text.toLowerCase();
  };

  const systemText = request.messages
    .filter(message => message.role === 'system')
    .map(message => getLowerText(message.content))
    .join('\n');

  const lastUserText = [...request.messages]
    .reverse()
    .find(message => message.role === 'user');

  const combined = `${systemText}\n${lastUserText ? getLowerText(lastUserText.content) : ''}`;
  const hasJsonDirective =
    /\b(respond with json(?: only)?|return (?:valid )?json|output (?:valid )?json|json only|format\s*[:=]\s*"?json"?|strictly json)\b/.test(combined);
  if (!hasJsonDirective) {
    return false;
  }

  const hasPlanSignal =
    /\b(plan|planning|steps?)\b|execution plan|agent plan|schema|"steps"|"id"|"title"|"description"/.test(combined);
  return hasPlanSignal;
}

function splitMessageContent(content: AIMessageContent | undefined): { text: string; imageUrls: string[] } {
  if (typeof content === 'string') {
    return { text: content, imageUrls: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', imageUrls: [] };
  }
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  for (const part of content) {
    if (!part) {
      continue;
    }
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : part.text != null ? String(part.text) : '';
      if (text.length > 0) {
        textParts.push(text);
      }
      continue;
    }
    if (part.type === 'image_url') {
      const url = extractImageUrl(part);
      if (url) {
        imageUrls.push(url);
      }
    }
  }
  return {
    text: textParts.join('\n'),
    imageUrls: dedupeStrings(imageUrls)
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeOllamaImage(candidate: string | undefined): string | undefined {
  const normalized = normalizeImageUrl(candidate);
  if (!normalized) {
    return undefined;
  }
  if (/^https?:/i.test(normalized)) {
    return undefined;
  }
  if (!/^data:/i.test(normalized)) {
    return normalized;
  }
  const commaIndex = normalized.indexOf(',');
  if (commaIndex < 0 || commaIndex === normalized.length - 1) {
    return undefined;
  }
  return normalized.slice(commaIndex + 1).trim();
}

export function normalizeOllamaMessages(request: AIChatRequest): Array<{ role: string; content: string; images?: string[] }> {
  const normalizedMessages = request.messages.map((message) => {
    const { text, imageUrls } = splitMessageContent((message as { content?: AIMessageContent }).content);
    const images = imageUrls
      .map((url) => normalizeOllamaImage(url))
      .filter((image): image is string => Boolean(image));
    if (images.length > 0) {
      return { role: message.role, content: text, images };
    }
    return { role: message.role, content: text };
  });

  const requestImages = (Array.isArray(request.images) ? request.images : [])
    .map((image) => normalizeOllamaImage(image))
    .filter((image): image is string => Boolean(image));

  if (requestImages.length === 0) {
    return normalizedMessages;
  }

  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    if (normalizedMessages[index]?.role !== 'user') {
      continue;
    }
    const existing = normalizedMessages[index].images ?? [];
    normalizedMessages[index].images = dedupeStrings([...existing, ...requestImages]);
    return normalizedMessages;
  }

  normalizedMessages.push({
    role: 'user',
    content: '',
    images: requestImages
  });
  return normalizedMessages;
}

function collectBanditPayloadImages(request: AIChatRequest): string[] {
  const requestImages = (Array.isArray(request.images) ? request.images : [])
    .map((image) => normalizeImageUrl(image))
    .filter((image): image is string => Boolean(image));

  const lastUserMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user');
  const messageImages = lastUserMessage
    ? splitMessageContent((lastUserMessage as { content?: AIMessageContent }).content).imageUrls
    : [];

  return dedupeStrings([...requestImages, ...messageImages]);
}

interface OllamaChatChunk {
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
}

async function* streamOllamaResponse(response: Response): AsyncGenerator<AIChatResponse> {
  const body = response.body;
  if (!body) {throw new Error('Ollama response has no body.');}

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stallWarned = false;

  for (;;) {
    const { value, done } = await readWithIdleTimeout(reader, {
      idleMs: DEFAULT_STREAM_IDLE_MS,
      warnAfterMs: DEFAULT_STREAM_WARN_MS,
      abortLabel: 'Ollama stream',
      onWarn: (elapsedMs) => {
        if (stallWarned) {return;}
        stallWarned = true;
        console.warn(`[banditEngineProvider] Ollama stream went quiet at ${elapsedMs}ms — still waiting…`);
      }
    });
    if (done) {break;}
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {continue;}
      try {
        const chunk = JSON.parse(trimmed) as OllamaChatChunk;
        const content = sanitizeOllamaOutput(chunk.message?.content ?? '');
        const thinking = chunk.message?.thinking;
        if (content || thinking) {
          yield {
            message: {
              content,
              role: 'assistant',
              ...(thinking ? { thinking } : {})
            },
            done: false
          };
        }
        if (chunk.done) {
          yield { message: { content: '', role: 'assistant' }, done: true };
          return;
        }
      } catch {
        // skip malformed lines
      }
    }
  }
  yield { message: { content: '', role: 'assistant' }, done: true };
}

/**
 * Actionable suffix for an Ollama error, by failure mode:
 *  - 403 with a subscription/upgrade message = a paid-plan gate (e.g. Kimi
 *    K2 on Ollama Cloud), NOT a sign-in problem — point at the upgrade page
 *    and a free local fallback. (Real run 2026-06-17: kimi-k2.7-code:cloud
 *    403'd with "this model requires a subscription".)
 *  - any other 401/403 on a cloud model = a sign-in / cloud-key problem.
 * Cloud tags come in both shapes — `-cloud` (`kimi-k2:1t-cloud`) and `:cloud`
 * (`kimi-k2.7-code:cloud`) — or the baseUrl points at ollama.com.
 */
export function buildOllamaErrorHint(status: number, model: string, baseUrl: string, detail: string): string {
  if (status === 403 && /subscription|upgrade for access|ollama\.com\/upgrade/i.test(detail)) {
    return ' — this Ollama Cloud model requires a paid Ollama plan. Upgrade at https://ollama.com/upgrade, or try a local model (e.g. `qwen3.6:27b`, `gemma4:26b`) which needs no subscription.';
  }
  const looksCloud = /[-:]cloud\b/i.test(model) || /ollama\.com/i.test(baseUrl);
  if ((status === 401 || status === 403) && looksCloud) {
    return ' — this is an Ollama Cloud model. Run `ollama signin` (local daemon), or set an Ollama Cloud API key as the Authorization header (CLI: `ollama.headers`, extension: the Ollama auth-token field).';
  }
  return '';
}

function createDirectOllamaProvider(
  baseUrl: string,
  defaultModel: string,
  extraHeaders?: Record<string, string>
): ChatProvider {
  // Caller-supplied headers (Authorization, Cloudflare Access, etc.) are
  // merged once here; Content-Type always wins to avoid breaking the API.
  const mergedHeaders: Record<string, string> = {
    ...(extraHeaders ?? {}),
    'Content-Type': 'application/json'
  };
  return {
    chat(request: AIChatRequest): AsyncIterable<AIChatResponse> {
      const iterator = async function* (): AsyncGenerator<AIChatResponse> {
        const model = request.model || defaultModel;
        const wantsJson = detectJsonRequest(request);

        // Tier-derived defaults for num_ctx + keep_alive. Without these
        // Ollama falls back to a 2048-token chat window — too small for
        // our agent system prompt (~3-4k tokens) plus tool results, so
        // the framework framing gets sheared off and the model replies
        // from its raw conversational persona. Caller-supplied
        // request.options override these per-request (so tests / power
        // users can still opt out or up the window).
        const runtimeDefaults = resolveOllamaRuntimeOptions(model);
        const payload: Record<string, unknown> = {
          model,
          messages: normalizeOllamaMessages(request),
          stream: request.stream !== false,
          keep_alive: runtimeDefaults.keep_alive,
          options: {
            temperature: request.temperature ?? 0.2,
            num_ctx: runtimeDefaults.num_ctx,
            ...(request.options ?? {})
          }
        };

        // `think` is a top-level request field in Ollama, not nested
        // under `options` (Ollama rejects `PARAMETER think` in Modelfiles
        // — it's a per-request toggle only). Reasoning-capable models
        // like Qwen 3.6 ship thinking ON by default; for agent tool-use
        // we disable it via resolveOllamaRuntimeOptions to save the
        // 8-30s thinking preamble per turn. Per-request `request.think`
        // (explicitly passed by the host for `/think on` / extension
        // setting overrides) wins over the runtime default.
        if (request.think !== undefined) {
          payload.think = request.think;
        } else if (runtimeDefaults.think !== undefined) {
          payload.think = runtimeDefaults.think;
        }

        if (wantsJson) {
          payload.format = 'json';
        }

        // Native tool calling: when the caller provides `tools`, pass
        // them through to Ollama so the model's chat template serializes
        // the schemas efficiently (30-50% fewer tokens than our text
        // XML block). Streaming is DISABLED for native-tools requests
        // because Ollama's streaming path currently emits tool_calls
        // only on the terminal chunk and interleaving that with partial
        // content makes the downstream translator brittle. Non-native
        // requests keep streaming as before.
        const hasNativeTools = Array.isArray(request.tools) && request.tools.length > 0;
        if (hasNativeTools) {
          payload.tools = request.tools;
          payload.stream = false;
        }

        const response = await fetchWithRetry(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: mergedHeaders,
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const detail = await safeReadText(response);
          const hint = buildOllamaErrorHint(response.status, request.model, baseUrl, detail);
          throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}${hint}`);
        }

        if (payload.stream !== false) {
          yield* streamOllamaResponse(response);
        } else {
          const data = await response.json() as OllamaChatChunk & {
            message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
          };
          let content = sanitizeOllamaOutput(data.message?.content ?? '');
          // Translate Ollama's native tool_calls into inline text
          // markup so the ToolUseLoop's existing parseToolCalls()
          // picks them up without any downstream change. Each call
          // becomes one `<tool_call>{...}</tool_call>` block appended
          // to the response text.
          const toolCalls = data.message?.tool_calls;
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            const markers = toolCalls.map(tc => {
              const name = tc.function?.name ?? '';
              const args = tc.function?.arguments ?? {};
              // Ollama returns arguments as an already-parsed object;
              // stringify to match the wire format our parser expects.
              // Stringify values to strings — ToolRegistry schemas
              // declare every param as type: 'string' and our tools
              // read String(params.path), etc.
              const params: Record<string, string> = {};
              if (args && typeof args === 'object') {
                for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
                  params[k] = typeof v === 'string' ? v : JSON.stringify(v);
                }
              }
              return `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
            }).join('\n');
            content = content ? `${content}\n${markers}` : markers;
          }
          yield { message: { content, role: 'assistant' }, done: true };
        }
      };
      return iterator();
    }
  };
}

export async function createProvider(settings: ProviderSettings): Promise<ChatProvider> {
  if (settings.kind === 'bandit') {
    const apiUrl = normalizeBanditApiUrl(settings.apiUrl);
    const apiKey = settings.apiKey?.trim();
    return createDirectBanditProvider(apiUrl, apiKey);
  }

  if (settings.kind === 'ollama') {
    // Use node URL (RTX 5090) if configured, otherwise fall back to local Ollama
    const rawUrl = settings.ollamaNodeUrl?.trim()
      ? settings.ollamaNodeUrl.trim()
      : settings.ollamaUrl;
    const baseUrl = normalizeUrl(rawUrl, DEFAULT_OLLAMA_URL);
    const model = settings.ollamaModel?.trim() || DEFAULT_OLLAMA_MODEL;
    return createDirectOllamaProvider(baseUrl, model, settings.ollamaHeaders);
  }

  if (settings.kind === 'openai-compatible') {
    const rawBase = settings.openaiBaseUrl?.trim();
    if (!rawBase) {
      throw new Error('openai-compatible provider requires `openaiBaseUrl` (e.g. http://localhost:1234/v1, https://api.together.xyz/v1).');
    }
    const baseUrl = rawBase.replace(/\/+$/, '');
    const apiUrl = `${baseUrl}/chat/completions`;
    const apiKey = settings.openaiApiKey?.trim();
    return createDirectOpenAICompatibleProvider(apiUrl, apiKey, settings.openaiHeaders);
  }

  throw new Error(`Unsupported provider kind: ${settings.kind}`);
}

/**
 * Generic OpenAI-compatible chat provider.
 *
 * Reuses the same payload shape and SSE streaming helpers as the Bandit
 * gateway path — every endpoint we care about (LM Studio, llama.cpp,
 * vLLM, OpenAI, OpenRouter, Together, Groq, DeepSeek, xAI) speaks the
 * `POST /v1/chat/completions` shape with `data: {…}` SSE chunks. The
 * Bandit-specific bits (`X-Bandit-Source`/`X-Skip-Seed-Pack` headers,
 * 429 rate-limit special-case JSON parsing) are intentionally NOT
 * forwarded here — those are gateway-specific. Errors fall through to a
 * generic message so the host shows the upstream provider's actual
 * status text.
 */
function createDirectOpenAICompatibleProvider(
  apiUrl: string,
  apiKey: string | undefined,
  extraHeaders: Record<string, string> | undefined
): ChatProvider {
  return {
    chat(request: AIChatRequest): AsyncIterable<AIChatResponse> {
      const controller = new AbortController();
      const iterator = async function* (): AsyncGenerator<AIChatResponse> {
        try {
          const payload = serializeBanditPayload(request, { strictOpenAI: true });
          const response = await fetchWithRetry(apiUrl, {
            method: 'POST',
            headers: buildOpenAICompatibleHeaders(apiKey, extraHeaders),
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          if (!response.ok) {
            const detail = await safeReadText(response);
            throw new Error(`openai-compatible request failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
          }
          if (payload.stream) {
            yield* streamBanditResponse(response);
          } else {
            const data = (await response.json()) as BanditResponseBody;
            if (data.error?.message) {
              throw new Error(data.error.message);
            }
            const text = extractTextFromBanditResponse(data);
            const thinking = typeof data.choices?.[0]?.message?.thinking === 'string'
              ? data.choices[0].message.thinking
              : undefined;
            yield {
              message: {
                content: text,
                role: 'assistant',
                ...(thinking ? { thinking } : {})
              },
              done: true
            };
          }
        } finally {
          controller.abort();
        }
      };
      return iterator();
    }
  };
}

function buildOpenAICompatibleHeaders(
  apiKey: string | undefined,
  extra: Record<string, string> | undefined
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {headers.Authorization = `Bearer ${apiKey}`;}
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!key || typeof key !== 'string' || typeof value !== 'string') {continue;}
      if (key.toLowerCase() === 'content-type') {continue;}
      headers[key] = value;
    }
  }
  return headers;
}

function createDirectBanditProvider(apiUrl: string, apiKey: string | undefined): ChatProvider {
  return {
    chat(request: AIChatRequest): AsyncIterable<AIChatResponse> {
      const controller = new AbortController();

      const iterator = async function* (): AsyncGenerator<AIChatResponse> {
        try {
          const payload = serializeBanditPayload(request);
          // (Multimodal debug dump removed — it was writing the full
          // base64 image payload to stderr on every image turn, which
          // leaked into users' terminals and looked like 100KB of
          // gibberish before the actual response arrived.)
          const response = await fetchWithRetry(apiUrl, {
            method: 'POST',
            headers: buildHeaders(apiKey),
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          if (!response.ok) {
            const detail = await safeReadText(response);
            // Special-case 429 (rate limit). Parse the JSON body so the
            // host can relay the window/resetsAt details to the user
            // instead of just showing a generic "request failed." The
            // thrown Error name is inspected by the host to toast
            // differently for rate limits vs generic failures.
            if (response.status === 429) {
              let rateMessage = 'Rate limit reached. Email team@burtson.ai to upgrade.';
              let window = 'session';
              let resetsAtUnix: number | undefined;
              try {
                const parsed = JSON.parse(detail) as {
                  message?: string;
                  window?: string;
                  resetsAtUnix?: number;
                };
                if (parsed?.message) {rateMessage = parsed.message;}
                if (parsed?.window) {window = parsed.window;}
                if (typeof parsed?.resetsAtUnix === 'number') {resetsAtUnix = parsed.resetsAtUnix;}
              } catch {
                // Non-JSON 429 body — fall through with defaults.
              }
              const err = new Error(rateMessage) as Error & {
                isRateLimit?: boolean;
                window?: string;
                resetsAtUnix?: number;
              };
              err.isRateLimit = true;
              err.window = window;
              err.resetsAtUnix = resetsAtUnix;
              throw err;
            }
            throw new Error(`Bandit request failed: ${response.status} ${response.statusText}${detail ? ` – ${detail}` : ''}`);
          }

          // Gateway-side workaround signal — when the Ollama 0.24.0 qwen3.5
          // parser 500s on bandit-logic, the gateway retries upstream with
          // tools[] stripped and sets this header. The retry succeeded if we
          // got here; just surface the fact so traces show how often the
          // upstream parser bug is firing. Remove this log once the upstream
          // qwen3.6 parser ships and the gateway workaround is reverted.
          if (response.headers.get('x-upstream-retry-without-tools') === 'true') {
            console.warn('[banditEngineProvider] gateway stripped tools[] this turn (qwen3.6 parser workaround).');
          }

          if (payload.stream) {
            yield* streamBanditResponse(response);
          } else {
            const data = (await response.json()) as BanditResponseBody;
            if (data.error?.message) {
              throw new Error(data.error.message);
            }
            const text = extractTextFromBanditResponse(data);
            const thinking = typeof data.choices?.[0]?.message?.thinking === 'string'
              ? data.choices[0].message.thinking
              : undefined;
            yield {
              message: {
                content: text,
                role: 'assistant',
                ...(thinking ? { thinking } : {})
              },
              done: true
            };
          }
        } finally {
          controller.abort();
        }
      };

      return iterator();
    }
  };
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Agent framework requests carry structured tool-call escape rules in
    // the system prompt. Injecting an additional RAG system message at the
    // gateway dilutes those instructions and causes malformed JSON on long
    // content strings (verified root cause — see v1.5.24 changelog).
    // The gateway's SeedPackContextService should short-circuit when this
    // header is present.
    'X-Bandit-Source': 'agent-framework',
    'X-Skip-Seed-Pack': 'true'
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

type BanditMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type BanditMessageContent = BanditMessageContentPart[];

export function serializeBanditPayload(request: AIChatRequest, opts?: { strictOpenAI?: boolean }) {
  const payloadImages = collectBanditPayloadImages(request);
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: normalizeBanditMessageContent((message as { content?: AIMessageContent }).content)
  }));
  // Promote top-level `request.images` onto the last user message as
  // content parts. The tool-use adapter (extension.ts) attaches
  // images via `request.images` since ToolLoopMessage is a plain
  // { role, content: string } — it has no notion of content parts.
  // Without this splice, the Bandit gateway (OpenAI-compatible)
  // reads message.content only and the image silently never reaches
  // the model. Ollama's normalizeOllamaMessages does the equivalent
  // splice onto message.images; this is the symmetric fix for the
  // hosted path.
  if (payloadImages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') {continue;}
      const existingUrls = new Set(
        messages[i].content
          .filter((part): part is { type: 'image_url'; image_url: { url: string } } => part.type === 'image_url')
          .map((part) => part.image_url.url)
      );
      for (const url of payloadImages) {
        if (!existingUrls.has(url)) {
          messages[i].content.push({ type: 'image_url', image_url: { url } });
        }
      }
      break;
    }
  }
  const payload: Record<string, unknown> = {
    model: request.model,
    messages,
    temperature: request.temperature,
    top_p: typeof request.options?.top_p === 'number' ? request.options.top_p : undefined,
    stream: request.stream !== false
  };
  // Forward native tool-calling schemas on the cloud path. The
  // Gateway's BuildOllamaRequestPayloadAsync lets unknown top-level
  // keys flow through via AdditionalProperties, so `tools` reaches
  // the upstream Ollama /api/chat and the model gets structured tool
  // calling. Without this, bandit-logic (Qwen 2.5 Coder) had neither
  // the text-prompt tool block (skipped when nativeTools=true) NOR
  // the native tools field, and emitted bare JSON tool-call prose
  // that the downstream parser couldn't extract.
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    payload.tools = request.tools;
    // Ollama streams tool_calls only on the terminal chunk for native
    // tool calling — disable streaming for these requests so the
    // provider's non-streaming translator (see ollama path at ~line
    // 334) can pair tool_calls back to inline <tool_call> markup.
    payload.stream = false;
  }
  // Strict OpenAI-compatible servers (some vLLM/TGI builds) 400 on
  // unknown top-level body fields — `think` and bare `images` are
  // Ollama/gateway extensions, so omit them on that path. Images are
  // already delivered as image_url content parts in the messages.
  if (opts?.strictOpenAI) {
    return payload;
  }
  // Keep the top-level images field too for backward compat with any
  // consumer that has been reading them there historically.
  if (payloadImages.length > 0) {
    payload.images = payloadImages;
  }
  // Forward the thinking override to the gateway. Symmetric to the
  // direct Ollama path — per-request `think` overrides runtime
  // defaults, and AdditionalProperties pass-through on the gateway
  // side means it reaches upstream Ollama as a top-level field.
  if (request.think !== undefined) {
    payload.think = request.think;
  } else {
    const runtimeDefaults = resolveOllamaRuntimeOptions(request.model);
    if (runtimeDefaults.think !== undefined) {
      payload.think = runtimeDefaults.think;
    }
  }
  return payload;
}

function normalizeBanditMessageContent(content: AIMessageContent | undefined): BanditMessageContent {
  if (Array.isArray(content)) {
    const normalized: BanditMessageContentPart[] = [];
    for (const part of content) {
      if (!part) {
        continue;
      }
      if (part.type === 'text') {
        const text = typeof part.text === 'string' ? part.text : part.text != null ? String(part.text) : '';
        if (text.length > 0) {
          normalized.push({ type: 'text', text });
        }
        continue;
      }
      if (part.type === 'image_url') {
        const url = extractImageUrl(part);
        if (url) {
          normalized.push({ type: 'image_url', image_url: { url } });
        }
      }
    }
    if (normalized.length > 0) {
      return normalized;
    }
  }

  const text = typeof content === 'string' ? content : content != null ? String(content) : '';
  return [{ type: 'text', text }];
}

function extractImageUrl(part: AIMessageContentPart): string | undefined {
  if (!part || part.type !== 'image_url') {
    return undefined;
  }
  const imageField = part.image_url as { url?: string } | string | undefined;
  if (typeof imageField === 'string') {
    return normalizeImageUrl(imageField);
  }
  if (imageField && typeof imageField.url === 'string') {
    return normalizeImageUrl(imageField.url);
  }
  return undefined;
}

function normalizeImageUrl(candidate: string | undefined): string | undefined {
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^data:/i.test(trimmed) || /^https?:/i.test(trimmed)) {
    return trimmed;
  }
  return `data:image/png;base64,${trimmed}`;
}

function extractTextFromBanditResponse(response: BanditResponseBody): string {
  const [firstChoice] = response.choices ?? [];
  if (!firstChoice) {
    throw new Error('Bandit response missing choices.');
  }

  if (firstChoice.text) {
    return firstChoice.text;
  }

  const message = firstChoice.message as (typeof firstChoice.message) & {
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  if (!message) {
    throw new Error('Bandit response missing message content.');
  }

  // Native tool-call translation for the cloud path. When the gateway
  // forwarded a `tools` field, Ollama upstream returns `tool_calls` on
  // the terminal message. We translate each call into inline
  // `<tool_call>{"name":...,"params":{...}}</tool_call>` markup so the
  // ToolUseLoop's existing parser picks them up unchanged — same
  // contract the direct-Ollama path uses at line ~358.
  //
  // `arguments` arrives as either:
  // - a JSON STRING (OpenAI-compat convention — what our gateway
  // emits, what any OpenAI SDK client expects)
  // - an object (Ollama's native shape, passed through if the
  // gateway wasn't the translator)
  // Handle both so the cloud and direct-Ollama paths stay symmetric.
  let toolCallMarkup = '';
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const markers = toolCalls.map(tc => {
      const name = tc.function?.name ?? '';
      let args: unknown = tc.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const params: Record<string, string> = {};
      if (args && typeof args === 'object') {
        for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
          params[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
      return `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
    });
    toolCallMarkup = markers.join('\n');
  }

  let baseText = '';
  if (typeof message.content === 'string') {
    baseText = message.content;
  } else if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '');
    baseText = parts.join('\n\n');
  }

  if (!baseText && !toolCallMarkup) {
    // Soft-fail with forensics. The previous behaviour (throw) bubbled
    // up to the user as a hard error mid-conversation when the gateway
    // emitted an unusual response shape — a `tool_calls`-only response
    // where the gateway dropped the array, a `thinking`-only response,
    // a content-parts array with no text blocks, etc. The tool-use loop
    // already has an empty-response retry path that handles "" cleanly,
    // so returning empty here lets the model recover on its own turn
    // instead of crashing the whole run.
    //
    // The console warn captures the full message shape for the next
    // diagnostic pass — without this we have no idea what the gateway
    // actually sent. Truncated to 500 chars so a runaway response
    // doesn't flood the log.
    try {
      const shape = JSON.stringify(message).slice(0, 500);
      console.warn(`[banditEngineProvider] empty response from gateway, soft-recovering. shape=${shape}`);
    } catch {
      console.warn('[banditEngineProvider] empty response from gateway, soft-recovering. (shape unserializable)');
    }
    return '';
  }

  return toolCallMarkup
    ? (baseText ? `${baseText}\n${toolCallMarkup}` : toolCallMarkup)
    : baseText;
}

function normalizeBanditApiUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_BANDIT_COMPLETIONS_URL;
  }
  const stripped = trimmed.replace(/\/+$/, '');
  // If the user gave only a base URL (no path beyond "/"), auto-append the
  // standard `/completions` endpoint. Anyone with a real custom path keeps
  // it untouched. Covers the common "they set apiUrl to their host" case.
  try {
    const parsed = new URL(stripped);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${stripped}/completions`;
    }
  } catch {
    // Not a valid URL — let the fetch call surface the error itself.
  }
  return stripped;
}

function normalizeUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.replace(/\/+$/, '') : fallback;
}

interface BanditResponseBody {
  choices?: Array<{
    text?: string;
    message?: {
      role?: string;
      content?: string | Array<{ type: string; text?: string }>;
      /** Chain-of-thought reasoning forwarded by the gateway from Ollama
       * (message.thinking) for reasoning-capable models. Separate from
       * content so hosts can render it in a collapsed disclosure block. */
      thinking?: string;
      /** Native tool calls forwarded by the gateway from Ollama's
       * upstream message.tool_calls. OpenAI-compat shape:
       * { id, type:"function", function: { name, arguments } }
       * where `arguments` is a JSON STRING per the OpenAI protocol.
       * gateway was dropping these silently so
       * bandit-logic appeared to "refuse" to call tools even though
       * Ollama was emitting valid tool_calls upstream. */
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: unknown };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface BanditStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      role?: string;
      /** Chain-of-thought streamed alongside content deltas. Gateway
       * emits this under delta.thinking (mirrors Ollama's message.thinking
       * field from upstream). */
      thinking?: string;
    };
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      thinking?: string;
    };
    text?: string;
    finish_reason?: string | null;
  }>;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    thinking?: string;
  };
  response?: string;
  done?: boolean;
  done_reason?: string | null;
  error?: {
    message?: string;
  } | string;
}

async function* streamBanditResponse(response: Response): AsyncGenerator<AIChatResponse> {
  const body = response.body;
  if (!body) {
    throw new Error('Bandit response did not include a readable stream.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emittedDone = false;

  const readChunkText = (chunk: BanditStreamChunk): string => {
    const readContent = (
      content: string | Array<{ type?: string; text?: string }> | undefined
    ): string => {
      if (!content) {
        return '';
      }
      if (typeof content === 'string') {
        return content;
      }
      if (!Array.isArray(content)) {
        return '';
      }
      return content
        .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
        .filter((part) => part.length > 0)
        .join('');
    };

    const choice = chunk.choices?.[0];
    const fromDelta = readContent(choice?.delta?.content);
    if (fromDelta) {
      return fromDelta;
    }

    const fromChoiceMessage = readContent(choice?.message?.content);
    if (fromChoiceMessage) {
      return fromChoiceMessage;
    }

    const fromChoiceText = typeof choice?.text === 'string' ? choice.text : '';
    if (fromChoiceText) {
      return fromChoiceText;
    }

    const fromMessage = readContent(chunk.message?.content);
    if (fromMessage) {
      return fromMessage;
    }

    return typeof chunk.response === 'string' ? chunk.response : '';
  };

  /** Extract chain-of-thought reasoning from any of the standard
   * positions the gateway might emit it — delta.thinking (streaming
   * OpenAI-compat), message.thinking (non-streaming fallback), or the
   * top-level message.thinking (direct Ollama pass-through). */
  const readChunkThinking = (chunk: BanditStreamChunk): string => {
    const choice = chunk.choices?.[0];
    const fromDelta = typeof choice?.delta?.thinking === 'string' ? choice.delta.thinking : '';
    if (fromDelta) {
      return fromDelta;
    }
    const fromChoiceMessage = typeof choice?.message?.thinking === 'string' ? choice.message.thinking : '';
    if (fromChoiceMessage) {
      return fromChoiceMessage;
    }
    return typeof chunk.message?.thinking === 'string' ? chunk.message.thinking : '';
  };

  const isDoneChunk = (chunk: BanditStreamChunk): boolean => {
    if (chunk.done === true) {
      return true;
    }
    const finishReason = chunk.choices?.[0]?.finish_reason;
    return typeof finishReason === 'string' && finishReason.length > 0;
  };

  const parseLine = (
    rawLine: string
  ): { done: boolean; responses: AIChatResponse[]; error?: Error } => {
    const line = rawLine.trim();
    if (!line || line.startsWith('event:')) {
      return { done: false, responses: [] };
    }

    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload) {
      return { done: false, responses: [] };
    }

    if (payload === '[DONE]') {
      const responses: AIChatResponse[] = [];
      if (!emittedDone) {
        emittedDone = true;
        responses.push({ message: { content: '', role: 'assistant' }, done: true });
      }
      return { done: true, responses };
    }

    try {
      const chunk = JSON.parse(payload) as BanditStreamChunk;
      const responses: AIChatResponse[] = [];
      const errorMessage = typeof chunk.error === 'string'
        ? chunk.error
        : chunk.error?.message;
      if (errorMessage) {
        return {
          done: true,
          responses,
          error: new Error(errorMessage)
        };
      }

      const text = stripBase64BlobsInline(readChunkText(chunk));
      const thinking = readChunkThinking(chunk);
      if (text || thinking) {
        responses.push({
          message: {
            content: text,
            role: 'assistant',
            ...(thinking ? { thinking } : {})
          },
          done: false
        });
      }

      if (isDoneChunk(chunk)) {
        if (!emittedDone) {
          emittedDone = true;
          responses.push({ message: { content: '', role: 'assistant' }, done: true });
        }
        return { done: true, responses };
      }
      return { done: false, responses };
    } catch {
      // Ignore malformed keep-alive or non-JSON lines and continue streaming.
      return { done: false, responses: [] };
    }
  };

  // Stream until the reader indicates completion.
  let stallWarned = false;
  for (;;) {
    const { value, done } = await readWithIdleTimeout(reader, {
      idleMs: DEFAULT_STREAM_IDLE_MS,
      warnAfterMs: DEFAULT_STREAM_WARN_MS,
      abortLabel: 'Bandit stream',
      onWarn: (elapsedMs) => {
        if (stallWarned) {return;}
        stallWarned = true;
        console.warn(`[banditEngineProvider] Bandit stream went quiet at ${elapsedMs}ms — still waiting…`);
      }
    });
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    const lines = buffer.split('\n');
    if (done) {
      buffer = '';
    } else {
      buffer = lines.pop() ?? '';
    }

    for (const rawLine of lines) {
      const parsed = parseLine(rawLine);
      if (parsed.error) {
        throw parsed.error;
      }
      for (const responseChunk of parsed.responses) {
        yield responseChunk;
      }
      if (parsed.done) {
        return;
      }
    }

    if (done) {
      break;
    }
  }

  if (!emittedDone) {
    yield { message: { content: '', role: 'assistant' }, done: true };
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Fetch with retry on transient gateway/network failures. Retries on 5xx
 * status (502/503/504 are the gateway's typical "upstream had a hiccup"
 * codes; 500 from the bandit cloud has been observed once in a session
 * after a long compaction-heavy turn) and on transient network errors
 * (ECONNREFUSED, socket hang up, fetch-failed). Does NOT retry on:
 * - AbortError — the caller cancelled (Esc / signal); honour that.
 * - 429 — rate limited; the caller has its own special-case handling.
 * - 4xx — request-shape problems won't get better by replaying.
 *
 * Backoff is exponential (500ms, 1s, 2s) to a max of 3 retries. The
 * bandit auto-evaluation turn that died with `Bandit request failed: 500
 * Internal Server Error` after compacting 19 messages on iteration 7
 * (2026-05-06 22:24Z) would have survived a single retry — same applies
 * to the "1 failed" subagent, which loses its LLM call to the same kind
 * of transient gateway 5xx.
 */
async function fetchWithRetry(
  apiUrl: string,
  init: RequestInit,
  opts?: { retries?: number; baseMs?: number }
): Promise<Response> {
  const retries = opts?.retries ?? 3;
  const baseMs = opts?.baseMs ?? 500;
  const transientNetworkRe = /fetch failed|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(apiUrl, init);
      if (response.status >= 500 && response.status <= 599) {
        if (attempt < retries) {
          // Drain and discard the body so the connection can be reused
          // by the next attempt; otherwise fetch may keep it pinned.
          try { await response.body?.cancel(); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt)));
          continue;
        }
      }
      return response;
    } catch (err) {
      // AbortError = caller pulled the rip-cord. Don't retry.
      if (err instanceof Error && err.name === 'AbortError') {throw err;}
      const msg = err instanceof Error ? err.message : String(err);
      if (!transientNetworkRe.test(msg) || attempt >= retries) {throw err;}
      lastError = err;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt)));
    }
  }
  // Loop guarantees one of the branches above returns or throws; this
  // line is purely for the type-checker's benefit.
  throw lastError ?? new Error('fetchWithRetry: exhausted attempts');
}
