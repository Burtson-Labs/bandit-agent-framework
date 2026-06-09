/**
 * Contract tests for `bridgeMessages` — the grab-bag handlers.
 *
 * These tests pin the boundary the extraction was meant to preserve:
 * (1) `handleRunVscodeCommand` strict allowlist: only
 *     `banditStealth.*` commands are forwarded; anything else is
 *     silently dropped. The webview must not be able to invoke
 *     `workbench.action.*` / `editor.action.*` / etc. (that
 *     command surface is too broad to expose).
 * (2) `handleRunShellCommand` refuses catastrophic patterns
 *     (`rm -rf`, `mkfs`, `dd if=`, `rmdir /`) inline with an error
 *     toast and never spawns/reuses the terminal. Refusing here
 *     stops a mistyped paste from running on the user's machine
 *     just because they hit Enter.
 * (3) `handleRunShellCommand` reuses the existing
 *     `'Bandit · shell'` terminal if one is present (so successive
 *     `!` calls stack in the same scrollback); creates a fresh
 *     one only when no match exists.
 * (4) `handleSubmitFeedback` forwards (messageId, rating) to deps
 *     verbatim — the bridge handler is the dispatch hop, not the
 *     pipeline.
 * (5) `handleDismissIntentSuggestions` writes the global config
 *     toggle THEN re-syncs (state-then-render ordering — the
 *     webview must see the updated flag on next syncState).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';
import type { BridgeMessageDeps } from '../../src/provider/messageHandlers/bridgeMessages';
import type { IncomingMessage } from '../../src/messages';

const vscodeMock = vi.hoisted(() => ({
  executedCommands: [] as string[],
  errors: [] as string[],
  // Terminals list — the handler does .find() over this.
  terminals: [] as Array<{ name: string; show: (preserveFocus: boolean) => void; sendText: (cmd: string) => void; shown: number; sent: string[] }>,
  createdTerminals: [] as Array<{ name: string; cwd?: string }>,
  configUpdates: [] as Array<{ section: string; key: string; value: unknown; target: unknown }>,
  workspaceFolders: [{ uri: { fsPath: '/ws-bridge' } }]
}));

function makeTerminal(name: string) {
  const t = {
    name,
    shown: 0,
    sent: [] as string[],
    show: (_preserveFocus: boolean) => { t.shown += 1; },
    sendText: (cmd: string) => { t.sent.push(cmd); }
  };
  return t;
}

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return vscodeMock.workspaceFolders; },
    getConfiguration: (section: string) => ({
      update: async (key: string, value: unknown, target: unknown) => {
        vscodeMock.configUpdates.push({ section, key, value, target });
      }
    })
  },
  window: {
    showErrorMessage: vi.fn(async (msg: string) => { vscodeMock.errors.push(msg); return undefined; }),
    get terminals() { return vscodeMock.terminals; },
    createTerminal: (opts: { name: string; cwd?: string }) => {
      vscodeMock.createdTerminals.push({ name: opts.name, cwd: opts.cwd });
      const t = makeTerminal(opts.name);
      vscodeMock.terminals.push(t);
      return t;
    }
  },
  commands: {
    executeCommand: vi.fn(async (cmd: string) => { vscodeMock.executedCommands.push(cmd); })
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 }
}));

import {
  handleDismissIntent,
  handleDismissIntentSuggestions,
  handleRunShellCommand,
  handleRunVscodeCommand,
  handleSubmitFeedback
} from '../../src/provider/messageHandlers/bridgeMessages';

function makeCtx(): { ctx: ProviderContext; syncCalls: number; intentDismissCalls: number } {
  let syncCalls = 0;
  let intentDismissCalls = 0;
  const ctx = {
    syncState: async () => { syncCalls += 1; },
    intent: { dismiss: async () => { intentDismissCalls += 1; } },
    postMessage: () => undefined
  } as unknown as ProviderContext;
  return {
    ctx,
    get syncCalls() { return syncCalls; },
    get intentDismissCalls() { return intentDismissCalls; }
  } as never;
}

beforeEach(() => {
  vscodeMock.executedCommands.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.terminals.length = 0;
  vscodeMock.createdTerminals.length = 0;
  vscodeMock.configUpdates.length = 0;
  vscodeMock.workspaceFolders = [{ uri: { fsPath: '/ws-bridge' } }];
});

describe('handleRunVscodeCommand', () => {
  it("strict allowlist — banditStealth.* commands forward, ALL others (workbench.action.*, editor.action.*, '', non-string) are silently dropped", async () => {
    for (const cmd of ['workbench.action.openSettings', 'editor.action.gotoLine', '', 'arbitrary-cmd']) {
      handleRunVscodeCommand({ type: 'runVscodeCommand', command: cmd } as Extract<IncomingMessage, { type: 'runVscodeCommand' }>);
    }
    // None of the dangerous / unrelated commands should have fired.
    expect(vscodeMock.executedCommands).toHaveLength(0);

    handleRunVscodeCommand({ type: 'runVscodeCommand', command: 'banditStealth.openSettings' } as Extract<IncomingMessage, { type: 'runVscodeCommand' }>);
    expect(vscodeMock.executedCommands).toEqual(['banditStealth.openSettings']);
  });
});

describe('handleRunShellCommand', () => {
  it('refuses catastrophic patterns (rm -rf, mkfs, dd if=, rmdir /) inline with an error toast and never spawns/reuses a terminal', () => {
    const dangerous = ['rm -rf /', 'rm -rf .', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda', 'rmdir /'];
    for (const cmd of dangerous) {
      vscodeMock.errors.length = 0;
      vscodeMock.terminals.length = 0;
      vscodeMock.createdTerminals.length = 0;
      handleRunShellCommand({ type: 'runShellCommand', command: cmd } as Extract<IncomingMessage, { type: 'runShellCommand' }>);
      expect(vscodeMock.errors).toHaveLength(1);
      expect(vscodeMock.errors[0]).toContain('Refusing to run');
      expect(vscodeMock.errors[0]).toContain('matches blocked pattern');
      expect(vscodeMock.terminals).toHaveLength(0);
      expect(vscodeMock.createdTerminals).toHaveLength(0);
    }
  });

  it("reuses the existing 'Bandit · shell' terminal when present (so successive `!` calls stack in the same scrollback); creates a fresh one only when no match exists", () => {
    // Case A: no existing terminal — create one.
    handleRunShellCommand({ type: 'runShellCommand', command: 'pnpm test' } as Extract<IncomingMessage, { type: 'runShellCommand' }>);
    expect(vscodeMock.createdTerminals).toEqual([{ name: 'Bandit · shell', cwd: '/ws-bridge' }]);
    expect(vscodeMock.terminals).toHaveLength(1);
    expect(vscodeMock.terminals[0].sent).toEqual(['pnpm test']);
    expect(vscodeMock.terminals[0].shown).toBe(1);

    // Case B: an existing matching terminal — REUSE, don't create.
    vscodeMock.createdTerminals.length = 0;
    handleRunShellCommand({ type: 'runShellCommand', command: 'ls -la' } as Extract<IncomingMessage, { type: 'runShellCommand' }>);
    expect(vscodeMock.createdTerminals).toHaveLength(0);
    expect(vscodeMock.terminals).toHaveLength(1);
    expect(vscodeMock.terminals[0].sent).toEqual(['pnpm test', 'ls -la']);
    expect(vscodeMock.terminals[0].shown).toBe(2);
  });
});

describe('handleSubmitFeedback', () => {
  it('forwards (messageId, rating) to deps.submitFeedback verbatim — the bridge handler is the dispatch hop, not the pipeline', async () => {
    const { ctx } = makeCtx();
    const calls: Array<{ id: string; rating: string }> = [];
    const deps: BridgeMessageDeps = {
      submitFeedback: async (id, rating) => { calls.push({ id, rating }); }
    };

    await handleSubmitFeedback(ctx, deps, 'msg-7', 'thumbs-up');
    await handleSubmitFeedback(ctx, deps, 'msg-8', 'thumbs-down');

    expect(calls).toEqual([
      { id: 'msg-7', rating: 'thumbs-up' },
      { id: 'msg-8', rating: 'thumbs-down' }
    ]);
  });
});

describe('handleDismissIntent / handleDismissIntentSuggestions', () => {
  it('handleDismissIntent forwards to ctx.intent.dismiss() without touching config or syncState', async () => {
    const wrap = makeCtx();

    await handleDismissIntent(wrap.ctx);

    expect(wrap.intentDismissCalls).toBe(1);
    expect(vscodeMock.configUpdates).toHaveLength(0);
    expect(wrap.syncCalls).toBe(0);
  });

  it('handleDismissIntentSuggestions writes the intent.showSuggestions=false global config toggle, THEN re-syncs (state-then-render ordering)', async () => {
    const order: string[] = [];
    const ctx = {
      syncState: async () => { order.push('syncState'); },
      intent: { dismiss: async () => undefined },
      postMessage: () => undefined
    } as unknown as ProviderContext;
    // Tag the config.update mock to record ordering — simpler than
    // monkey-patching the configUpdates array's push.
    const origUpdate = vscodeMock.configUpdates;
    vscodeMock.configUpdates = new Proxy(origUpdate, {
      get(target, prop, receiver) {
        if (prop === 'push') {
          return (entry: unknown) => { order.push('config.update'); return Array.prototype.push.call(target, entry); };
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    await handleDismissIntentSuggestions(ctx);

    expect(origUpdate).toHaveLength(1);
    expect(origUpdate[0]).toMatchObject({ section: 'banditStealth', key: 'intent.showSuggestions', value: false });
    expect(order).toEqual(['config.update', 'syncState']);

    vscodeMock.configUpdates = origUpdate;
  });
});
