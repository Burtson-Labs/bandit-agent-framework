/**
 * Contract tests for buildSlimContext — the cheap replacement for the
 * heavy embeddings-driven ContextBuilder pipeline.
 *
 * Why pin: this is what runs every turn when the user opts into auto-
 * context (`banditStealth.autoContextEnabled`). The whole point of the
 * slim path is "no embeddings, no network, no file contents" — if a
 * future change accidentally reintroduces any of those, the perf
 * regression will be silent and the user won't see it until their turn
 * latency doubles. The tests below pin:
 *   - No file contents in the formatted output (paths only).
 *   - Output stays under 1 KB even with 10 git-modified entries.
 *   - Empty inputs produce a `source: 'none'` empty-string result so
 *     the system-prompt builder can keep its `if (formatted) append`
 *     check.
 *   - The same BuiltContext shape as the heavy builder, so the status
 *     bar / system prompt assembler don't need conditional code.
 */
import { describe, expect, it } from 'vitest';
import { buildSlimContext } from '../src/runtime/contextBuilder';

describe('buildSlimContext', () => {
  it('returns a "none" result when nothing is provided', () => {
    const r = buildSlimContext({});
    expect(r.source).toBe('none');
    expect(r.formatted).toBe('');
    expect(r.files).toEqual([]);
    expect(r.tokenEstimate).toBe(0);
  });

  it('emits an open-editor line when only currentFilePath is set', () => {
    const r = buildSlimContext({ currentFilePath: '/abs/repo/src/foo.ts' });
    expect(r.source).toBe('pinned-only');
    expect(r.formatted).toContain('### Workspace context:');
    expect(r.formatted).toContain('Open in editor: /abs/repo/src/foo.ts');
    expect(r.formatted).not.toContain('Recently edited');
    expect(r.files).toEqual([
      { path: '/abs/repo/src/foo.ts', content: '', source: 'pinned' }
    ]);
  });

  it('emits a git list with status codes when only gitModifiedFiles is set', () => {
    const r = buildSlimContext({
      gitModifiedFiles: [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'A' },
        { path: 'tsconfig.json' }
      ]
    });
    expect(r.source).toBe('pinned-only');
    expect(r.formatted).toContain('Recently edited (git): src/a.ts (M), src/b.ts (A), tsconfig.json');
    expect(r.formatted).not.toContain('Open in editor');
  });

  it('combines open-editor + git list when both are set', () => {
    const r = buildSlimContext({
      currentFilePath: '/abs/repo/src/foo.ts',
      gitModifiedFiles: [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'A' }
      ]
    });
    expect(r.formatted).toContain('Open in editor: /abs/repo/src/foo.ts');
    expect(r.formatted).toContain('Recently edited (git): src/a.ts (M), src/b.ts (A)');
  });

  it('deduplicates the open-editor file from the git list (no double entry)', () => {
    const r = buildSlimContext({
      currentFilePath: 'src/foo.ts',
      gitModifiedFiles: [
        { path: 'src/foo.ts', status: 'M' },
        { path: 'src/bar.ts', status: 'M' }
      ]
    });
    // Only one ContextFile entry for src/foo.ts.
    const fooEntries = r.files.filter((f) => f.path === 'src/foo.ts');
    expect(fooEntries).toHaveLength(1);
    expect(r.files.map((f) => f.path)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('caps the git list at maxGitFiles (default 10)', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({
      path: `src/file${i}.ts`,
      status: 'M' as const
    }));
    const r = buildSlimContext({ gitModifiedFiles: big });
    // 10 entries shown.
    const matches = r.formatted.match(/src\/file\d+\.ts/g) ?? [];
    expect(matches).toHaveLength(10);
  });

  it('honours an explicit maxGitFiles override', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}` }));
    const r = buildSlimContext({ gitModifiedFiles: big, maxGitFiles: 3 });
    const matches = r.formatted.match(/f\d+/g) ?? [];
    expect(matches).toHaveLength(3);
  });

  it('NEVER includes file contents in the formatted output (perf invariant)', () => {
    // The whole point of slim — file contents stay out. If a future
    // change accidentally inlines content here, this test breaks
    // before the perf regression ships.
    const r = buildSlimContext({
      currentFilePath: 'src/foo.ts',
      gitModifiedFiles: [{ path: 'src/bar.ts', status: 'M' }]
    });
    // No fenced code blocks (heavy builder used ```\n...\n```).
    expect(r.formatted).not.toContain('```');
    // No "Relevant codebase context" header (that's the heavy builder).
    expect(r.formatted).not.toContain('Relevant codebase context');
  });

  it('keeps total formatted size under 1 KB even with 10 git entries (token-budget invariant)', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({
      path: `packages/some-package/src/very/deep/path/file${i}.ts`,
      status: 'M' as const
    }));
    const r = buildSlimContext({
      currentFilePath: '/abs/workspace/apps/bandit-stealth/src/extension.ts',
      gitModifiedFiles: big
    });
    expect(r.formatted.length).toBeLessThan(1024);
    // Token estimate is similarly bounded.
    expect(r.tokenEstimate).toBeLessThan(300);
  });

  it('returns the same BuiltContext shape as the heavy ContextBuilder so callers stay agnostic', () => {
    const r = buildSlimContext({ currentFilePath: 'src/x.ts' });
    expect(r).toHaveProperty('files');
    expect(r).toHaveProperty('formatted');
    expect(r).toHaveProperty('source');
    expect(r).toHaveProperty('tokenEstimate');
    // Source is one of the documented union values (no new "slim" tag —
    // status-bar consumers don't have to learn a new variant).
    expect(['gateway', 'local', 'pinned-only', 'none']).toContain(r.source);
  });

  it('tells the agent the list is metadata-only so it knows to read_file when it cares', () => {
    // This guidance line is what makes the slim version safe — without
    // it, a model might assume the listed files are pre-loaded into
    // context and try to "summarize" them without ever reading. We
    // pin the wording so a future cleanup doesn't drop it.
    const r = buildSlimContext({ currentFilePath: 'x.ts' });
    expect(r.formatted).toMatch(/metadata only|file contents are NOT included/i);
    expect(r.formatted).toMatch(/read_file|grep|list_dir/);
  });
});
