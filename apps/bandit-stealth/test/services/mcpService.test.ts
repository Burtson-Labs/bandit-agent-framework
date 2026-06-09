/**
 * Contract tests for `McpService` — session-scoped MCP pool
 * lifecycle, hydration tracking, and API-key caching.
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) `pool` is lazy and idempotent — first access constructs once,
 *     subsequent accesses return the same instance (no double-init,
 *     no double trust-gate),
 * (2) `ensureHydrated` is a one-shot — the second call is a no-op
 *     even if the first call's underlying register throws, so we
 *     don't retry every turn on a deeper failure,
 * (3) `setBanditApiKey` populates the cache the pool's synchronous
 *     `resolveAuthToken` callback reads (the whole reason the cache
 *     exists — keep that wiring auditable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn() }
}));

const apiCoreMock = vi.hoisted(() => ({
  poolConstructorCalls: 0,
  lastPoolOptions: undefined as { resolveAuthToken?: (k: string) => string | undefined; trustGate?: unknown } | undefined,
  poolListReturn: [] as Array<{ name: string }>
}));

vi.mock('@burtson-labs/agent-core', () => ({
  McpClientPool: class {
    static instanceCount = 0;
    constructor(options?: { resolveAuthToken?: (k: string) => string | undefined; trustGate?: unknown }) {
      apiCoreMock.poolConstructorCalls += 1;
      apiCoreMock.lastPoolOptions = options;
    }
    list() { return apiCoreMock.poolListReturn; }
    dispose() { return Promise.resolve(); }
  },
  fingerprintServerConfig: vi.fn(() => 'fp-123')
}));

const hostKitMock = vi.hoisted(() => ({
  registerCalls: 0,
  registerImpl: undefined as ((root: string, pool: unknown) => Promise<void>) | undefined
}));

vi.mock('@burtson-labs/host-kit', () => ({
  registerMcpServersFromDisk: vi.fn(async (root: string, pool: unknown) => {
    hostKitMock.registerCalls += 1;
    if (hostKitMock.registerImpl) {
      await hostKitMock.registerImpl(root, pool);
    }
  }),
  approveMcpFingerprint: vi.fn(async () => undefined),
  loadApprovedMcpFingerprints: vi.fn(async () => new Set<string>())
}));

vi.mock('../../src/helpers/mcpLifecycle', () => ({
  buildMcpSnapshot: vi.fn(async () => ({ servers: [] }))
}));

import { McpService } from '../../src/provider/services/mcpService';

function makeCtx(): ProviderContext {
  return {} as unknown as ProviderContext;
}

beforeEach(() => {
  apiCoreMock.poolConstructorCalls = 0;
  apiCoreMock.lastPoolOptions = undefined;
  apiCoreMock.poolListReturn = [];
  hostKitMock.registerCalls = 0;
  hostKitMock.registerImpl = undefined;
});

describe('McpService', () => {
  it('pool is lazy and idempotent — first access constructs once, subsequent accesses return the same instance', () => {
    const svc = new McpService(makeCtx());
    expect(apiCoreMock.poolConstructorCalls).toBe(0);

    const p1 = svc.pool;
    const p2 = svc.pool;
    const p3 = svc.pool;

    expect(apiCoreMock.poolConstructorCalls).toBe(1);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
  });

  it('ensureHydrated is a one-shot — the second call is a no-op even if the first call throws', async () => {
    const svc = new McpService(makeCtx());
    hostKitMock.registerImpl = async () => {
      throw new Error('deep failure');
    };

    await svc.ensureHydrated('/workspace');
    await svc.ensureHydrated('/workspace'); // second call must be a no-op
    await svc.ensureHydrated('/different-workspace'); // even with a different root

    // register called exactly once — the failure is caught + hydrated
    // stays true so we don't retry every turn.
    expect(hostKitMock.registerCalls).toBe(1);
  });

  it("setBanditApiKey populates the cache the pool's sync resolveAuthToken callback reads", () => {
    const svc = new McpService(makeCtx());
    // Force pool construction so we can grab the options.
    void svc.pool;
    const resolveAuthToken = apiCoreMock.lastPoolOptions?.resolveAuthToken;
    expect(typeof resolveAuthToken).toBe('function');

    // Empty cache — resolver returns undefined.
    expect(resolveAuthToken!('bandit-api-key')).toBeUndefined();

    svc.setBanditApiKey('sk_live_42');
    expect(resolveAuthToken!('bandit-api-key')).toBe('sk_live_42');

    // Non-bandit kinds always return undefined regardless of cache.
    expect(resolveAuthToken!('other-kind')).toBeUndefined();

    // Clear the cache.
    svc.setBanditApiKey(undefined);
    expect(resolveAuthToken!('bandit-api-key')).toBeUndefined();
  });
});
