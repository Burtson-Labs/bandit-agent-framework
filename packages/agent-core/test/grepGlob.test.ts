import { describe, expect, it } from 'vitest';
import { filterGrepOutputByGlob, planGrepForGlob } from '../src/tools/grep-glob';

describe('planGrepForGlob', () => {
  it('a plain file path: start in its directory, include its basename, match only that file', () => {
    const plan = planGrepForGlob('src/utils/scoring.ts');
    expect(plan.subDir).toBe('src/utils');
    expect(plan.includes).toEqual(['scoring.ts']);
    expect(plan.matches('src/utils/scoring.ts')).toBe(true);
    expect(plan.matches('src/utils/deep/scoring.ts')).toBe(false);
    expect(plan.matches('lib/src/utils/scoring.ts')).toBe(false);
  });

  it('a directory glob: * stays inside one directory', () => {
    const plan = planGrepForGlob('src/utils/*.ts');
    expect(plan.subDir).toBe('src/utils');
    expect(plan.includes).toEqual(['*.ts']);
    expect(plan.matches('src/utils/scoring.ts')).toBe(true);
    expect(plan.matches('src/utils/deep/scoring.ts')).toBe(false);
    expect(plan.matches('src/utils/scoring.tsx')).toBe(false);
  });

  it('prefix/**/leaf, the one shape the old fallback handled, still works', () => {
    const plan = planGrepForGlob('src/**/*.{ts,tsx}');
    expect(plan.subDir).toBe('src');
    expect(plan.includes).toEqual(['*.ts', '*.tsx']);
    expect(plan.matches('src/a.ts')).toBe(true);
    expect(plan.matches('src/a/b/c.tsx')).toBe(true);
    expect(plan.matches('test/a.ts')).toBe(false);
    expect(plan.matches('src/a.js')).toBe(false);
  });

  it('**/leaf searches the whole tree', () => {
    const plan = planGrepForGlob('**/*.ts');
    expect(plan.subDir).toBe('');
    expect(plan.includes).toEqual(['*.ts']);
    expect(plan.matches('a.ts')).toBe(true);
    expect(plan.matches('src/deep/a.ts')).toBe(true);
  });

  it('a glob without a slash matches a basename at any depth, as ripgrep does', () => {
    for (const glob of ['*.ts', 'scoring.ts']) {
      const plan = planGrepForGlob(glob);
      expect(plan.subDir).toBe('');
      expect(plan.includes).toEqual([glob]);
      expect(plan.matches('scoring.ts')).toBe(true);
      expect(plan.matches('src/utils/scoring.ts')).toBe(true);
    }
    expect(planGrepForGlob('scoring.ts').matches('src/utils/notscoring.ts')).toBe(false);
  });

  it('a wildcard in the middle: grep starts above it and the predicate does the rest', () => {
    const plan = planGrepForGlob('packages/*/src/index.ts');
    expect(plan.subDir).toBe('packages');
    expect(plan.includes).toEqual(['index.ts']);
    expect(plan.matches('packages/agent-core/src/index.ts')).toBe(true);
    expect(plan.matches('packages/agent-core/test/index.ts')).toBe(false);
    expect(plan.matches('packages/a/b/src/index.ts')).toBe(false);
  });

  it('a directory (trailing slash or /**) means every file under it', () => {
    for (const glob of ['src/utils/', 'src/utils/**']) {
      const plan = planGrepForGlob(glob);
      expect(plan.subDir).toBe('src/utils');
      expect(plan.includes).toEqual([]);
      expect(plan.matches('src/utils/scoring.ts')).toBe(true);
      expect(plan.matches('src/utils/deep/x.md')).toBe(true);
      expect(plan.matches('src/other/x.md')).toBe(false);
    }
  });

  it('tolerates ./, a leading slash, backslashes and regex metacharacters in names', () => {
    expect(planGrepForGlob('./src/utils/scoring.ts').matches('src/utils/scoring.ts')).toBe(true);
    expect(planGrepForGlob('/src/utils/scoring.ts').subDir).toBe('src/utils');
    expect(planGrepForGlob('src\\utils\\*.ts').matches('src/utils/a.ts')).toBe(true);
    const plan = planGrepForGlob('src/(group)/page+1.ts');
    expect(plan.matches('src/(group)/page+1.ts')).toBe(true);
    expect(plan.matches('src/group/page1.ts')).toBe(false);
    expect(planGrepForGlob('src/file[0-9].ts').matches('src/file7.ts')).toBe(true);
    expect(planGrepForGlob('src/file?.ts').matches('src/file/.ts')).toBe(false);
  });
});

describe('filterGrepOutputByGlob', () => {
  const rel = (p: string) => p.replace('/work/', '');

  it('drops matches from files the glob does not cover and keeps everything else', () => {
    const output = [
      '/work/src/utils/scoring.ts:3:// weights',
      '/work/src/utils/deep/scoring.ts:1:// nested',
      'Binary file /work/src/utils/logo.png matches',
      ''
    ].join('\n');
    expect(filterGrepOutputByGlob(output, planGrepForGlob('src/utils/scoring.ts'), rel)).toBe([
      '/work/src/utils/scoring.ts:3:// weights',
      'Binary file /work/src/utils/logo.png matches',
      ''
    ].join('\n'));
  });

  it('is a no-op on empty output', () => {
    expect(filterGrepOutputByGlob('', planGrepForGlob('src/*.ts'), rel)).toBe('');
  });
});
