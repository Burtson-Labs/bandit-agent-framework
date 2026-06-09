import { getModelBehaviorProfile } from './modelBehavior';

/**
 * Model capability profiles.
 * Used to tune prompt complexity, context window budgets, and feature availability
 * per model. Profiles are looked up by model ID prefix so that tagged variants
 * (e.g. bandit-core:12b-it-qat) match their base entry.
 */

export type ModelTier = 'small' | 'medium' | 'large';

export interface ModelCapabilities {
  /** Approximate usable context window in tokens. */
  contextWindow: number;
  /** Whether the model/endpoint supports Ollama format:"json" structured output. */
  supportsJsonMode: boolean;
  /** Whether the model supports native function/tool calling. */
  supportsToolCalling: boolean;
  /**
   * Whether the model accepts image input (vision).
   * When true, Ollama /api/chat accepts an `images: string[]` field (base64).
   * Used to auto-route image attachments in the VS Code chat panel.
   */
  supportsVision: boolean;
  /** Tier used to scale prompt complexity and context budget. */
  tier: ModelTier;
  /** Human-readable label for UI display. */
  label?: string;
}

/**
 * Confirmed model inventory as of April 2026.
 *
 * Mac local (localhost:11434):
 * bandit-core:4b/12b-it-qat, gemma3:4b/12b-it-qat, llama3.1, nomic-embed-text
 *
 * RTX 5090 node (ollamaNodeUrl):
 * gemma4:31b, bandit-core:27b-it-qat, gemma3:27b-it-qat, qwen2.5:7b,
 * deepseek-coder:6.7b, llama3 (NOT 3.1 — 8k ctx), nomic-embed-text
 */
const BUILT_IN_PROFILES: Array<{ prefix: string; caps: ModelCapabilities }> = [
  // ── bandit-core fine-tuned variants (text + code only, no vision) ─────────
  {
    prefix: 'bandit-core:4b',
    caps: { contextWindow: 8192, supportsJsonMode: true, supportsToolCalling: false, supportsVision: false, tier: 'small', label: 'Bandit Core 4B' }
  },
  // flipped supportsToolCalling on the Gemma-3-derived
  // bandit-core variants ≥12B. Without it, the loop's `nativeTools`
  // gate at extension.ts:3445 short-circuits and the model gets only
  // the system prompt's XML tool-call instructions, which Gemma 3 does
  // not reliably emit (the `<tool_call>{...}</tool_call>` envelope is
  // a Qwen-flavored convention not in Gemma's training distribution).
  // Result bandit-core-1 produced prose only on a
  // self-eval, zero tool calls. Modern Ollama serves Gemma 3 ≥12B with
  // a tool-calling chat template; the cloud path's serializeBanditPayload
  // already forwards tools through to upstream Ollama. 4B stays off
  // because tool calling is unreliable on small Gemmas.
  {
    prefix: 'bandit-core:12b',
    caps: { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium', label: 'Bandit Core 12B' }
  },
  {
    prefix: 'bandit-core:27b',
    caps: { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium', label: 'Bandit Core 27B' }
  },
  {
    prefix: 'bandit-core:31b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Bandit Core 31B' }
  },
  // Hosted bandit models (via GatewayApi / api.burtson.ai)
  {
    prefix: 'bandit-core-1',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Bandit Core (hosted, 31B)' }
  },
  {
    prefix: 'bandit-core-2',
    caps: { contextWindow: 131072, supportsJsonMode: false, supportsToolCalling: false, supportsVision: false, tier: 'large', label: 'Bandit Core 2 (RunPod 70B)' }
  },
  {
    // Gateway alias for Qwen 3.6 27B (repoint from Qwen 2.5 Coder 32B
    // 2026-04-23 — 2.5 Coder is a code-completion tune, 3.6 is
    // explicitly agent-trained with 256K context and native multimodal).
    // Native tool calling is the whole reason we expose it — the
    // capability profile here must match the underlying model, not
    // bandit-core-1's text-path profile.
    prefix: 'bandit-logic',
    caps: { contextWindow: 262144, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Bandit Logic (Qwen 3.6 27B)' }
  },

  // ── gemma3 — vision capable (all sizes) ──────────────────────────────────
  // gemma3 supports image input via Ollama's `images: string[]` field.
  // Mac local: gemma3:4b, gemma3:12b-it-qat. RTX 5090 node: gemma3:27b-it-qat.
  // These are the primary vision models — no additional pull needed.
  {
    prefix: 'gemma3:4b',
    caps: { contextWindow: 8192, supportsJsonMode: true, supportsToolCalling: false, supportsVision: true, tier: 'small', label: 'Gemma 3 4B' }
  },
  {
    prefix: 'gemma3:12b',
    caps: { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: false, supportsVision: true, tier: 'medium', label: 'Gemma 3 12B' }
  },
  {
    prefix: 'gemma3:27b',
    caps: { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'medium', label: 'Gemma 3 27B' }
  },

  // ── gemma4 — enhanced vision + 128k context (all sizes) ──────────────────
  // Most-specific prefixes win (longer prefix matched first). The
  // `e2b` / `e4b` variants are "effective" parameter-count tunes that
  // sit at the small-tier boundary — that bare
  // `gemma4:e4b` was being mis-routed to `large` by the catchall
  // below, getting num_ctx=32768 and outputBudgetTokens=8192 on a 4B
  // model. The agent then wandered on open-ended creative asks
  // ("add visual flare") and never committed to a tool call. These
  // explicit small-tier profiles fix that without affecting the 26B+
  // sizes.
  {
    prefix: 'gemma4:e2b',
    caps: { contextWindow: 16384, supportsJsonMode: true, supportsToolCalling: false, supportsVision: true, tier: 'small', label: 'Gemma 4 e2B' }
  },
  {
    prefix: 'gemma4:e4b',
    caps: { contextWindow: 16384, supportsJsonMode: true, supportsToolCalling: false, supportsVision: true, tier: 'small', label: 'Gemma 4 e4B' }
  },
  {
    prefix: 'gemma4:31b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Gemma 4 31B' }
  },
  {
    prefix: 'gemma4:26b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'medium', label: 'Gemma 4 26B' }
  },
  {
    // Catchall for unknown gemma4 sizes. Defaults to `medium` rather
    // than `large` — the previous `large` default flagged any
    // unrecognised size (including the 4B effective tune above
    // before its explicit profile was added) into the heaviest
    // budget. Medium is a safer guess; explicit large variants
    // (31b+) match their own prefix above first.
    prefix: 'gemma4',
    caps: { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: false, supportsVision: true, tier: 'medium', label: 'Gemma 4' }
  },

  // ── Llama 3.x (text only) ─────────────────────────────────────────────────
  {
    prefix: 'llama3.2-vision',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: false, supportsVision: true, tier: 'medium', label: 'Llama 3.2 Vision' }
  },
  {
    prefix: 'llama3.1',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium', label: 'Llama 3.1' }
  },
  {
    prefix: 'llama3',
    caps: { contextWindow: 8192, supportsJsonMode: true, supportsToolCalling: false, supportsVision: false, tier: 'small', label: 'Llama 3' }
  },

  // ── Qwen 3.6 — agent-trained, vision-capable, 256K context ───────────────
  // Released April 2026 with explicit focus on "agentic coding" and
  // "repository-level reasoning" — a genuine upgrade over Qwen 2.5 Coder
  // for tool-use workflows (2.5 Coder is a code-completion tune, not an
  // agent tune). 27B fits RTX 5090 at ~17GB + ample KV room; 35B is
  // tighter (~24GB + trim KV). Multimodal: image paste should go through
  // native vision rather than falling back to OCR.
  {
    prefix: 'qwen3.6:35b',
    caps: { contextWindow: 262144, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Qwen 3.6 35B' }
  },
  {
    prefix: 'qwen3.6:27b',
    caps: { contextWindow: 262144, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Qwen 3.6 27B' }
  },
  {
    prefix: 'qwen3.6',
    caps: { contextWindow: 262144, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'large', label: 'Qwen 3.6' }
  },

  // ── Qwen 2.5 Coder (text + code, no vision) ───────────────────────────────
  // Most specific prefixes first (longer match wins before shorter prefix).
  {
    prefix: 'qwen2.5-coder:72b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'large', label: 'Qwen 2.5 Coder 72B' }
  },
  {
    prefix: 'qwen2.5-coder:32b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'large', label: 'Qwen 2.5 Coder 32B' }
  },
  {
    prefix: 'qwen2.5-coder:14b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium', label: 'Qwen 2.5 Coder 14B' }
  },
  {
    prefix: 'qwen2.5-coder',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium', label: 'Qwen 2.5 Coder' }
  },

  // ── Qwen 2.5 Vision (VL variants) — supportsVision ───────────────────────
  {
    prefix: 'qwen2.5vl',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'medium', label: 'Qwen 2.5 VL' }
  },
  {
    prefix: 'qwen2-vl',
    caps: { contextWindow: 32768, supportsJsonMode: true, supportsToolCalling: true, supportsVision: true, tier: 'medium', label: 'Qwen 2 VL' }
  },

  // ── Qwen 2.5 base (non-coder, non-VL) — text only ────────────────────────
  // qwen2.5:7b confirmed on RTX 5090 node. Not a vision model.
  {
    prefix: 'qwen2.5:72b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'large', label: 'Qwen 2.5 72B' }
  },
  {
    prefix: 'qwen2.5:32b',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'large', label: 'Qwen 2.5 32B' }
  },
  {
    prefix: 'qwen2.5',
    caps: { contextWindow: 131072, supportsJsonMode: true, supportsToolCalling: true, supportsVision: false, tier: 'medium', label: 'Qwen 2.5' }
  },

  // ── LLaVA — dedicated vision models (optional pull) ──────────────────────
  {
    prefix: 'llava',
    caps: { contextWindow: 4096, supportsJsonMode: false, supportsToolCalling: false, supportsVision: true, tier: 'small', label: 'LLaVA' }
  },

  // ── Small / fast ─────────────────────────────────────────────────────────
  {
    prefix: 'deepseek-coder:6.7b',
    caps: { contextWindow: 16384, supportsJsonMode: true, supportsToolCalling: false, supportsVision: false, tier: 'small', label: 'DeepSeek Coder 6.7B' }
  },
];

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 8192,
  supportsJsonMode: false,
  supportsToolCalling: false,
  supportsVision: false,
  tier: 'small'
};

/**
 * Runtime cache for dynamically discovered model capabilities (e.g. Ollama /api/show).
 * Used ONLY when no built-in profile matches the model ID. Built-in profiles are
 * hand-tuned (correct `supportsToolCalling`, `tier`, etc.); the auto-detector
 * can only infer tier and context-window safely. Letting the cache override
 * built-ins silently downgraded every known model the moment auto-detection
 * ran at boot — bandit-logic lost its `supportsToolCalling: true`, nativeTools
 * gated off, tools were never sent to Ollama, the qwen3.5 parser EOF'd on
 * text-envelope output, and the fallback couldn't recover.
 */
const runtimeCapabilitiesCache = new Map<string, ModelCapabilities>();

/**
 * Register runtime-discovered capabilities for a model ID. Only takes effect
 * when getModelCapabilities() finds no built-in match — explicit profiles win.
 */
export function registerModelCapabilities(modelId: string, caps: ModelCapabilities): void {
  if (modelId) {runtimeCapabilitiesCache.set(modelId.toLowerCase(), caps);}
}

/**
 * Returns capability profile for a given model ID.
 * Check order: (1) built-in prefix profiles, (2) runtime cache, (3) default.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  if (!modelId) {return DEFAULT_CAPABILITIES;}
  const lower = modelId.toLowerCase();
  for (const { prefix, caps } of BUILT_IN_PROFILES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return caps;
    }
  }
  const cached = runtimeCapabilitiesCache.get(lower);
  if (cached) {return cached;}
  return DEFAULT_CAPABILITIES;
}

/**
 * Derives a model tier from a parameter-size string returned by Ollama /api/show.
 * Examples: "4B" → small, "8B" / "12B" / "27B" → medium, "70B" / "72B" → large.
 */
function deriveTierFromParamSize(paramSize: string): ModelTier {
  const match = paramSize.match(/(\d+(?:\.\d+)?)\s*[Bb]/);
  if (!match) {return 'small';}
  const billions = parseFloat(match[1]);
  if (billions <= 5) {return 'small';}
  if (billions <= 35) {return 'medium';}
  return 'large';
}

/**
 * Queries Ollama /api/show to auto-detect capabilities for a model not in BUILT_IN_PROFILES.
 * Returns a partial ModelCapabilities object (tier + contextWindow) on success, null on failure.
 * Silently returns null when Ollama is unreachable or the model is not installed.
 *
 * Call this once per model switch and persist via registerModelCapabilities().
 */
export async function queryOllamaModelCapabilities(
  modelId: string,
  baseUrl: string
): Promise<ModelCapabilities | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/show`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelId }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {return null;}
    const data = await response.json() as {
      details?: { parameter_size?: string; family?: string };
      model_info?: { 'llm.context_length'?: number };
      capabilities?: string[];
    };
    const paramSize = data.details?.parameter_size ?? '';
    const tier = deriveTierFromParamSize(paramSize);
    // Prefer the model's own declared context length when available.
    const contextWindow = data.model_info?.['llm.context_length']
      ?? (tier === 'large' ? 131072 : tier === 'medium' ? 32768 : 8192);
    const family = (data.details?.family ?? '').toLowerCase();
    // Trust Ollama's advertised capabilities when present. Hard-coding false
    // here silently downgraded every tool-calling model that hit auto-detection
    // before the built-in profile precedence fix landed. Even with that fix,
    // models without a built-in profile (a new tag, a user-pulled variant)
    // should report tools accurately when the runtime says so.
    const caps = new Set((data.capabilities ?? []).map((c) => c.toLowerCase()));
    const supportsJsonMode = true; // All Ollama-served models support format:"json"
    const supportsToolCalling = caps.has('tools');
    const supportsVision =
      caps.has('vision') ||
      family.includes('llava') || family.includes('vision') || family.includes('vl');
    return {
      tier,
      contextWindow,
      supportsJsonMode,
      supportsToolCalling,
      supportsVision,
      label: modelId
    };
  } catch {
    return null;
  }
}

/**
 * Result of an Ollama context-length health check. Hosts (CLI banner,
 * IDE notification) use this to decide whether to surface a one-time
 * tip about `OLLAMA_CONTEXT_LENGTH`.
 */
export interface OllamaContextCheck {
  /** Loaded num_ctx for the running model, in tokens. Null when the
   * model hasn't been loaded yet (no chat fired since `ollama serve`
   * started) — in that case the host should defer the check to after
   * the first successful chat. */
  loadedContext: number | null;
  /** What our framework asked for via per-request `options.num_ctx`. */
  requestedContext: number;
  /** True when the loaded context is materially smaller than what we
   * asked for AND below an absolute 8K floor. New users on a fresh
   * Ollama install with `OLLAMA_CONTEXT_LENGTH` unset land at 4K
   * (Ollama's default) and feel "super slow" because every prompt
   * thrashes the KV cache. We only flag when the gap is real — a 24K
   * model loaded at 16K is fine, a 24K request loaded at 4K isn't. */
  underweight: boolean;
  /** Shell command the user can run to fix it. Tailored to the gap so
   * a 4K → 16K user gets a different number than a 8K → 24K user. */
  suggestionCommand: string;
}

/**
 * Query Ollama's `/api/ps` for the currently-loaded context length of
 * `modelId` and compare against our requested num_ctx. Returns a check
 * the host can render as a one-time tip. Silently returns underweight=
 * false on any network/parse failure (this is a UX hint, never an error).
 *
 * Why /api/ps and not /api/show: /api/show returns the model's NATIVE
 * context window from the GGUF metadata — that's the maximum the model
 * could be loaded with, not what's actually loaded right now. /api/ps
 * lists currently-resident models and reports the loaded context_length
 * directly. That's the value that determines whether prompts overflow.
 */
export async function checkOllamaLoadedContext(
  baseUrl: string,
  modelId: string,
  requestedContext: number
): Promise<OllamaContextCheck> {
  // Suggest a target ~25% above the requested floor so the env var
  // covers our normal num_ctx + a small headroom for KV growth.
  const suggested = Math.max(16384, Math.ceil(requestedContext * 1.1 / 1024) * 1024);
  const fallback: OllamaContextCheck = {
    loadedContext: null,
    requestedContext,
    underweight: false,
    suggestionCommand: `OLLAMA_CONTEXT_LENGTH=${suggested} ollama serve`
  };
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/ps`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {return fallback;}
    const data = await response.json() as {
      models?: Array<{ model?: string; name?: string; context_length?: number }>;
    };
    const lowerId = modelId.toLowerCase();
    const match = (data.models ?? []).find(m =>
      (m.model ?? '').toLowerCase() === lowerId ||
      (m.name ?? '').toLowerCase() === lowerId
    );
    if (!match || typeof match.context_length !== 'number') {
      return fallback;
    }
    const loaded = match.context_length;
    // Underweight: loaded < 8K (absolute floor below which agent prompts
    // get truncated) AND loaded < 75% of requested (a 4K env-var clamp
    // when we asked for 12K — the canonical first-install gotcha).
    const underweight = loaded < 8192 && loaded < requestedContext * 0.75;
    return {
      loadedContext: loaded,
      requestedContext,
      underweight,
      suggestionCommand: `OLLAMA_CONTEXT_LENGTH=${suggested} ollama serve`
    };
  } catch {
    return fallback;
  }
}

/**
 * Returns the maximum number of context file chunks to include based on tier.
 */
export function getContextFileLimit(tier: ModelTier): number {
  switch (tier) {
    case 'large':  return 20;
    case 'medium': return 8;
    case 'small':  return 3;
  }
}

/**
 * Returns the approximate token budget reserved for context (not prompt/response).
 */
export function getContextTokenBudget(caps: ModelCapabilities): number {
  // Reserve ~40% of context window for injected file content.
  return Math.floor(caps.contextWindow * 0.4);
}

/**
 * Approximate per-turn output token budget.
 *
 * The tool-use loop uses this to decide whether a model's planned batch of
 * write/edit calls will exceed the assistant turn's safe output capacity.
 * When the planned content would push past this number, the loop serialises
 * execution so each call gets its own iteration — protecting smaller models
 * from generating malformed JSON in the tail of a multi-file emission, and
 * giving the user a chance to react between approvals.
 *
 * Tier defaults are conservative — they are NOT the model's hard ceiling,
 * they are the point past which output coherence starts to slip on local
 * models. A capable hosted model effectively has no binding budget here.
 *
 * Tier mapping:
 * small → 1024 tokens (4B params, ~4 KB of generated content)
 * medium → 2048 tokens (12B–27B params, ~8 KB)
 * large → 8192 tokens (31B+ params, hosted strong models)
 *
 * Override at runtime by passing `outputBudgetTokens` to the loop directly,
 * or by registering a tuned profile via `registerModelCapabilities`.
 */
export function getOutputTokenBudget(caps: ModelCapabilities): number {
  switch (caps.tier) {
    case 'small':  return 1024;
    case 'medium': return 2048;
    case 'large':  return 8192;
    default:       return 1024;
  }
}

/**
 * Ollama `/api/chat` runtime options per model tier. Ollama's server
 * default `num_ctx` is only 2048 — small enough that our system prompt
 * + tool definitions alone (~4k tokens) overflow and get truncated
 * from the front, which strips the "you are an agent with tools"
 * framing and leaves the model answering from its raw conversational
 * persona ("I can't edit your code"). Passing `num_ctx` per tier
 * fixes this; `keep_alive: -1` prevents the 5-minute idle unload that
 * otherwise forces a cold reload on every follow-up turn.
 *
 * Budgets are conservative — sized to fit common laptop VRAM (16 GB)
 * for small/medium and an RTX 5090 (32 GB) for large. Users can still
 * override via the `banditStealth.ollamaOptions` setting.
 */
export interface OllamaRuntimeOptions {
  num_ctx: number;
  keep_alive: number;
  /**
   * Disables chain-of-thought "thinking mode" for reasoning-capable models
   * (Qwen 3.x, DeepSeek R1, etc.) by passing top-level `think: false` to
   * Ollama's /api/chat. Not nested under `options` — Ollama treats `think`
   * as a first-class request field, not a model parameter. Undefined means
   * "don't send the field" so non-reasoning models aren't affected.
   */
  think?: boolean;
}

export function resolveOllamaRuntimeOptions(modelId: string): OllamaRuntimeOptions {
  const caps = getModelCapabilities(modelId);
  // num_ctx is what we REQUEST from Ollama (not the model's native
  // maximum — those are routinely 128K+ and would blow RAM). Pick a
  // value that fits our framework prompt + several tool rounds + a
  // reasonable user turn on commodity hardware. Tiers measured on:
  // - small (4B): fits laptop iGPU / Apple M-series w/o swap.
  // - medium (12B/27B): 16 GB VRAM laptops (MBP Q4).
  // - large (31B+): RTX 5090 class or cluster; Modelfile can still
  // override via its own num_ctx parameter.
  // Anchoring here: the 8-iteration agent runs we saw in April 2026
  // hitting `hitLimit: true` from accumulated tool results on num_ctx
  // 16k. Tiers below give the loop ~24k-32k tokens of room before
  // compaction needs to kick in.
  let num_ctx: number;
  switch (caps.tier) {
    case 'small':
      num_ctx = 12288;   // 4B — bump from 8k; still fits ~8 GB VRAM
      break;
    case 'medium':
      num_ctx = 24576;   // 12B/27B — 24k room for normal agent turns
      break;
    case 'large':
      num_ctx = 32768;   // 31B+ — matches cluster bandit-core:31b Modelfile
      break;
    default:
      num_ctx = 12288;
  }
  // Clamp to the model's declared native window so we never ask for
  // more than the model can actually honor.
  if (caps.contextWindow > 0 && num_ctx > caps.contextWindow) {
    num_ctx = caps.contextWindow;
  }
  // Thinking-mode default now comes from behavior profiles rather than
  // scattered model-name checks. Users can still override via `/think`
  // (CLI) or banditStealth.thinkingMode (extension).
  const behavior = getModelBehaviorProfile(modelId);
  const thinkDefault = behavior.prompting.thinking === 'on'
    ? true
    : behavior.prompting.thinking === 'off'
      ? false
      : undefined;
  return {
    num_ctx,
    keep_alive: -1,
    ...(thinkDefault !== undefined ? { think: thinkDefault } : {})
  };
}
