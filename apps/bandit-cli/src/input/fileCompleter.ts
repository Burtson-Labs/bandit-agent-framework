import * as fs from 'fs';
import * as path from 'path';

/**
 * Fuzzy-match workspace files under `cwd` for @-mention Tab completion.
 *
 * Walks the tree synchronously (readline completers MUST be synchronous
 * so we can't await an async walker here). Skip list matches the one
 * used by listFiles / searchCode so we don't surface node_modules,
 * .git, etc. as candidates. Returns paths relative to `cwd`.
 *
 * Matching:
 * - Empty query → top-level entries (fast, useful as a "what's here")
 * - Non-empty → case-insensitive substring match against the
 * relative path. The deepest/shortest path wins ordering so
 * `src/auth/login.ts` ranks above `src/legacy/auth/login-old.ts`
 * when the query is "login".
 */
export const COMPLETER_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo',
  'coverage', 'target', '__pycache__', '.venv', 'venv', '.bandit'
]);
export const COMPLETER_MAX_WALK = 5000;

export function fuzzyMatchWorkspaceFiles(cwd: string, query: string, limit: number): string[] {
  const lowerQuery = query.toLowerCase();
  const results: string[] = [];
  let walked = 0;
  const walk = (dir: string, rel: string): void => {
    if (walked >= COMPLETER_MAX_WALK || results.length >= limit * 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (walked >= COMPLETER_MAX_WALK) return;
      walked++;
      if (entry.name.startsWith('.')) continue;
      if (COMPLETER_IGNORED_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Include directories themselves so `@src/<TAB>` completes.
        if (!lowerQuery || childRel.toLowerCase().includes(lowerQuery)) {
          results.push(`${childRel}/`);
        }
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        if (!lowerQuery || childRel.toLowerCase().includes(lowerQuery)) {
          results.push(childRel);
        }
      }
    }
  };
  walk(cwd, '');
  // Sort by relevance: exact-prefix matches first, then shorter paths,
  // then alphabetical. Keeps the most likely candidate at the top so
  // single-Tab completion lands on the right file most of the time.
  results.sort((a, b) => {
    const aStarts = a.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
    const bStarts = b.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
  return results.slice(0, limit);
}
