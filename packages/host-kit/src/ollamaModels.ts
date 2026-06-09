/**
 * Shared Ollama model-discovery helpers used by both the CLI and the
 * VS Code extension. Both surfaces need to:
 *   - list what's actually pulled on the local runtime (`/api/tags`),
 *   - map an unpulled model to the closest installed match so users
 *     don't have to know about `-it-qat` vs `-it-q4_K_M` suffixes.
 *
 * Keeping the logic here means CLI auto-switch and extension UI pickers
 * give identical suggestions for the same installed set.
 */

export interface OllamaModelInfo {
  /** Full tag as returned by `/api/tags` (e.g. "gemma3:12b-it-qat"). */
  name: string;
  /** Approximate on-disk size in bytes, when reported. */
  size?: number;
  /** Last modified ISO string, when reported. */
  modifiedAt?: string;
}

/**
 * Fetch the list of models installed on an Ollama runtime. Embedding-only
 * models are NOT filtered out here — callers that want just chat-capable
 * models should pass `{ chatOnly: true }` or filter via {@link isChatCapable}.
 */
export async function listInstalledOllamaModels(
  baseUrl: string,
  options: { timeoutMs?: number; chatOnly?: boolean } = {}
): Promise<OllamaModelInfo[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
  const timeoutMs = options.timeoutMs ?? 3000;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name?: string; size?: number; modified_at?: string }>;
    };
    const all: OllamaModelInfo[] = (data.models ?? [])
      .filter((m): m is { name: string; size?: number; modified_at?: string } => typeof m?.name === 'string')
      .map((m) => ({ name: m.name, size: m.size, modifiedAt: m.modified_at }));
    if (options.chatOnly) {
      return all.filter((m) => isChatCapable(m.name));
    }
    return all;
  } catch {
    return [];
  }
}

/** Embedding-only models should be excluded from chat/agent picklists. */
export function isChatCapable(name: string): boolean {
  return !/embed|embedding|nomic/i.test(name);
}

/**
 * Rank installed Ollama models by how well they match a requested name.
 * Prefers: same family + same param-size > same family > any chat-capable
 * model. Excludes embedding-only models from the returned list.
 */
export function suggestOllamaMatch(requested: string, installed: string[]): string[] {
  const [reqStem = '', reqTag = ''] = requested.split(':');
  // "gemma4" → "gemma"; "qwen2.5-coder" → "qwen". Used to cross-match
  // across major versions of the same family (gemma4:e4b → gemma3:12b-it-qat).
  const familyBase = (stem: string): string => stem.replace(/[\d.]+.*$/, '') || stem;
  const reqFamily = familyBase(reqStem);

  const score = (name: string): number => {
    if (!isChatCapable(name)) return -1;
    const [stem, tag = ''] = name.split(':');
    let s = 0;
    if (stem === reqStem) s += 20;
    else if (stem.startsWith(reqStem) || reqStem.startsWith(stem)) s += 10;
    else if (reqFamily.length >= 3 && familyBase(stem) === reqFamily) s += 5;
    if (s === 0) return 0;
    if (reqTag && tag.startsWith(reqTag)) s += 6;
    else if (reqTag && tag.includes(reqTag)) s += 3;
    if (/qat|q4|q5|q8/i.test(tag)) s += 1;
    return s;
  };

  return installed
    .map((name) => ({ name, s: score(name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.name);
}
