import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COMPLETER_IGNORED_DIRS,
  fuzzyMatchWorkspaceFiles
} from '../src/input/fileCompleter';

// Build a small workspace tree once and reuse for all assertions.
// Includes:
//  - a deliberate prefix-vs-substring pair (`auth-login.ts` vs
//    `legacy/auth-login-old.ts`) so the ranking contract is observable
//  - an ignored directory (node_modules) with a file inside
//  - a `.hidden` file (skipped by the dot-prefix rule)
let root = '';
let cleanup: (() => void) | null = null;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileCompleter-'));
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'legacy', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });

  fs.writeFileSync(path.join(root, 'README.md'), '');
  fs.writeFileSync(path.join(root, '.env.local'), '');
  fs.writeFileSync(path.join(root, 'src', 'auth-login.ts'), '');
  fs.writeFileSync(path.join(root, 'src', 'auth', 'login.ts'), '');
  fs.writeFileSync(path.join(root, 'src', 'legacy', 'auth-login-old.ts'), '');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '');
  fs.writeFileSync(path.join(root, '.git', 'objects', 'blob'), '');

  cleanup = () => fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  cleanup?.();
});

describe('fuzzyMatchWorkspaceFiles — match ordering', () => {
  it('ranks prefix matches before substring matches', () => {
    // Query 'auth-login' — three candidates contain the substring:
    //  - src/auth-login.ts
    //  - src/auth/auth-login.ts (none — but src/auth/login.ts won't match)
    //  - src/legacy/auth-login-old.ts
    // Neither starts with 'auth-login' at the relative-path root, so
    // ordering falls to length then alphabetical: src/auth-login.ts (19)
    // beats src/legacy/auth-login-old.ts (29).
    const matches = fuzzyMatchWorkspaceFiles(root, 'auth-login', 10);
    const shortIdx = matches.indexOf('src/auth-login.ts');
    const longIdx = matches.indexOf('src/legacy/auth-login-old.ts');
    expect(shortIdx).toBeGreaterThanOrEqual(0);
    expect(longIdx).toBeGreaterThan(shortIdx);
  });

  it('case-insensitive substring matching', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, 'AUTH', 10);
    expect(matches.some(m => m.includes('auth-login.ts'))).toBe(true);
  });

  it('returns empty list when the query matches nothing', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, 'nope-no-such-file', 10);
    expect(matches).toEqual([]);
  });

  it('empty query lists workspace entries up to the limit', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, '', 3);
    expect(matches.length).toBe(3);
  });
});

describe('fuzzyMatchWorkspaceFiles — ignored directories and hidden files', () => {
  it('skips node_modules contents', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, 'index', 20);
    expect(matches.some(m => m.startsWith('node_modules'))).toBe(false);
  });

  it('skips .git contents', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, 'blob', 20);
    expect(matches.some(m => m.startsWith('.git'))).toBe(false);
  });

  it('skips dotfiles at the top level (.env.local, .git)', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, '', 50);
    expect(matches.some(m => m.startsWith('.'))).toBe(false);
  });

  it('exposes its ignored-dir list for cross-checking', () => {
    expect(COMPLETER_IGNORED_DIRS.has('node_modules')).toBe(true);
    expect(COMPLETER_IGNORED_DIRS.has('.git')).toBe(true);
    expect(COMPLETER_IGNORED_DIRS.has('dist')).toBe(true);
  });
});

describe('fuzzyMatchWorkspaceFiles — directory entries', () => {
  it('includes directories so @src/<TAB> can complete', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, 'src', 20);
    expect(matches.some(m => m === 'src/')).toBe(true);
  });

  it('honors the limit cap on returned results', () => {
    const matches = fuzzyMatchWorkspaceFiles(root, '', 2);
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});
