import { describe, expect, it } from 'vitest';

import { suggestToolNames, unknownToolMessage } from '../src/tools/loop/toolNameSuggest';

const REGISTERED = [
  'read_file',
  'write_file',
  'apply_edit',
  'replace_range',
  'apply_patch',
  'list_files',
  'ls',
  'search_code',
  'run_command',
  'delete_file',
  'github.create_issue'
];

describe('suggestToolNames', () => {
  it('maps the names local models reach for onto ours', () => {
    // Observed 2026-09-25: gemma4:e4b called edit_file, got "not registered",
    // and told the user the environment could not edit files.
    expect(suggestToolNames('edit_file', REGISTERED)).toEqual(['apply_edit', 'replace_range']);
    expect(suggestToolNames('str_replace', REGISTERED)).toEqual(['apply_edit']);
    expect(suggestToolNames('create_file', REGISTERED)).toEqual(['write_file']);
    expect(suggestToolNames('bash', REGISTERED)).toEqual(['run_command']);
    expect(suggestToolNames('Edit-File', REGISTERED)).toEqual(['apply_edit', 'replace_range']);
  });

  it('only suggests tools that are actually registered', () => {
    expect(suggestToolNames('edit_file', ['read_file', 'write_file'])).toEqual([]);
  });

  it('catches near-miss spellings', () => {
    expect(suggestToolNames('read_files', REGISTERED)).toEqual(['read_file']);
    expect(suggestToolNames('search_cod', REGISTERED)).toEqual(['search_code']);
  });

  it('does not invent a match for an unrelated name', () => {
    expect(suggestToolNames('deploy_to_prod', REGISTERED)).toEqual([]);
  });
});

describe('unknownToolMessage', () => {
  it('names the tool to use instead', () => {
    const msg = unknownToolMessage('edit_file', REGISTERED);
    expect(msg).toContain('not registered');
    expect(msg).toContain('"apply_edit"');
    expect(msg).toContain('available in this environment');
  });

  it('lists what exists when nothing is close, without namespaced MCP tools', () => {
    const msg = unknownToolMessage('deploy_to_prod', REGISTERED);
    expect(msg).toContain('Available tools include: read_file, write_file, apply_edit');
    expect(msg).not.toContain('github.create_issue');
  });
});
