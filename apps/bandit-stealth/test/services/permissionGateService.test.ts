/**
 * Contract tests for `PermissionGateService` — the in-chat permission
 * card lifecycle (inject → wait for webview click → replace marker).
 *
 * These tests pin the behavior the extraction was meant to preserve:
 * (1) `request()` mutates the assistant entry in place and posts the
 *     webview event,
 * (2) `respond()` replaces the live card fence with a resolved-summary
 *     marker and settles the Promise with the user's choice,
 * (3) `respond()` is a no-op for an unknown id — a second call with
 *     the same id (e.g. the webview retried after a reload) doesn't
 *     fire the resolver twice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEntry } from '../../src/services/conversationTypes';
import type { ProviderContext } from '../../src/provider/context';

const vscodeMock = vi.hoisted(() => ({
  workspaceRoot: '/tmp/bandit-gate-test' as string | undefined
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return vscodeMock.workspaceRoot
        ? [{ uri: { fsPath: vscodeMock.workspaceRoot } }]
        : undefined;
    }
  }
}));

import { PermissionGateService } from '../../src/provider/services/permissionGateService';

function makeAssistantEntry(content = ''): ConversationEntry {
  return { id: 'a-1', role: 'assistant', content, timestamp: 0, payload: '' };
}

function makeStubCtx(): { ctx: ProviderContext; posted: Array<Record<string, unknown>>; syncs: number } {
  const posted: Array<Record<string, unknown>> = [];
  let syncs = 0;
  const ctx = {
    postMessage: (msg: Record<string, unknown>) => {
      posted.push(msg);
    },
    syncState: async () => {
      syncs += 1;
    }
  } as unknown as ProviderContext;
  return { ctx, posted, get syncs() { return syncs; } } as never;
}

beforeEach(() => {
  vscodeMock.workspaceRoot = '/tmp/bandit-gate-test';
});

describe('PermissionGateService', () => {
  it('request() injects a card fence into the assistant entry and posts permissionRequest', () => {
    const { ctx, posted } = makeStubCtx();
    const svc = new PermissionGateService(ctx);
    const entry = makeAssistantEntry('Working on it.');

    void svc.request({
      tool: 'run_command',
      primary: 'npm install',
      description: 'Install deps',
      bodyPreview: 'npm install',
      command: 'npm install',
      assistantEntry: entry
    });

    expect(svc.pendingCount).toBe(1);
    expect(entry.content).toContain('```bandit-permission');
    expect(entry.content).toContain('"tool":"run_command"');
    expect(entry.content).toContain('"primary":"npm install"');
    // payload is mirrored from content so the webview state-update path
    // surfaces the card on the next flush.
    expect(entry.payload).toBe(entry.content);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'permissionRequest',
      tool: 'run_command',
      primary: 'npm install',
      command: 'npm install'
    });
  });

  it('respond() resolves the request promise and replaces the card with a resolved marker', async () => {
    const { ctx, posted } = makeStubCtx();
    const svc = new PermissionGateService(ctx);
    const entry = makeAssistantEntry();

    const promise = svc.request({
      tool: 'apply_edit',
      primary: '/abs/path/file.ts',
      description: 'Apply a patch',
      assistantEntry: entry
    });

    const requestMsg = posted[0] as { id: string };
    expect(typeof requestMsg.id).toBe('string');
    svc.respond(requestMsg.id, 'once');

    const result = await promise;
    expect(result.choice).toBe('once');
    expect(svc.pendingCount).toBe(0);
    expect(entry.content).not.toContain('```bandit-permission');
    // Resolved-marker carries the user's choice + the tool name in
    // italic prose so the conversation history stays scannable.
    expect(entry.content).toContain('allowed once');
    expect(entry.content).toContain('apply_edit');
    expect(entry.payload).toBe(entry.content);
  });

  it('respond() called twice with the same id only fires the resolver once', async () => {
    const { ctx, posted } = makeStubCtx();
    const svc = new PermissionGateService(ctx);
    const entry = makeAssistantEntry();

    let resolveCount = 0;
    const promise = svc.request({
      tool: 'write_file',
      primary: 'README.md',
      description: 'Write a file',
      assistantEntry: entry
    }).then((r) => {
      resolveCount += 1;
      return r;
    });

    const id = (posted[0] as { id: string }).id;
    svc.respond(id, 'deny', 'not now');
    // Second call with the same id is a no-op — pending was cleared
    // by the first call. A stale webview reply (e.g. after reload)
    // must not double-resolve the Promise.
    svc.respond(id, 'session');

    const result = await promise;
    expect(result.choice).toBe('deny');
    expect(result.notes).toBe('not now');
    expect(resolveCount).toBe(1);
    expect(svc.pendingCount).toBe(0);

    // An unknown id is also a no-op — must not throw.
    expect(() => svc.respond('perm-does-not-exist', 'save')).not.toThrow();
  });
});
