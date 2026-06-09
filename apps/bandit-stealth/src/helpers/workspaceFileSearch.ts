/**
 * Lightweight fuzzy file/folder search for `@` mention autocomplete.
 * Two modes:
 *
 *  - **Browse mode** — query ends with `/`. Lists direct children
 *    (files AND folders) of that directory so users can drill from
 *    `@src/` → `@src/auth/` → `@src/auth/login.ts`.
 *  - **Fuzzy-search mode** — anything else. Combines `vscode.workspace
 *    .findFiles` for files with an independent depth-capped BFS for
 *    folders so a query like `@src` finds `src/` even when no file
 *    inside it matches.
 *
 * Excludes (both modes): build artifacts (node_modules, dist, build,
 * .next, .turbo, bin, obj, target, coverage, .gradle, __pycache__,
 * .venv, .vs, .idea) and generated filenames (`*.dll`, `*.pdb`,
 * `*.map`, `*.deps.json`, `project.assets.json`, `*.min.{js,css,mjs,
 * cjs}`, `*.generated.*`, `*.g.cs`). caught the `S3Api/bin/Debug/
 * net10.0/*.dll` noise in `@` suggestions.
 *
 * Fires on every keystroke while a user types `@<token>` so it has to
 * stay cheap — the folder BFS is capped at 400 dirs / 4 levels deep
 * to keep large workspaces snappy.
 *
 * Always returns an array (empty when no workspace, when no matches,
 * or on caught error). Caller posts a `workspaceFileSuggestions`
 * message with whatever comes back.
 */
import * as path from 'path';
import * as vscode from 'vscode';

const EXCLUDE_GLOB = '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/coverage/**,**/target/**,**/bin/**,**/obj/**,**/.gradle/**,**/__pycache__/**,**/.pytest_cache/**,**/.mypy_cache/**,**/.venv/**,**/venv/**,**/.vs/**,**/.idea/**,**/.git/**}';

const GENERATED_FILE_RE = /(^|\/)(project\.assets\.json|project\.nuget\.cache|.*\.nuget\.(props|targets)|.*\.g\.cs|.*\.designer\.cs|.*\.generated\.[a-z]+|.*\.min\.(js|css|mjs|cjs)|.*\.(dll|pdb|deps\.json|runtimeconfig\.json|exe)|.*\.map|.*\.lock)$/i;

const IGNORED_DIR_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.turbo',
  'coverage', 'target', 'bin', 'obj', '.gradle',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.venv', 'venv',
  '.vs', '.idea'
]);

const IGNORED_BFS_DIRS = new Set([...IGNORED_DIR_NAMES, '.git']);

const FUZZY_FIND_LIMIT = 80;
const BROWSE_RESULT_LIMIT = 20;
const FUZZY_DIR_LIMIT = 10;
const FUZZY_TOTAL_LIMIT = 15;
const BFS_DIR_CAP = 400;
const BFS_MAX_DEPTH = 4;

export interface WorkspaceFileSuggestion {
  path: string;
  isDir: boolean;
}

export async function searchWorkspaceFiles(rawQuery: string): Promise<WorkspaceFileSuggestion[]> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {return [];}
  const query = rawQuery.trim();
  const workspaceRoot = workspaceFolder.uri.fsPath;

  try {
    if (query.endsWith('/')) {
      return await browseDirectory(workspaceRoot, query);
    }
    return await fuzzySearch(workspaceFolder, workspaceRoot, query);
  } catch {
    return [];
  }
}

async function browseDirectory(workspaceRoot: string, query: string): Promise<WorkspaceFileSuggestion[]> {
  const dirRel = query.replace(/\/+$/, '');
  const dirAbs = path.resolve(workspaceRoot, dirRel);
  // Path-escape guard — don't browse outside the workspace.
  if (!dirAbs.startsWith(workspaceRoot)) {return [];}

  let children: [string, vscode.FileType][] = [];
  try {
    children = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirAbs));
  } catch {
    return [];
  }

  return children
    .filter(([name, type]) => {
      if (name.startsWith('.')) {return false;}
      if (IGNORED_DIR_NAMES.has(name)) {return false;}
      if ((type & vscode.FileType.File) && GENERATED_FILE_RE.test(name)) {return false;}
      return true;
    })
    .map(([name, type]) => ({
      path: dirRel ? `${dirRel}/${name}` : name,
      isDir: Boolean(type & vscode.FileType.Directory),
      basename: name
    }))
    // Folders first, then files, each alphabetical.
    .sort((a, b) => {
      if (a.isDir !== b.isDir) {return a.isDir ? -1 : 1;}
      return a.basename.localeCompare(b.basename);
    })
    .slice(0, BROWSE_RESULT_LIMIT)
    .map(({ path: p, isDir }) => ({ path: p, isDir }));
}

async function fuzzySearch(
  workspaceFolder: vscode.WorkspaceFolder,
  workspaceRoot: string,
  query: string
): Promise<WorkspaceFileSuggestion[]> {
  const pattern = query.length === 0
    ? new vscode.RelativePattern(workspaceFolder, '**/*')
    : new vscode.RelativePattern(workspaceFolder, `**/*${query}*`);
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, FUZZY_FIND_LIMIT);
  const lower = query.toLowerCase();
  const rel = uris
    .map(u => path.relative(workspaceRoot, u.fsPath))
    .filter(p => p.length > 0 && !GENERATED_FILE_RE.test(p))
    .map(p => ({ path: p, basename: path.basename(p), isDir: false as boolean }));

  const allDirs = await enumerateDirectories(workspaceRoot);

  // Match the enumerated dirs against the query. Prefer basename
  // matches (e.g. `@src` → `src/` beats `other/subsrc/`).
  const dirCandidates = new Set<string>();
  if (query.length > 0) {
    for (const dirRel of allDirs) {
      const base = path.basename(dirRel).toLowerCase();
      if (base.includes(lower)) {dirCandidates.add(dirRel);}
    }
    // Also fold in ancestors of matching files whose own basename hits
    // the query — keeps the old behavior as a safety net for queries
    // that only match deep-path segments.
    for (const entry of rel) {
      const parts = entry.path.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].toLowerCase().includes(lower)) {
          dirCandidates.add(parts.slice(0, i + 1).join('/'));
        }
      }
    }
  } else {
    // Empty query → surface top-level workspace folders so an
    // unprompted `@` on its own shows something discoverable.
    for (const dirRel of allDirs) {
      if (!dirRel.includes('/')) {dirCandidates.add(dirRel);}
    }
  }
  const dirEntries = [...dirCandidates].slice(0, FUZZY_DIR_LIMIT).map(p => ({
    path: p,
    basename: path.basename(p),
    isDir: true
  }));

  const combined = [...dirEntries, ...rel];
  const ranked = combined.sort((a, b) => {
    // Dirs rank slightly above files at equal-match quality so
    // folder-navigation feels discoverable.
    if (a.isDir !== b.isDir) {return a.isDir ? -1 : 1;}
    const aBase = a.basename.toLowerCase();
    const bBase = b.basename.toLowerCase();
    const aPrefix = aBase.startsWith(lower);
    const bPrefix = bBase.startsWith(lower);
    if (aPrefix !== bPrefix) {return aPrefix ? -1 : 1;}
    const aContains = aBase.includes(lower);
    const bContains = bBase.includes(lower);
    if (aContains !== bContains) {return aContains ? -1 : 1;}
    return a.path.localeCompare(b.path);
  });
  return ranked.slice(0, FUZZY_TOTAL_LIMIT).map(r => ({ path: r.path, isDir: r.isDir }));
}

async function enumerateDirectories(workspaceRoot: string): Promise<string[]> {
  // BFS depth-capped at MAX_DEPTH levels, total capped at DIR_CAP, so
  // even large monorepos stay snappy on every keystroke. Prunes the
  // same build-artifact names used in browse-mode.
  const allDirs: string[] = [];
  const queue: Array<{ absPath: string; relPath: string; depth: number }> = [
    { absPath: workspaceRoot, relPath: '', depth: 0 }
  ];
  while (queue.length > 0 && allDirs.length < BFS_DIR_CAP) {
    const { absPath, relPath, depth } = queue.shift()!;
    if (depth >= BFS_MAX_DEPTH) {continue;}
    let children: [string, vscode.FileType][] = [];
    try {
      children = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absPath));
    } catch {
      continue;
    }
    for (const [name, type] of children) {
      if (!(type & vscode.FileType.Directory)) {continue;}
      if (name.startsWith('.') && name !== '.github' && name !== '.vscode') {continue;}
      if (IGNORED_BFS_DIRS.has(name)) {continue;}
      const childRel = relPath ? `${relPath}/${name}` : name;
      allDirs.push(childRel);
      if (allDirs.length >= BFS_DIR_CAP) {break;}
      queue.push({ absPath: path.join(absPath, name), relPath: childRel, depth: depth + 1 });
    }
  }
  return allDirs;
}
