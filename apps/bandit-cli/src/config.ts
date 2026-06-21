/**
 * CLI config file loader.
 *
 * Reads (in this precedence, higher wins):
 *   1. CLI flags (--provider, --model, --api-key, --api-url, --ollama-url)
 *   2. Environment variables (BANDIT_*, OLLAMA_URL)
 *   3. Workspace config    — .bandit/config.json     (project-specific)
 *   4. Global user config  — ~/.bandit/config.json   (personal defaults)
 *   5. Baked-in defaults
 *
 * The workspace config can override personal settings project-by-project
 * (e.g. "this repo uses our internal Ollama endpoint"). Personal config is
 * the natural home for API keys, so workspace config files can stay clean
 * and get committed safely.
 *
 * Config shape:
 * {
 *   "provider": "ollama" | "bandit",
 *   "model": "gemma4:e4b",
 *   "ollama": {
 *     "url": "https://ollama.example.com",
 *     "headers": { "Authorization": "Bearer xyz", "X-Team": "core" }
 *   },
 *   "bandit": {
 *     "apiKey": "sk-bandit-...",
 *     "apiUrl": "https://api.burtson.ai"
 *   }
 * }
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ConfiguredProviderKind = 'ollama' | 'bandit' | 'openai-compatible';

export interface BanditConfig {
  provider?: ConfiguredProviderKind;
  model?: string;
  /** Color theme name — see ansi.ts THEMES. Set on first run by the
   *  theme picker, overridable via /theme. Absent on legacy installs;
   *  the picker fires once when this is undefined. */
  theme?: string;
  ollama?: {
    url?: string;
    headers?: Record<string, string>;
  };
  bandit?: {
    apiKey?: string;
    apiUrl?: string;
  };
  /** OpenAI-compatible upstream config — LM Studio, llama.cpp, vLLM,
   *  OpenAI proper, OpenRouter, Together, Groq, DeepSeek, xAI. The
   *  base URL goes here (e.g. `http://localhost:1234/v1`); the
   *  provider appends `/chat/completions`. */
  openai?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    headers?: Record<string, string>;
  };
  /** Per-user consent for sending the insights payload to a cloud LLM.
   *  `'allow'` skips the prompt on every /insights run; `'deny'` skips
   *  the AI section entirely; `undefined` triggers a one-time prompt.
   *  Local Ollama bypasses this gate (no network egress). Persisted via
   *  saveInsightsAiConsent.
   *
   *  Keyed as `v2` because the payload shape materially expanded to
   *  enable LLM-narrated storylines — verbatim prompt excerpts (~280
   *  chars × 25) and work-highlight file paths, where v1 sent only
   *  120-char title prefixes and no file paths. Anyone who consented
   *  under v1 is re-prompted with the updated copy. */
  insightsAiConsentV2?: 'allow' | 'deny';
  /** Legacy v1 field — read only for migration awareness. Never written
   *  going forward. v2 consent is required to share the richer payload. */
  insightsAiConsent?: 'allow' | 'deny';
  /** When false, Bandit will NOT append `Co-authored-by: Bandit
   *  <bandit@burtson.ai>` to commit messages it issues on the user's
   *  behalf. Default behavior is to append the trailer so the Bandit
   *  ninja avatar shows on GitHub PR / blame / contributor views.
   *  Toggled via the `/coauthor on|off` slash command; the env var
   *  `BANDIT_NO_COAUTHOR=1` forces off for one shell session without
   *  touching this file. */
  coauthor?: boolean;
  /** Persistent override for the no-token watchdog window (ms). Mirrors
   *  the BANDIT_NO_TOKEN_WATCHDOG_MS env var so you don't have to set
   *  it in every shell. `0` disables the watchdog entirely; positive
   *  values pin the window; absent/undefined falls through to the
   *  auto-scale formula. Env var still wins when both are present, so
   *  per-shell overrides for diagnostic sessions work without
   *  rewriting the config. Set via the `/watchdog` slash command. */
  watchdogMs?: number;
  /** Custom locations Bandit should scan when the model calls
   *  `find_directory` (or the user types something like "open my
   *  auth-api repo"). Augments the built-in clone-parent list
   *  (`~/Documents/GitHub`, `~/Projects`, `~/code`, `~/dev`, …) — your
   *  entries are added on top, NOT replacing the defaults. Tilde
   *  expansion works. Configure via /repos add <path> in the REPL. */
  repos?: {
    roots?: string[];
  };
  /** Local user notifications. Desktop notifications are opt-in for
   *  the CLI because terminal sessions are often scripted/remote.
   *  Sound is a terminal bell, also opt-in. */
  notifications?: {
    desktop?: boolean;
    sound?: boolean;
    minTurnMs?: number;
  };
  /** BYOK credentials for optional tools. Each entry is independent and
   *  only enables the matching tool when set. Persisted via the
   *  `/tavily <key>` slash command (and friends). Env var still wins —
   *  this is the persisted fallback for users who don't want to set
   *  TAVILY_API_KEY in every shell. */
  tools?: {
    tavily?: {
      apiKey?: string;
    };
  };
  /** App-level telemetry (OTLP). OFF by default — opt-in, like
   *  insightsAiConsentV2, because it sends turn traces + usage metrics
   *  off the machine. Wire format is plain OTLP/HTTP, so `endpoint` +
   *  `headers` can point at ANY collector (Burtson, App Insights, your
   *  own) — not just otlp.burtson.ai. `mode: 'metrics-only'` drops span
   *  payloads for stricter privacy. Bearer defaults to the signed-in
   *  Bandit token (config.bandit.apiKey); override via headers. Env:
   *  BANDIT_TELEMETRY=1/0, BANDIT_OTLP_ENDPOINT, BANDIT_OTLP_TOKEN. */
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    mode?: 'metrics+traces' | 'metrics-only';
    headers?: Record<string, string>;
  };
}

export interface ConfigOverrides {
  provider?: ConfiguredProviderKind;
  model?: string;
  apiKey?: string;
  apiUrl?: string;
  ollamaUrl?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
}

const GLOBAL_CONFIG = path.join(os.homedir(), '.bandit', 'config.json');

/** Load and merge workspace + global config files. Missing files are ignored. */
export async function loadConfigFiles(cwd: string): Promise<BanditConfig> {
  const files = [
    GLOBAL_CONFIG,
    path.resolve(cwd, '.bandit/config.json'),
    path.resolve(cwd, '.bandit/config.local.json')
  ];
  let merged: BanditConfig = {};
  for (const file of files) {
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as BanditConfig;
      merged = mergeConfig(merged, parsed);
    } catch {
      // Missing / invalid — skip silently so first run works with zero config.
    }
  }
  return merged;
}

/** Read the effective Tavily key live (env → ~/.bandit/config.json), without
 *  a full config load. Used at web_search build time so a key saved in the
 *  IDE or via `/tavily` is picked up on the next turn without restarting the
 *  CLI — the boot-time resolved value would otherwise be stale. */
export function readTavilyKey(): string | undefined {
  const env = process.env.TAVILY_API_KEY?.trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf-8')) as BanditConfig;
    return cfg.tools?.tavily?.apiKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the final effective config by layering sources in precedence order.
 * CLI flags > env vars > workspace/global file > defaults.
 */
export function resolveConfig(
  fileConfig: BanditConfig,
  overrides: ConfigOverrides = {}
): ResolvedConfig {
  const provider: ConfiguredProviderKind = overrides.provider
    ?? (process.env.BANDIT_PROVIDER as ConfiguredProviderKind | undefined)
    ?? fileConfig.provider
    ?? 'ollama';

  // Default models per provider:
  //   ollama            → gemma4:e4b (9.6 GB, 128K context, multimodal, MoE).
  //                       Users without it pulled auto-switch to their closest
  //                       installed model.
  //   bandit            → bandit-logic (agent-tuned Qwen 3.6 27B wrapper).
  //   openai-compatible → no default — user MUST supply `--openai-model` /
  //                       OPENAI_MODEL / config.openai.model. Naming is
  //                       provider-specific (Together vs OpenRouter vs
  //                       LM Studio all use different ids).
  const defaultModel = provider === 'ollama'
    ? 'gemma4:e4b'
    : provider === 'bandit'
      ? 'bandit-logic'
      : '';
  const openaiModel = overrides.openaiModel
    ?? process.env.OPENAI_MODEL
    ?? fileConfig.openai?.model;
  const model = overrides.model
    ?? process.env.BANDIT_MODEL
    ?? fileConfig.model
    ?? (provider === 'openai-compatible' ? (openaiModel ?? '') : defaultModel);

  const ollamaUrl = overrides.ollamaUrl
    ?? process.env.OLLAMA_URL
    ?? fileConfig.ollama?.url
    ?? 'http://localhost:11434';

  const ollamaHeaders = fileConfig.ollama?.headers ?? {};

  const apiKey = overrides.apiKey
    ?? process.env.BANDIT_API_KEY
    ?? fileConfig.bandit?.apiKey;
  const apiUrl = overrides.apiUrl
    ?? process.env.BANDIT_API_URL
    ?? fileConfig.bandit?.apiUrl;

  const openaiBaseUrl = overrides.openaiBaseUrl
    ?? process.env.OPENAI_BASE_URL
    ?? fileConfig.openai?.baseUrl;
  const openaiApiKey = overrides.openaiApiKey
    ?? process.env.OPENAI_API_KEY
    ?? fileConfig.openai?.apiKey;
  const openaiHeaders = fileConfig.openai?.headers ?? {};
  const repoRoots = [...(fileConfig.repos?.roots ?? [])];

  // Tavily key: env wins (per-shell override), then persisted config.
  // Empty string treated as absent so a blank config entry doesn't
  // shadow a valid env var.
  const tavilyApiKey = (process.env.TAVILY_API_KEY?.trim() || undefined)
    ?? (fileConfig.tools?.tavily?.apiKey?.trim() || undefined);

  return {
    provider,
    model,
    modelWasExplicit: overrides.model !== undefined || process.env.BANDIT_MODEL !== undefined || fileConfig.model !== undefined,
    ollamaUrl,
    ollamaHeaders,
    apiKey,
    apiUrl,
    openaiBaseUrl,
    openaiApiKey,
    openaiModel,
    openaiHeaders,
    repoRoots,
    coauthor: fileConfig.coauthor,
    watchdogMs: fileConfig.watchdogMs,
    notifications: {
      desktop: /^(1|true|yes)$/i.test(process.env.BANDIT_NOTIFY ?? '')
        ? true
        : fileConfig.notifications?.desktop ?? false,
      sound: /^(1|true|yes)$/i.test(process.env.BANDIT_NOTIFY_SOUND ?? '')
        ? true
        : fileConfig.notifications?.sound ?? false,
      minTurnMs: Number.isFinite(Number(process.env.BANDIT_NOTIFY_MIN_TURN_MS))
        ? Number(process.env.BANDIT_NOTIFY_MIN_TURN_MS)
        : fileConfig.notifications?.minTurnMs ?? 30_000
    },
    tavilyApiKey
  };
}

export interface ResolvedConfig {
  provider: ConfiguredProviderKind;
  model: string;
  modelWasExplicit: boolean;
  ollamaUrl: string;
  ollamaHeaders: Record<string, string>;
  apiKey?: string;
  apiUrl?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiHeaders: Record<string, string>;
  /** User-configured custom repo locations from `repos.roots` in
   *  config.json. Augments the find_directory tool's built-in clone
   *  parents (no replacement). Tilde-prefixed paths are accepted; the
   *  CliToolExecutionContext expands `~` at scan time. */
  repoRoots: string[];
  /** Persisted co-author toggle from config.json. `undefined` = use the
   *  default (true) at the buildSystemPrompt call site. `false` =
   *  user opted out and Bandit must NOT add the trailer. */
  coauthor?: boolean;
  /** Persisted watchdog override from config.json. `undefined` = use
   *  the auto-scale formula at the chat-call site. `0` = disabled.
   *  Positive number = fixed window in ms. Env var
   *  BANDIT_NO_TOKEN_WATCHDOG_MS still wins when set. */
  watchdogMs?: number;
  notifications: {
    desktop: boolean;
    sound: boolean;
    minTurnMs: number;
  };
  /** Resolved Tavily web-search API key. Env TAVILY_API_KEY wins, then
   *  ~/.bandit/config.json `tools.tavily.apiKey`. Undefined means the
   *  web_search tool reports "not configured" and the agent falls back
   *  to web_fetch with a URL. */
  tavilyApiKey?: string;
}

/** Deep-merge config objects. Right-hand side wins on conflicts. */
export function mergeConfig(base: BanditConfig, next: BanditConfig): BanditConfig {
  return {
    provider: next.provider ?? base.provider,
    model: next.model ?? base.model,
    theme: next.theme ?? base.theme,
    ollama: {
      url: next.ollama?.url ?? base.ollama?.url,
      headers: { ...(base.ollama?.headers ?? {}), ...(next.ollama?.headers ?? {}) }
    },
    bandit: {
      apiKey: next.bandit?.apiKey ?? base.bandit?.apiKey,
      apiUrl: next.bandit?.apiUrl ?? base.bandit?.apiUrl
    },
    openai: {
      baseUrl: next.openai?.baseUrl ?? base.openai?.baseUrl,
      apiKey: next.openai?.apiKey ?? base.openai?.apiKey,
      model: next.openai?.model ?? base.openai?.model,
      headers: { ...(base.openai?.headers ?? {}), ...(next.openai?.headers ?? {}) }
    },
    repos: {
      roots: [...new Set([...(base.repos?.roots ?? []), ...(next.repos?.roots ?? [])])]
    },
    notifications: {
      desktop: next.notifications?.desktop ?? base.notifications?.desktop,
      sound: next.notifications?.sound ?? base.notifications?.sound,
      minTurnMs: next.notifications?.minTurnMs ?? base.notifications?.minTurnMs
    },
    // BYOK tool credentials (Tavily). Merged field-by-field like everything
    // else — leaving this out dropped a key saved in ~/.bandit/config.json
    // (including the one the IDE writes), so the CLI's web_search reported
    // "not configured" even with a valid key on disk.
    tools: {
      tavily: {
        apiKey: next.tools?.tavily?.apiKey ?? base.tools?.tavily?.apiKey
      }
    },
    coauthor: next.coauthor ?? base.coauthor,
    watchdogMs: next.watchdogMs ?? base.watchdogMs,
    // OTLP telemetry. Same field-by-field-merge trap as `tools` above: omitting
    // it here silently dropped `telemetry.enabled` from ~/.bandit/config.json, so
    // the CLI never turned the exporter on (no "telemetry on" line, no data) even
    // though the block was on disk. Leaf-replace — a workspace block wins whole.
    telemetry: next.telemetry ?? base.telemetry
  };
}

/** Persist a custom repo root to ~/.bandit/config.json. Used by the
 *  /repos add slash command so users can teach Bandit about
 *  non-standard clone locations (e.g. `~/work/clients`, an external
 *  drive, a NAS mount). Idempotent — adding an already-known root is
 *  a no-op. Returns the absolute path of the config file. */
export async function addRepoRoot(rootPath: string): Promise<{ configFile: string; added: boolean; allRoots: string[] }> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  const current = existing.repos?.roots ?? [];
  const trimmed = rootPath.trim();
  const already = current.includes(trimmed);
  if (!already) current.push(trimmed);
  existing.repos = { roots: current };
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return { configFile: GLOBAL_CONFIG, added: !already, allRoots: current };
}

/** Remove a custom repo root from ~/.bandit/config.json. Returns
 *  whether anything actually changed. */
export async function removeRepoRoot(rootPath: string): Promise<{ configFile: string; removed: boolean; allRoots: string[] }> {
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch {
    return { configFile: GLOBAL_CONFIG, removed: false, allRoots: [] };
  }
  const current = existing.repos?.roots ?? [];
  const trimmed = rootPath.trim();
  const next = current.filter((r) => r !== trimmed);
  existing.repos = { roots: next };
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return { configFile: GLOBAL_CONFIG, removed: next.length !== current.length, allRoots: next };
}

/** Returns the absolute path to the global config file (~/.bandit/config.json).
 *  Surfaced via /config and /login so users have a deterministic place
 *  to look without asking the agent (which can be wrong on smaller
 *  local models that hallucinate paths). */
export function globalConfigPath(): string {
  return GLOBAL_CONFIG;
}

/** Persist a Bandit Cloud API key to ~/.bandit/config.json. Same write
 *  pattern as saveTheme — read existing, merge, write 0600. Returns
 *  the path so the caller can echo it. */
export async function saveApiKey(apiKey: string): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* already exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  existing.bandit = { ...(existing.bandit ?? {}), apiKey };
  // Setting a key implies the user wants to use cloud — flip provider
  // so the next request actually goes there. They can switch back with
  // BANDIT_PROVIDER=ollama or by editing the file.
  existing.provider = 'bandit';
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Persist a Tavily web-search API key to ~/.bandit/config.json. Same
 *  shape as saveApiKey but lives under `tools.tavily.apiKey` so it's
 *  independent of the model provider (Tavily is a tool credential, not
 *  a chat-completion endpoint). Returns the path so callers can echo
 *  where it landed. */
export async function saveTavilyKey(apiKey: string): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* already exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  existing.tools = {
    ...(existing.tools ?? {}),
    tavily: { ...(existing.tools?.tavily ?? {}), apiKey }
  };
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Remove the persisted Tavily key. Leaves the rest of `tools` intact
 *  so future BYOK credentials don't get cleared by mistake. */
export async function clearTavilyKey(): Promise<string> {
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { return GLOBAL_CONFIG; }
  if (existing.tools?.tavily) {
    delete existing.tools.tavily.apiKey;
    if (Object.keys(existing.tools.tavily).length === 0) delete existing.tools.tavily;
    if (existing.tools && Object.keys(existing.tools).length === 0) delete existing.tools;
  }
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Remove the saved Bandit Cloud API key from ~/.bandit/config.json.
 *  Doesn't touch other keys; provider stays whatever it was. */
export async function clearApiKey(): Promise<string> {
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { return GLOBAL_CONFIG; }
  if (existing.bandit) {
    delete existing.bandit.apiKey;
    if (Object.keys(existing.bandit).length === 0) delete existing.bandit;
  }
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Persist the active provider (`ollama` | `bandit` | `openai-compatible`) to
 *  ~/.bandit/config.json so the choice survives the next bandit launch.
 *  Optional `model` parameter lets /provider also pick a sensible default
 *  model in the same write. */
export async function saveProvider(
  provider: ConfiguredProviderKind,
  model?: string
): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  existing.provider = provider;
  if (model) existing.model = model;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Persist the chosen model to ~/.bandit/config.json so the next session
 *  starts on it. Called when the user switches models in-session (`/model`,
 *  the `switch_model` tool). Merges into the existing config — only the
 *  `model` field is touched. */
export async function saveModel(model: string): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  existing.model = model;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Persist OpenAI-compatible upstream config to ~/.bandit/config.json.
 *  Used by the /connect wizard so the user picks once and the choice
 *  survives the next launch. Each field is optional so callers can
 *  update just the model id without re-entering the API key, etc. */
export async function saveOpenaiConfig(patch: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  const next = { ...(existing.openai ?? {}) };
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
  if (patch.apiKey !== undefined) next.apiKey = patch.apiKey;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.headers !== undefined) next.headers = patch.headers;
  existing.openai = next;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Persist the user's consent for sending /insights aggregate
 *  payloads to a cloud LLM. Only relevant for the Bandit cloud
 *  provider — local Ollama never crosses the network. We separate
 *  this from a generic "telemetry" toggle on purpose: the AI summary
 *  payload is small but it includes prompt-title fragments, which
 *  is more sensitive than anonymous counts. */
export async function saveInsightsAiConsent(decision: 'allow' | 'deny'): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  existing.insightsAiConsentV2 = decision;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Read the persisted consent decision. Returns undefined when no v2
 *  decision has been recorded yet (the slash command will prompt). Any
 *  pre-v2 `insightsAiConsent` value is ignored on purpose — the payload
 *  shape changed materially and we want explicit re-consent. */
export async function loadInsightsAiConsent(): Promise<'allow' | 'deny' | undefined> {
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    const parsed = JSON.parse(raw) as BanditConfig;
    return parsed.insightsAiConsentV2;
  } catch {
    return undefined;
  }
}

/** Persist the Ollama base URL to ~/.bandit/config.json. Pass empty
 *  string / undefined to clear the override and fall back to the
 *  baked-in default (http://localhost:11434). Used by the /ollama
 *  slash command so users can flip between a remote endpoint and
 *  localhost without hand-editing the config file. */
export async function saveOllamaUrl(url?: string): Promise<string> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  if (url && url.trim().length > 0) {
    existing.ollama = { ...(existing.ollama ?? {}), url: url.trim() };
  } else if (existing.ollama) {
    delete existing.ollama.url;
    if (Object.keys(existing.ollama).length === 0) delete existing.ollama;
  }
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return GLOBAL_CONFIG;
}

/** Persist a theme selection to ~/.bandit/config.json. Creates the
 *  file + parent directory if needed. Used by the first-run picker
 *  and the /theme slash command. */
export async function saveTheme(theme: string): Promise<void> {
  const dir = path.join(os.homedir(), '.bandit');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    // ignore — directory might already exist
  }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch {
    // first run — file doesn't exist yet
  }
  existing.theme = theme;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/** Persist the no-token watchdog override to ~/.bandit/config.json.
 *  Pass `undefined` to clear the entry so the auto-scale formula
 *  resumes; `0` disables the watchdog entirely; positive values pin
 *  the window in ms. Same write pattern as saveCoauthor. */
export async function saveWatchdogMs(ms: number | undefined): Promise<void> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  if (ms === undefined) delete existing.watchdogMs;
  else existing.watchdogMs = ms;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export async function saveNotifications(patch: Partial<NonNullable<BanditConfig['notifications']>>): Promise<void> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  existing.notifications = { ...(existing.notifications ?? {}), ...patch };
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/** Persist the co-author toggle to ~/.bandit/config.json. Same shape +
 *  mode as saveTheme. Pass `undefined` to clear the entry entirely so
 *  the default (enabled) re-applies on the next session. */
export async function saveCoauthor(enabled: boolean | undefined): Promise<void> {
  const dir = path.join(os.homedir(), '.bandit');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  let existing: BanditConfig = {};
  try {
    const raw = await fs.promises.readFile(GLOBAL_CONFIG, 'utf-8');
    existing = JSON.parse(raw) as BanditConfig;
  } catch { /* first run */ }
  if (enabled === undefined) delete existing.coauthor;
  else existing.coauthor = enabled;
  await fs.promises.writeFile(GLOBAL_CONFIG, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Produce a human-readable summary of the effective config with secrets
 * redacted. Used by /config slash command.
 */
export function describeConfig(cfg: ResolvedConfig): string {
  const redact = (v: string | undefined): string => v ? `${v.slice(0, 6)}…${v.slice(-4)}` : '(unset)';
  const lines: string[] = [
    `provider       ${cfg.provider}`,
    `model          ${cfg.model}`
  ];
  if (cfg.provider === 'ollama') {
    lines.push(`ollama url     ${cfg.ollamaUrl}`);
    const headerNames = Object.keys(cfg.ollamaHeaders);
    if (headerNames.length > 0) {
      lines.push(`ollama headers ${headerNames.join(', ')} (values redacted)`);
    } else {
      lines.push('ollama headers (none)');
    }
  } else {
    lines.push(`bandit api url ${cfg.apiUrl ?? '(default)'}`);
    lines.push(`bandit api key ${redact(cfg.apiKey)}`);
  }
  lines.push(`notifications desktop=${cfg.notifications.desktop ? 'on' : 'off'} sound=${cfg.notifications.sound ? 'on' : 'off'} minTurnMs=${cfg.notifications.minTurnMs}`);
  return lines.join('\n');
}
