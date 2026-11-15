/**
 * search_code's empty result names a concrete next query. A bare
 * "No matches" read to a cloud model as "it isn't there" and it ended a
 * change request after one search and an `ls` (2026-11-15).
 */
import { describe, expect, it } from 'vitest';
import { noMatchHint, searchCodeTool } from '../src/tools/core-tools';
import { testCtx } from './_helpers';

describe('search_code no-match hint', () => {
  it('suggests lowercase when the pattern has capitals', () => {
    expect(noMatchHint('AppleAuth')).toContain('try "appleauth"');
    expect(noMatchHint('apple\\w+')).not.toContain('capitals');
  });

  it('suggests one word or alternation for a phrase', () => {
    expect(noMatchHint('apple o auth provider')).toContain('"apple|o|auth"');
    expect(noMatchHint('apple|google')).not.toContain('alternation such as');
  });

  it('names the glob and cwd that narrowed the search', () => {
    const hint = noMatchHint('apple', '*.ts', 'src');
    expect(hint).toContain('drop file_glob "*.ts"');
    expect(hint).toContain('search from the workspace root instead of "src"');
  });

  it('is appended to the tool result', async () => {
    const result = await searchCodeTool.execute({ pattern: 'Apple OAuth' }, testCtx);
    expect(result.isError).toBeFalsy();
    expect(result.output).toMatch(/^No matches found for "Apple OAuth"\. Try: /);
    expect(result.output).toContain('list_files or find_directory');
  });
});
