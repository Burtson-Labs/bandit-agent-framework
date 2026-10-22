/**
 * Permission policy contract. Pins both the static DANGEROUS_TOOLS
 * gate AND the new mutating-name-pattern gate so a future refactor
 * of the evaluator can't silently let MCP write tools through the
 * default-allow path again.
 *
 * Captured 2026-05-25: MCP-bridged tools (createFilter,
 * trashMessage, modifyMessageLabels) bypassed the picker entirely
   * because the evaluator only knew about a few in-tree tool names
   * (write_file / apply_edit / run_command). Users had no chance to
 * stop an inbox-archiving spree before it ran.
 */
import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import {
  emptyPolicy,
  evaluatePermission,
  isNetworkTool,
  isKnownLocalMcpTool,
  mcpServerOf,
  setMcpServerLocal
} from '../src/permissions';

describe('evaluatePermission default behavior', () => {
  it('allows read-only in-tree tools by default', () => {
    expect(evaluatePermission('read_file', 'x', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('list_files', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('search_code', 'foo', emptyPolicy())).toBe('allow');
  });

  it('asks for in-tree mutating tools by default', () => {
    expect(evaluatePermission('write_file', 'src/x.ts', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('apply_edit', 'src/x.ts', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('replace_range', 'src/x.ts', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('apply_patch', 'src/x.ts', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('run_command', 'rm -rf /', emptyPolicy())).toBe('ask');
  });
});

describe('evaluatePermission — MCP mutating-name gate', () => {
  it('asks for MCP create/update/delete tools (namespaced)', () => {
    expect(evaluatePermission('burtson-labs.createFilter', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.createLabel', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.createEvent', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.updateDraft', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.deleteEvent', '', emptyPolicy())).toBe('ask');
  });

  it('asks for MCP trash/archive/send/modify tools', () => {
    expect(evaluatePermission('burtson-labs.trashMessage', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.modifyMessageLabels', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.sendEmail', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.sendDraft', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.archiveMessage', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.moveFile', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.renameFile', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.replaceTableRowData', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.batchWrite', '', emptyPolicy())).toBe('ask');
  });

  it('asks for read-named MCP tools from a server not declared local', () => {
    // Bandit cannot see what a server does with a call: a get/fetch tool can
    // send its arguments anywhere (2026-10-21 egress audit).
    expect(evaluatePermission('burtson-labs.listMessages', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.getMessage', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('burtson-labs.searchDriveFiles', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('webby.fetch_url', '', emptyPolicy())).toBe('ask');
  });

  it('allows read-named MCP tools from a server declared local', () => {
    setMcpServerLocal('notes', true);
    expect(evaluatePermission('notes.listNotes', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('notes.readNote', '', emptyPolicy())).toBe('allow');
    // A local server's mutating tools still ask.
    expect(evaluatePermission('notes.createNote', '', emptyPolicy())).toBe('ask');
    setMcpServerLocal('notes', false);
    expect(evaluatePermission('notes.listNotes', '', emptyPolicy())).toBe('ask');
  });

  it('honors explicit allow in policy over the mutating-name default', () => {
    const policy = { ...emptyPolicy(), allow: ['burtson-labs.trashMessage'] };
    expect(evaluatePermission('burtson-labs.trashMessage', '', policy)).toBe('allow');
  });

  it('honors explicit deny in policy over the mutating-name default', () => {
    const policy = { ...emptyPolicy(), deny: ['burtson-labs.sendEmail'] };
    expect(evaluatePermission('burtson-labs.sendEmail', '', policy)).toBe('deny');
  });

  it('handles mcp__server__tool naming convention too', () => {
    expect(evaluatePermission('mcp__burtson-labs__createFilter', '', emptyPolicy())).toBe('ask');
    expect(evaluatePermission('mcp__burtson-labs__listMessages', '', emptyPolicy())).toBe('ask');
    setMcpServerLocal('burtson-labs', true);
    expect(evaluatePermission('mcp__burtson-labs__listMessages', '', emptyPolicy())).toBe('allow');
    setMcpServerLocal('burtson-labs', false);
  });
});

describe('evaluatePermission — network tools ask by default', () => {
  afterEach(() => setMcpServerLocal('local-srv', false));

  const NETWORK = [
    'web_fetch', 'web_search', 'fetch_image',
    'git_push', 'git_pull',
    'publish_artifact', 'share_artifact', 'email_artifact',
    'update_artifact', 'delete_artifact', 'restore_artifact', 'list_artifacts', 'get_artifact',
    'generate_image'
  ];

  it('asks for every built-in tool that contacts another host', () => {
    for (const tool of NETWORK) {
      expect(evaluatePermission(tool, 'https://example.com/?leak=x', emptyPolicy()), tool).toBe('ask');
      expect(isNetworkTool(tool), tool).toBe(true);
    }
  });

  it('keeps local tools allowed', () => {
    for (const tool of ['read_file', 'list_files', 'search_code', 'git_status', 'git_diff', 'git_log', 'todo_write']) {
      expect(evaluatePermission(tool, '', emptyPolicy()), tool).toBe('allow');
      expect(isNetworkTool(tool), tool).toBe(false);
    }
  });

  it('explicit allow rules still work, including URL-scoped ones', () => {
    expect(evaluatePermission('web_fetch', 'https://docs.example.com/a', { ...emptyPolicy(), allow: ['web_fetch'] })).toBe('allow');
    const scoped = { ...emptyPolicy(), allow: ['web_fetch:https://docs.example.com/*'] };
    expect(evaluatePermission('web_fetch', 'https://docs.example.com/a', scoped)).toBe('allow');
    expect(evaluatePermission('web_fetch', 'https://evil.example/?d=1', scoped)).toBe('ask');
    expect(evaluatePermission('git_push', '', { ...emptyPolicy(), allow: ['git_push'] })).toBe('allow');
  });

  it('explicit deny still wins', () => {
    expect(evaluatePermission('fetch_image', 'https://x/a.png', { ...emptyPolicy(), deny: ['fetch_image'], allow: ['fetch_image'] })).toBe('deny');
  });

  it('treats MCP tools as network tools unless their server is declared local', () => {
    expect(mcpServerOf('srv.tool')).toBe('srv');
    expect(mcpServerOf('mcp__srv__tool')).toBe('srv');
    expect(mcpServerOf('read_file')).toBeNull();
    expect(isNetworkTool('local-srv.listThings')).toBe(true);
    setMcpServerLocal('local-srv', true);
    expect(isKnownLocalMcpTool('local-srv.listThings')).toBe(true);
    expect(isNetworkTool('local-srv.listThings')).toBe(false);
  });
});
