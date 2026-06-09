/**
 * models.dev catalog adapter.
 *
 * https://models.dev/api.json is a community-maintained model metadata
 * catalog (MIT-licensed, used by sst/opencode). Each provider entry
 * lists every published model with context window, output cap,
 * tool-calling support, vision support, and pricing. We use it to
 * populate the runtime capability registry for openai-compatible
 * upstreams (LM Studio, llama.cpp, vLLM, OpenRouter, Together, Groq,
 * DeepSeek, OpenAI proper) that aren't in our hand-curated built-in
 * profile list — without it those models inherit the conservative
 * default and miss out on tier-tuned context budgets, output gates,
 * vision routing, etc.
 *
 * Caching:
 *   - In-memory map for the lifetime of the process.
 *   - Disk cache at `~/.bandit/cache/models-dev.json` + an `.etag`
 *     sidecar; revalidated against the server with `If-None-Match`
 *     once per 24h. 304 Not Modified keeps the on-disk JSON.
 *   - First-run fetch downloads ~250 KB gzipped (~1.9 MB raw).
 *     Subsequent launches usually return 304 in <100 ms.
 *
 * Failures are silent: when the catalog is unreachable or the model
 * isn't listed, lookupModelsDevCapabilities returns null and the
 * caller falls back to whatever default it had.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModelCapabilities, ModelTier } from './modelCapabilities';

const CATALOG_URL = 'https://models.dev/api.json';
const REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

// Resolved lazily rather than at module load. `os.homedir()` / `path.join`
// are externalized to `undefined` in browser bundles (the Stealth Web host
// imports this module transitively via the capability registry). Computing
// these at top level executed `undefined()` on import and blanked the whole
// web app before React mounted. Inside the cache helpers they only run on a
// real Node host; in the browser the surrounding try/catch degrades to "no
// disk cache" and the in-memory + network paths still work.
function cachePaths(): { dir: string; file: string; etag: string; stamp: string } {
  const dir = path.join(os.homedir(), '.bandit', 'cache');
  return {
    dir,
    file: path.join(dir, 'models-dev.json'),
    etag: path.join(dir, 'models-dev.etag'),
    stamp: path.join(dir, 'models-dev.stamp')
  };
}

interface ModelsDevModel {
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number; input?: number };
  cost?: { input?: number; output?: number };
}

interface ModelsDevProvider {
  id: string;
  name?: string;
  api?: string;
  npm?: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

let inMemoryCatalog: ModelsDevCatalog | null = null;
let baseUrlIndex: Map<string, string> | null = null;
let inflightLoad: Promise<ModelsDevCatalog | null> | null = null;

/**
 * Normalise an OpenAI-compatible base URL for matching against the
 * `api` field models.dev publishes per provider. Strips trailing
 * slashes and `/v1` suffixes since some providers list with `/v1` and
 * some without.
 */
function normalizeBaseUrl(url: string): string {
  let out = url.trim().toLowerCase().replace(/\/+$/, '');
  if (out.endsWith('/v1')) {out = out.slice(0, -3);}
  return out;
}

function buildBaseUrlIndex(catalog: ModelsDevCatalog): Map<string, string> {
  const map = new Map<string, string>();
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider?.api) {continue;}
    map.set(normalizeBaseUrl(provider.api), providerId);
  }
  return map;
}

async function readDiskCache(): Promise<{ catalog: ModelsDevCatalog | null; etag: string | null; stale: boolean }> {
  try {
    const { file, etag: etagPath, stamp: stampPath } = cachePaths();
    const [raw, etag, stamp] = await Promise.all([
      fs.promises.readFile(file, 'utf-8').catch(() => null),
      fs.promises.readFile(etagPath, 'utf-8').catch(() => null),
      fs.promises.readFile(stampPath, 'utf-8').catch(() => null)
    ]);
    if (!raw) {return { catalog: null, etag: null, stale: true };}
    const catalog = JSON.parse(raw) as ModelsDevCatalog;
    const writtenAt = stamp ? parseInt(stamp.trim(), 10) : 0;
    const stale = !Number.isFinite(writtenAt) || (Date.now() - writtenAt) > REVALIDATE_AFTER_MS;
    return { catalog, etag: etag?.trim() || null, stale };
  } catch {
    return { catalog: null, etag: null, stale: true };
  }
}

async function writeDiskCache(catalog: ModelsDevCatalog, etag: string | null): Promise<void> {
  try {
    const { dir, file, etag: etagPath, stamp: stampPath } = cachePaths();
    await fs.promises.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.promises.writeFile(file, JSON.stringify(catalog), 'utf-8'),
      fs.promises.writeFile(etagPath, etag ?? '', 'utf-8'),
      fs.promises.writeFile(stampPath, String(Date.now()), 'utf-8')
    ]);
  } catch {
    // Cache writes are best-effort. Inability to write to ~/.bandit/
    // shouldn't break agent operation — the in-memory copy still works
    // for the rest of this process.
  }
}

async function loadCatalog(): Promise<ModelsDevCatalog | null> {
  if (inMemoryCatalog) {return inMemoryCatalog;}
  if (inflightLoad) {return inflightLoad;}
  inflightLoad = (async () => {
    const disk = await readDiskCache();
    // Fast path: fresh on-disk copy, use it without a network round-trip.
    if (disk.catalog && !disk.stale) {
      inMemoryCatalog = disk.catalog;
      baseUrlIndex = buildBaseUrlIndex(disk.catalog);
      return disk.catalog;
    }
    // Otherwise revalidate against the server. If the server is
    // unreachable or returns garbage, fall back to the stale on-disk
    // copy when we have one — better than zero metadata.
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (disk.etag) {headers['If-None-Match'] = disk.etag;}
      const response = await fetch(CATALOG_URL, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000)
      });
      if (response.status === 304 && disk.catalog) {
        // ETag still matches — refresh the stamp so we don't revalidate
        // again for another 24h.
        inMemoryCatalog = disk.catalog;
        baseUrlIndex = buildBaseUrlIndex(disk.catalog);
        await writeDiskCache(disk.catalog, disk.etag);
        return disk.catalog;
      }
      if (!response.ok) {
        if (disk.catalog) {
          inMemoryCatalog = disk.catalog;
          baseUrlIndex = buildBaseUrlIndex(disk.catalog);
          return disk.catalog;
        }
        return null;
      }
      const fresh = (await response.json()) as ModelsDevCatalog;
      const newEtag = response.headers.get('etag');
      inMemoryCatalog = fresh;
      baseUrlIndex = buildBaseUrlIndex(fresh);
      await writeDiskCache(fresh, newEtag);
      return fresh;
    } catch {
      if (disk.catalog) {
        inMemoryCatalog = disk.catalog;
        baseUrlIndex = buildBaseUrlIndex(disk.catalog);
        return disk.catalog;
      }
      return null;
    }
  })();
  try {
    return await inflightLoad;
  } finally {
    inflightLoad = null;
  }
}

/**
 * Map a models.dev model entry to our internal ModelCapabilities shape.
 * Tier is derived from limit.context: <16K → small, <64K → medium,
 * everything else → large. Matches the heuristic used by the built-in
 * profile table.
 */
function mapToCapabilities(modelId: string, model: ModelsDevModel): ModelCapabilities {
  const contextWindow = model.limit?.context ?? 8192;
  const tier: ModelTier = contextWindow < 16384
    ? 'small'
    : contextWindow < 65536
      ? 'medium'
      : 'large';
  const inputModalities = model.modalities?.input ?? [];
  const supportsVision = inputModalities.includes('image') || model.attachment === true;
  return {
    contextWindow,
    supportsJsonMode: true, // Most OpenAI-compatible providers do; conservative default for unknowns.
    supportsToolCalling: model.tool_call === true,
    supportsVision,
    tier,
    label: model.name ?? modelId
  };
}

/**
 * Resolve capabilities for `(baseUrl, modelId)` from the models.dev
 * catalog. Returns null when the catalog is unavailable, the base URL
 * doesn't match any known provider, or the model isn't listed.
 */
export async function queryModelsDevCapabilities(
  modelId: string,
  baseUrl: string
): Promise<ModelCapabilities | null> {
  if (!modelId || !baseUrl) {return null;}
  const catalog = await loadCatalog();
  if (!catalog) {return null;}
  if (!baseUrlIndex) {baseUrlIndex = buildBaseUrlIndex(catalog);}
  const providerId = baseUrlIndex.get(normalizeBaseUrl(baseUrl));
  if (!providerId) {return null;}
  const provider = catalog[providerId];
  if (!provider?.models) {return null;}
  // models.dev model IDs are sometimes case-sensitive (e.g. OpenRouter's
  // `openai/gpt-4o` — the slash matters), so try the exact key first
  // and only fall back to a case-insensitive scan if that misses.
  const direct = provider.models[modelId];
  if (direct) {return mapToCapabilities(modelId, direct);}
  const lower = modelId.toLowerCase();
  for (const [id, model] of Object.entries(provider.models)) {
    if (id.toLowerCase() === lower) {return mapToCapabilities(id, model);}
  }
  return null;
}
