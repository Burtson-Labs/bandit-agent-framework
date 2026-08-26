/**
 * Fetches the Bandit gateway's model catalog and registers it as authoritative
 * capability data.
 *
 * Hosted model ids (`bandit-core-1`, `bandit-core-2`, `bandit-logic`, …) are
 * aliases. The gateway decides what backend each one resolves to and can
 * repoint it at any time; the client's hardcoded capability table can only be
 * corrected by shipping a release. When those two disagree, the client wins by
 * default — and silently, because nothing surfaces the mismatch.
 *
 * That is not hypothetical. `bandit-core-2` was repointed to a different
 * backend, the gateway correctly advertised `Tools: true`, and a stale
 * hardcoded `supportsToolCalling: false` sent every turn down the text-tools
 * path: the whole tool registry got inlined into the system prompt (~18K →
 * ~142K chars on an MCP-connected workspace) and the model, handed no native
 * schemas, answered in prose while insisting the tools were "not exposed". A
 * user-visible "the model can't use tools anymore" bug caused entirely by
 * client-side metadata drift.
 *
 * Registering the catalog as authoritative closes that class of bug: the party
 * that routes the request is the party that describes it.
 *
 * Best-effort by design — a failed fetch leaves the built-in profiles in place,
 * which is the current behavior. Never throws, never blocks a turn.
 */
import { registerModelCapabilities, type ModelCapabilities, type ModelTier } from './modelCapabilities';

/** Shape returned by GET /api/stealth/models. Extra fields are ignored. */
interface GatewayModelInfo {
  id?: string;
  displayName?: string;
  contextWindow?: number;
  contextLength?: number;
  tier?: string;
  vision?: boolean;
  tools?: boolean;
  thinking?: boolean;
  cloud?: boolean;
  available?: boolean;
  recommendedMaxIterations?: number;
}

export interface GatewayCatalogEntry {
  id: string;
  caps: ModelCapabilities;
  available: boolean;
  recommendedMaxIterations?: number;
}

function normalizeTier(raw: unknown, contextWindow: number): ModelTier {
  const t = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (t === 'small' || t === 'medium' || t === 'large') {return t;}
  // Fall back to the same shape the gateway uses when it derives tier itself.
  if (contextWindow >= 131072) {return 'large';}
  if (contextWindow >= 32768) {return 'medium';}
  return 'small';
}

/**
 * Convert one catalog row into a capability profile.
 *
 * `tools` and `vision` are read strictly: only an explicit `true` enables them.
 * A catalog that omits the field must not be read as "supported" — the failure
 * mode of a false positive here is sending native schemas to a model that
 * can't parse them, which breaks the turn outright.
 */
export function catalogEntryToCapabilities(model: GatewayModelInfo): GatewayCatalogEntry | null {
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) {return null;}
  const contextWindow = typeof model.contextWindow === 'number' && model.contextWindow > 0
    ? model.contextWindow
    : typeof model.contextLength === 'number' && model.contextLength > 0
      ? model.contextLength
      : 8192;
  return {
    id,
    available: model.available !== false,
    recommendedMaxIterations: typeof model.recommendedMaxIterations === 'number'
      ? model.recommendedMaxIterations
      : undefined,
    caps: {
      contextWindow,
      // The catalog has no json-mode field; every hosted model that supports
      // tools supports structured output, and the flag is only a formatting
      // hint, so deriving it from `tools` is safe here.
      supportsJsonMode: model.tools === true,
      supportsToolCalling: model.tools === true,
      supportsVision: model.vision === true,
      tier: normalizeTier(model.tier, contextWindow),
      label: typeof model.displayName === 'string' && model.displayName.trim()
        ? model.displayName.trim()
        : id
    }
  };
}

export interface FetchGatewayCatalogOptions {
  gatewayUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the catalog and register every entry as authoritative.
 *
 * Returns the parsed entries so callers can also drive a model picker from the
 * same round-trip. Returns an empty array on any failure.
 */
export async function syncGatewayModelCapabilities(
  options: FetchGatewayCatalogOptions
): Promise<GatewayCatalogEntry[]> {
  const { gatewayUrl, apiKey, timeoutMs = 8000 } = options;
  if (!gatewayUrl) {return [];}
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${gatewayUrl.replace(/\/+$/, '')}/api/stealth/models`;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) {headers.Authorization = `Bearer ${apiKey}`;}
    const res = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {return [];}
    const body = await res.json() as unknown;
    const rows: GatewayModelInfo[] = Array.isArray(body)
      ? body as GatewayModelInfo[]
      : Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: GatewayModelInfo[] }).models
        : [];
    const entries: GatewayCatalogEntry[] = [];
    for (const row of rows) {
      const entry = catalogEntryToCapabilities(row);
      if (!entry) {continue;}
      registerModelCapabilities(entry.id, entry.caps, { authoritative: true });
      entries.push(entry);
    }
    return entries;
  } catch {
    // Offline, unauthenticated, timed out, or malformed — keep the built-ins.
    return [];
  }
}
