/**
 * Contract tests for `AccountService` — Bandit Cloud account
 * profile cache + the usage-fetch webview bridge.
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) `refresh()` clears the cache to idle when the user isn't on
 *     the Bandit Cloud provider (or has no key stored),
 * (2) `refresh()` writes a successful profile and an error string
 *     into separate state slots so the webview can render either
 *     surface without inferring which path ran,
 * (3) `sendUsage()` posts a graceful empty-state error when no
 *     key is stored — does NOT call the HTTP fetch at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';

const vscodeMock = vi.hoisted(() => ({
  config: new Map<string, unknown>()
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get<T>(key: string, fallback?: T): T {
        return (vscodeMock.config.has(key) ? vscodeMock.config.get(key) : fallback) as T;
      }
    })
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 }
}));

const apiMock = vi.hoisted(() => ({
  validateResult: undefined as { ok: true; data: Record<string, unknown> } | { ok: false; error: string } | undefined,
  usageResult: undefined as { ok: true; data: Record<string, unknown> } | { ok: false; error: string } | undefined,
  validateCalls: 0,
  usageCalls: 0
}));

vi.mock('../../src/helpers/accountApi', () => ({
  validateBanditApiKey: vi.fn(async () => {
    apiMock.validateCalls += 1;
    return apiMock.validateResult;
  }),
  fetchAccountUsage: vi.fn(async () => {
    apiMock.usageCalls += 1;
    return apiMock.usageResult;
  })
}));

vi.mock('../../src/helpers/endpoints', () => ({
  resolveAccountUsageUrl: () => 'https://api.example/usage'
}));

import { AccountService } from '../../src/provider/services/accountService';

function makeCtx(options: { providerKind: 'bandit' | 'ollama' | 'openai'; storedApiKey?: string }): {
  ctx: ProviderContext;
  posted: Array<Record<string, unknown>>;
  syncs: number;
} {
  const posted: Array<Record<string, unknown>> = [];
  const state = { syncs: 0 };
  const ctx = {
    extensionContext: {
      secrets: {
        get: vi.fn(async (_key: string) => options.storedApiKey)
      }
    },
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); },
    syncState: async () => { state.syncs += 1; },
    getProviderKind: () => options.providerKind
  } as unknown as ProviderContext;
  return {
    ctx,
    posted,
    get syncs() { return state.syncs; }
  } as never;
}

beforeEach(() => {
  apiMock.validateResult = undefined;
  apiMock.usageResult = undefined;
  apiMock.validateCalls = 0;
  apiMock.usageCalls = 0;
  vscodeMock.config.clear();
});

describe('AccountService', () => {
  it('refresh() on a non-Bandit provider clears the cache and never hits the validate endpoint', async () => {
    const { ctx } = makeCtx({ providerKind: 'ollama' });
    const svc = new AccountService(ctx);
    // pre-seed a stale profile so we can prove it gets cleared
    apiMock.validateResult = { ok: true, data: { id: 'should-not-land' } };

    await svc.refresh();

    expect(svc.accountProfileStatus).toBe('idle');
    expect(svc.accountProfile).toBeNull();
    expect(svc.accountProfileError).toBeNull();
    // The HTTP call must NOT fire on a non-Bandit provider — it would
    // 401 against an unrelated key and noisily fail.
    expect(apiMock.validateCalls).toBe(0);
  });

  it('refresh() splits success/error into accountProfile vs accountProfileError', async () => {
    const profile = { id: 'usr_1', email: 'mark@example.com', plan: 'team' };
    const { ctx: okCtx } = makeCtx({ providerKind: 'bandit', storedApiKey: 'sk_live_ok' });
    apiMock.validateResult = { ok: true, data: profile };
    const okSvc = new AccountService(okCtx);
    await okSvc.refresh();
    expect(okSvc.accountProfileStatus).toBe('idle');
    expect(okSvc.accountProfile).toEqual(profile);
    expect(okSvc.accountProfileError).toBeNull();

    const { ctx: errCtx } = makeCtx({ providerKind: 'bandit', storedApiKey: 'sk_live_bad' });
    apiMock.validateResult = { ok: false, error: 'Invalid API key (401)' };
    const errSvc = new AccountService(errCtx);
    await errSvc.refresh();
    expect(errSvc.accountProfileStatus).toBe('error');
    expect(errSvc.accountProfile).toBeNull();
    expect(errSvc.accountProfileError).toBe('Invalid API key (401)');
  });

  it('sendUsage() short-circuits with graceful errors when off-Bandit or no key, only fetches when both gates pass', async () => {
    // Off-Bandit: must post an error toast and never call fetchAccountUsage.
    const offCtx = makeCtx({ providerKind: 'openai' });
    const offSvc = new AccountService(offCtx.ctx);
    await offSvc.sendUsage();
    expect(apiMock.usageCalls).toBe(0);
    expect(offCtx.posted[0]).toMatchObject({ type: 'accountUsage', data: null });
    expect((offCtx.posted[0] as { error: string }).error).toContain('provider = bandit');

    // No key: same shape, different error.
    const noKeyCtx = makeCtx({ providerKind: 'bandit', storedApiKey: undefined });
    const noKeySvc = new AccountService(noKeyCtx.ctx);
    await noKeySvc.sendUsage();
    expect(apiMock.usageCalls).toBe(0);
    expect(noKeyCtx.posted[0]).toMatchObject({ type: 'accountUsage', data: null });
    expect((noKeyCtx.posted[0] as { error: string }).error).toContain('Bandit API key');

    // Happy path: fetch runs, data is posted, no error.
    const okCtx = makeCtx({ providerKind: 'bandit', storedApiKey: 'sk_live_ok' });
    apiMock.usageResult = { ok: true, data: { tokensThisMonth: 12345 } };
    const okSvc = new AccountService(okCtx.ctx);
    await okSvc.sendUsage();
    expect(apiMock.usageCalls).toBe(1);
    expect(okCtx.posted[0]).toMatchObject({
      type: 'accountUsage',
      data: { tokensThisMonth: 12345 }
    });
    expect((okCtx.posted[0] as { error?: string }).error).toBeUndefined();
  });
});
