import type { buildMcpSnapshot } from '../helpers/mcpLifecycle';

/**
 * Slow-changing slice of the webview state — the secret reads and the
 * MCP snapshot rebuild that don't need to refire on every streaming
 * tick. Resolving this slice cost ~120 secret reads/sec + ~60 MCP
 * snapshot builds/sec at sustained 30-60 tok/s on the pre-v1.7.347
 * code path, which is what made the IDE feel laggy next to the CLI.
 *
 * The cache populates on the first flush of a turn and reuses until
 * `invalidate()` fires from a key/secret mutation, an MCP pool change,
 * or a `banditStealth.*` config change. Outside of streaming we
 * bypass the cache and re-resolve, so external mutations (the CLI's
 * /tavily writing the same config.json file, a sibling window setting
 * a key, etc.) reflect on the very next flush.
 */
export interface SlowStateCacheValue {
  hasApiKey: boolean;
  hasStoredApiKey: boolean;
  apiKeyTrimmed: string | undefined;
  hasOllamaAuthToken: boolean;
  hasTavilyKey: boolean;
  mcpSnapshot: Awaited<ReturnType<typeof buildMcpSnapshot>>;
}

export class SlowStateCache {
  private value: SlowStateCacheValue | undefined;

  get(): SlowStateCacheValue | undefined {
    return this.value;
  }

  set(value: SlowStateCacheValue): void {
    this.value = value;
  }

  /**
   * Drop the cached slice. Call whenever a value the cache holds
   * (a secret, an MCP server, the Tavily key location) actually
   * mutates — next flushState will refresh it. Safe to call when the
   * cache is already undefined.
   *
   * All eight in-class mutation sites — promptForApiKey, clearApiKey,
   * setOllamaAuthToken, clearOllamaAuthToken, setTavilyKey, and the
   * webview-message bridges for setApiKey + signInWithBurtson — funnel
   * through this method, as does the external `onDidChangeConfiguration`
   * listener in activate(). Drop a `console.warn` here during a sweep
   * to audit that every mutation surface still triggers a fresh resolve.
   */
  invalidate(): void {
    this.value = undefined;
  }
}
