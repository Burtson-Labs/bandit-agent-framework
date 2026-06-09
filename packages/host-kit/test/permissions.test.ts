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
import { emptyPolicy, evaluatePermission } from '../src/permissions';

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

  it('allows MCP read-only browse tools by default', () => {
    expect(evaluatePermission('burtson-labs.listMessages', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('burtson-labs.listLabels', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('burtson-labs.listFilters', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('burtson-labs.getMessage', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('burtson-labs.getDraft', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('burtson-labs.searchDriveFiles', '', emptyPolicy())).toBe('allow');
    expect(evaluatePermission('burtson-labs.readGoogleDoc', '', emptyPolicy())).toBe('allow');
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
    expect(evaluatePermission('mcp__burtson-labs__listMessages', '', emptyPolicy())).toBe('allow');
  });
});
