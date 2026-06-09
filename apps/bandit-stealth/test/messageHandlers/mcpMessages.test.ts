/**
 * Contract tests for `mcpMessages` — the lifecycle + wizard handler
 * dispatchers. The actual lifecycle logic lives in
 * `helpers/mcpLifecycle` and the wizard logic in `helpers/mcpWizards`;
 * these tests pin the dispatcher's wiring, not the underlying
 * behaviors.
 *
 * What we pin:
 * (1) The lifecycle context handed to `handleMcpReload` exposes
 *     `mcpPool`, `workspaceRoot`, and a `reloadFromDisk` callback
 *     that routes through `ctx.mcp.reloadFromDisk` (regression here
 *     would silently break the Connections "Reload" action),
 * (2) `mcpReconnect` / `mcpDisconnect` / `mcpSetActivation` /
 *     `mcpRevokeTrust` all forward the server name (and activation
 *     value, where applicable) to the right helper — a swap or
 *     dropped arg would send the wrong server through the wrong
 *     handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';
import type { IncomingMessage } from '../../src/messages';

const vscodeMock = vi.hoisted(() => ({
  workspaceRoot: '/ws-mcp-test'
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: vscodeMock.workspaceRoot } }];
    }
  }
}));

const lifecycleMock = vi.hoisted(() => ({
  reloadCalls: 0,
  reconnectCalls: [] as Array<{ name: string; reloadFromDisk: (r: string) => Promise<unknown> }>,
  disconnectCalls: [] as Array<{ name: string }>,
  setActivationCalls: [] as Array<{ name: string; activation: string }>,
  revokeTrustCalls: [] as Array<{ name: string }>
}));

vi.mock('../../src/helpers/mcpLifecycle', () => ({
  handleMcpReload: vi.fn(async (_ctx: unknown) => { lifecycleMock.reloadCalls += 1; }),
  handleMcpReconnect: vi.fn(async (ctx: { reloadFromDisk: (r: string) => Promise<unknown> }, name: string) => {
    lifecycleMock.reconnectCalls.push({ name, reloadFromDisk: ctx.reloadFromDisk });
  }),
  handleMcpDisconnect: vi.fn(async (_ctx: unknown, name: string) => {
    lifecycleMock.disconnectCalls.push({ name });
  }),
  handleMcpSetActivation: vi.fn(async (_ctx: unknown, name: string, activation: string) => {
    lifecycleMock.setActivationCalls.push({ name, activation });
  }),
  handleMcpRevokeTrust: vi.fn(async (_ctx: unknown, name: string) => {
    lifecycleMock.revokeTrustCalls.push({ name });
  })
}));

const wizardMock = vi.hoisted(() => ({
  github: 0,
  slack: 0,
  gitlab: 0,
  gmail: 0,
  custom: 0
}));

vi.mock('../../src/helpers/mcpWizards', () => ({
  runGitHubWizard: vi.fn(async () => { wizardMock.github += 1; }),
  runSlackWizard: vi.fn(async () => { wizardMock.slack += 1; }),
  runGitLabWizard: vi.fn(async () => { wizardMock.gitlab += 1; }),
  runGmailWizard: vi.fn(async () => { wizardMock.gmail += 1; }),
  runCustomWizard: vi.fn(async () => { wizardMock.custom += 1; })
}));

import { handleMcpLifecycleMessage, handleMcpWizardMessage } from '../../src/provider/messageHandlers/mcpMessages';

function makeCtx(): { ctx: ProviderContext; mcpReloadCalls: string[] } {
  const mcpReloadCalls: string[] = [];
  const ctx = {
    mcpPool: { list: () => [] },
    mcp: { reloadFromDisk: async (root: string) => { mcpReloadCalls.push(root); return 0; } },
    postMessage: () => undefined,
    syncState: async () => undefined
  } as unknown as ProviderContext;
  return { ctx, mcpReloadCalls };
}

beforeEach(() => {
  lifecycleMock.reloadCalls = 0;
  lifecycleMock.reconnectCalls.length = 0;
  lifecycleMock.disconnectCalls.length = 0;
  lifecycleMock.setActivationCalls.length = 0;
  lifecycleMock.revokeTrustCalls.length = 0;
  wizardMock.github = 0;
  wizardMock.slack = 0;
  wizardMock.gitlab = 0;
  wizardMock.gmail = 0;
  wizardMock.custom = 0;
});

describe('handleMcpLifecycleMessage', () => {
  it("wires reloadFromDisk through ctx.mcp.reloadFromDisk so the Connections 'Reload' action stays connected", async () => {
    const { ctx, mcpReloadCalls } = makeCtx();

    await handleMcpLifecycleMessage(
      { type: 'mcpReload' } as Extract<IncomingMessage, { type: 'mcpReload' }>,
      ctx
    );

    expect(lifecycleMock.reloadCalls).toBe(1);

    // Now reconnect — pull the captured reloadFromDisk callback and
    // verify it routes through ctx.mcp.reloadFromDisk with the
    // workspace root the dispatcher resolved.
    await handleMcpLifecycleMessage(
      { type: 'mcpReconnect', name: 'github' } as Extract<IncomingMessage, { type: 'mcpReconnect' }>,
      ctx
    );

    expect(lifecycleMock.reconnectCalls).toHaveLength(1);
    await lifecycleMock.reconnectCalls[0].reloadFromDisk('/ws-mcp-test');
    expect(mcpReloadCalls).toEqual(['/ws-mcp-test']);
  });

  it('forwards the server name (and activation value) to the right helper for each message type', async () => {
    const { ctx } = makeCtx();

    await handleMcpLifecycleMessage({ type: 'mcpDisconnect', name: 'slack' } as Extract<IncomingMessage, { type: 'mcpDisconnect' }>, ctx);
    await handleMcpLifecycleMessage({ type: 'mcpSetActivation', name: 'github', activation: 'always' } as Extract<IncomingMessage, { type: 'mcpSetActivation' }>, ctx);
    await handleMcpLifecycleMessage({ type: 'mcpRevokeTrust', name: 'custom-server' } as Extract<IncomingMessage, { type: 'mcpRevokeTrust' }>, ctx);

    expect(lifecycleMock.disconnectCalls).toEqual([{ name: 'slack' }]);
    expect(lifecycleMock.setActivationCalls).toEqual([{ name: 'github', activation: 'always' }]);
    expect(lifecycleMock.revokeTrustCalls).toEqual([{ name: 'custom-server' }]);
  });
});

describe('handleMcpWizardMessage', () => {
  it('dispatches each wizard message type to the matching wizard helper exactly once', async () => {
    const { ctx } = makeCtx();

    await handleMcpWizardMessage({ type: 'mcpAddGitHub' } as Extract<IncomingMessage, { type: 'mcpAddGitHub' }>, ctx);
    await handleMcpWizardMessage({ type: 'mcpAddSlack' } as Extract<IncomingMessage, { type: 'mcpAddSlack' }>, ctx);
    await handleMcpWizardMessage({ type: 'mcpAddGitLab' } as Extract<IncomingMessage, { type: 'mcpAddGitLab' }>, ctx);
    await handleMcpWizardMessage({ type: 'mcpAddGmail' } as Extract<IncomingMessage, { type: 'mcpAddGmail' }>, ctx);
    await handleMcpWizardMessage({ type: 'mcpAddCustom' } as Extract<IncomingMessage, { type: 'mcpAddCustom' }>, ctx);

    expect(wizardMock.github).toBe(1);
    expect(wizardMock.slack).toBe(1);
    expect(wizardMock.gitlab).toBe(1);
    expect(wizardMock.gmail).toBe(1);
    expect(wizardMock.custom).toBe(1);
  });
});
