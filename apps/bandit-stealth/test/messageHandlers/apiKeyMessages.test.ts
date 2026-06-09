/**
 * Contract tests for `apiKeyMessages` — `handleSetApiKey` (paste-key
 * flow) and `handleSignInWithBurtson` (PKCE OAuth flow).
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `handleSetApiKey` rejects empty/whitespace input with a
 *     graceful `notification` post and does NOT touch SecretStorage
 *     (the no-empty-key invariant — saving "" would silently sign
 *     the user out without explaining why),
 * (2) `handleSetApiKey` cancels the active stream BEFORE writing the
 *     new key (no in-flight call races a rotated credential), then
 *     persists, invalidates slowStateCache, syncs, and fires the
 *     account refresh,
 * (3) `handleSignInWithBurtson` posts a graceful
 *     `Sign-in failed: ...` notification when the OAuth flow throws
 *     and never re-throws — the user's chat session must survive a
 *     browser-cancelled sign-in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';
import type { ApiKeyMessageDeps } from '../../src/provider/messageHandlers/apiKeyMessages';
import type { IncomingMessage } from '../../src/messages';

vi.mock('vscode', () => ({}));

const oauthMock = vi.hoisted(() => ({
  shouldThrow: undefined as Error | undefined,
  nextResult: { apiKey: 'sk_oauth_xyz', name: 'Mark' } as { apiKey: string; name?: string }
}));

vi.mock('../../src/auth/oauthFlow', () => ({
  runOAuthSignIn: vi.fn(async () => {
    if (oauthMock.shouldThrow) throw oauthMock.shouldThrow;
    return oauthMock.nextResult;
  })
}));

import { handleSetApiKey, handleSignInWithBurtson } from '../../src/provider/messageHandlers/apiKeyMessages';

function makeCtx(): {
  ctx: ProviderContext;
  posted: Array<Record<string, unknown>>;
  secretWrites: Array<{ key: string; value: string }>;
  invalidateCalls: number;
  syncCalls: number;
  refreshCalls: number;
} {
  const posted: Array<Record<string, unknown>> = [];
  const secretWrites: Array<{ key: string; value: string }> = [];
  let invalidateCalls = 0;
  let syncCalls = 0;
  let refreshCalls = 0;

  const ctx = {
    extensionContext: {
      secrets: {
        store: vi.fn(async (key: string, value: string) => { secretWrites.push({ key, value }); }),
        get: vi.fn(),
        delete: vi.fn()
      }
    },
    account: { refresh: async () => { refreshCalls += 1; } },
    postMessage: (msg: Record<string, unknown>) => { posted.push(msg); },
    syncState: async () => { syncCalls += 1; },
    invalidateSlowStateCache: () => { invalidateCalls += 1; }
  } as unknown as ProviderContext;

  return {
    ctx,
    posted,
    secretWrites,
    get invalidateCalls() { return invalidateCalls; },
    get syncCalls() { return syncCalls; },
    get refreshCalls() { return refreshCalls; }
  } as never;
}

function makeDeps(): { deps: ApiKeyMessageDeps; cancelCalls: number; resetBusyCalls: number } {
  let cancelCalls = 0;
  let resetBusyCalls = 0;
  const deps: ApiKeyMessageDeps = {
    cancelActiveStream: () => { cancelCalls += 1; },
    resetBusyImmediate: () => { resetBusyCalls += 1; }
  };
  return {
    deps,
    get cancelCalls() { return cancelCalls; },
    get resetBusyCalls() { return resetBusyCalls; }
  } as never;
}

beforeEach(() => {
  oauthMock.shouldThrow = undefined;
  oauthMock.nextResult = { apiKey: 'sk_oauth_xyz', name: 'Mark' };
});

describe('handleSetApiKey', () => {
  it("rejects empty/whitespace input with a graceful notification and never touches SecretStorage", async () => {
    for (const value of ['', '   ', '\t\n']) {
      const ctxWrap = makeCtx();
      const depsWrap = makeDeps();

      await handleSetApiKey(
        { type: 'setApiKey', value } as Extract<IncomingMessage, { type: 'setApiKey' }>,
        ctxWrap.ctx,
        depsWrap.deps
      );

      expect(ctxWrap.posted).toHaveLength(1);
      expect(ctxWrap.posted[0]).toMatchObject({ type: 'notification' });
      expect((ctxWrap.posted[0] as { message: string }).message).toContain('cannot be empty');
      expect(ctxWrap.secretWrites).toHaveLength(0);
      expect(depsWrap.cancelCalls).toBe(0);
      expect(ctxWrap.invalidateCalls).toBe(0);
      expect(ctxWrap.refreshCalls).toBe(0);
    }
  });

  it('cancels the stream BEFORE writing, then persists, invalidates slowStateCache, syncs, and fires account refresh', async () => {
    const ctxWrap = makeCtx();
    const depsWrap = makeDeps();
    // capture the order of operations.
    const order: string[] = [];
    const originalStore = (ctxWrap.ctx.extensionContext.secrets as { store: (...args: unknown[]) => unknown }).store;
    (ctxWrap.ctx.extensionContext.secrets as { store: (...args: unknown[]) => unknown }).store = async (k: string, v: string) => {
      order.push('secrets.store');
      return originalStore.call(ctxWrap.ctx.extensionContext.secrets, k, v);
    };

    await handleSetApiKey(
      { type: 'setApiKey', value: 'bai_real_key_42' } as Extract<IncomingMessage, { type: 'setApiKey' }>,
      ctxWrap.ctx,
      {
        cancelActiveStream: () => { order.push('cancelActiveStream'); depsWrap.deps.cancelActiveStream(); },
        resetBusyImmediate: depsWrap.deps.resetBusyImmediate
      }
    );

    expect(order).toEqual(['cancelActiveStream', 'secrets.store']);
    expect(ctxWrap.secretWrites).toEqual([{ key: 'banditStealth.apiKey', value: 'bai_real_key_42' }]);
    expect(ctxWrap.invalidateCalls).toBe(1);
    expect(ctxWrap.syncCalls).toBe(1);
    expect(ctxWrap.refreshCalls).toBe(1);
    expect(depsWrap.resetBusyCalls).toBe(1);
  });
});

describe('handleSignInWithBurtson', () => {
  it('posts a graceful Sign-in failed notification when OAuth throws and never re-throws (chat session survives)', async () => {
    const ctxWrap = makeCtx();
    oauthMock.shouldThrow = new Error('user closed browser');

    await expect(handleSignInWithBurtson(ctxWrap.ctx)).resolves.toBeUndefined();

    // First post: "Opening browser…" notification. Second: failure.
    expect(ctxWrap.posted).toHaveLength(2);
    expect(ctxWrap.posted[0]).toMatchObject({ type: 'notification' });
    expect((ctxWrap.posted[0] as { message: string }).message).toContain('Opening browser');
    expect((ctxWrap.posted[1] as { message: string }).message).toContain('Sign-in failed');
    expect((ctxWrap.posted[1] as { message: string }).message).toContain('user closed browser');
    expect(ctxWrap.secretWrites).toHaveLength(0);
    expect(ctxWrap.invalidateCalls).toBe(0);
    expect(ctxWrap.refreshCalls).toBe(0);
  });

  it('persists the OAuth-issued key on success and greets by name when present', async () => {
    const ctxWrap = makeCtx();

    await handleSignInWithBurtson(ctxWrap.ctx);

    expect(ctxWrap.secretWrites).toEqual([{ key: 'banditStealth.apiKey', value: 'sk_oauth_xyz' }]);
    expect(ctxWrap.invalidateCalls).toBe(1);
    expect(ctxWrap.syncCalls).toBe(1);
    expect(ctxWrap.refreshCalls).toBe(1);
    const greeting = ctxWrap.posted.find((p) => (p.message as string)?.startsWith('Signed in as'));
    expect((greeting as { message: string })?.message).toBe('Signed in as Mark.');
  });
});
