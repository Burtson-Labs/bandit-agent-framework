/**
 * Workspace-relative paths for training data.
 *
 * A model fine-tuned on raw transcripts memorizes the machine it was collected on: the
 * first fine-tune wrote `~/Documents/GitHub/<repo>/sample.ts` inside an eval sandbox
 * instead of `sample.ts`. Every path under the trajectory's workspace root becomes
 * repo-relative (`.`, `src/x.ts`); another repo becomes `../<repo>/…`; eval sandboxes and
 * temp dirs collapse to the sandbox root or `/tmp/…`; anything else personal becomes a
 * neutral placeholder (or drops the example, with `externalPaths: 'drop'`).
 *
 * Runs before scrubbing, on raw absolute paths, so `/Users/<name>/` and `~/` spellings of
 * the same directory are both recognized.
 */
import * as os from 'os';
import type { CanonicalMessage, TrainingExample } from './types';

export type ExternalPathPolicy = 'placeholder' | 'drop';

export interface RelativizeOptions {
  /** The trajectory's workspace root (absolute). Inferred from the content when absent. */
  workspaceRoot?: string | null;
  home?: string;
  externalPaths?: ExternalPathPolicy;
}

export interface RelativizeResult {
  example: TrainingExample;
  root: string | null;
  /** Paths rewritten to repo-relative form. */
  relative: number;
  /** Paths into another repo, rewritten to `../<repo>/…`. */
  crossRepo: number;
  /** Personal or temp paths outside any repo, replaced with neutral placeholders. */
  external: number;
  /** Set when the example must be dropped (client workspace, or `externalPaths: 'drop'`). */
  dropReason: 'client-workspace' | 'external-path' | null;
}

/** Parent dirs whose children are repos. `GitHub-<org>` checkouts are client work. */
const REPO_PARENTS = /^Documents\/GitHub(?:-([A-Za-z0-9._-]+))?$/i;
/** Home-level dirs that are not repos (left as generic user dirs or placeholders). */
const HOME_NON_REPOS = new Set([
  'Desktop', 'Downloads', 'Documents', 'Library', 'Pictures', 'Movies', 'Music', 'Public', 'Applications',
  '.bandit', '.claude', '.codex', '.config', '.ssh', '.kube', '.npm', '.cache', '.local', '.docker', '.vscode', 'go'
]);
/** Generic user dirs that may stay as `~/<dir>/…` (taught by the system prompt; not identifying). */
const HOME_KEEP = new Set(['Desktop', 'Downloads']);
const GENERIC_VOLUMES = new Set(['bootfs', 'boot', 'Public', 'Untitled', 'EFI', 'Macintosh HD', 'Recovery']);
const SANDBOX_RE = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/(bandit-eval-[^/]+)|^\/(?:private\/)?tmp\/(bandit-eval-[^/]+)|^~\/projects\/app(?=\/|$)/;

/**
 * Absolute-path runs inside free text or argument strings: `~`, `/Users/<n>`, `/home/<n>`, `/Volumes/<v>`,
 * macOS temp dirs and `/tmp`. Stops at whitespace, quotes, backslashes and common delimiters;
 * an escaped `\n`/`\t` (text that was JSON-encoded twice) counts as a boundary.
 */
const PATH_RUN_RE = /(?:(?<![\w.~/-])|(?<=\\[nrt]))(~(?=\/|(?![\w-]))|\/Users\/[^/\s'"`<>|;,)\]}\\]+|\/home\/[^/\s'"`<>|;,)\]}\\]+|\/Volumes\/[^/\s'"`<>|;,)\]}\\*:]+|\/private\/var\/folders|\/var\/folders|\/private\/tmp|\/tmp)((?:\/[^\s'"`<>|;,)\]}:*?\\]*)*)/g;

function trimTrailing(p: string): { path: string; tail: string } {
  const m = p.match(/[.,:;!?)]+$/);
  if (!m) return { path: p, tail: '' };
  return { path: p.slice(0, -m[0].length), tail: m[0] };
}

/** Normalize a matched run to a home-relative (`~/…`) or absolute form. */
function canonical(head: string, rest: string, home: string): string {
  if (head === '~') return `~${rest}`;
  if (/^\/(?:Users|home)\//.test(head)) return `~${rest}`; // any user's home → ~
  if (head.startsWith(home)) return `~${head.slice(home.length)}${rest}`;
  return `${head}${rest}`;
}

/** Repo root (in `~/…` form) and its display name, or null. */
export function repoRootOf(p: string): { root: string; name: string; client: boolean } | null {
  const sandbox = p.match(SANDBOX_RE);
  if (sandbox) {
    const root = p.startsWith('~/projects/app') ? '~/projects/app' : p.slice(0, sandbox.index! + sandbox[0].length);
    return { root, name: 'app', client: false };
  }
  if (!p.startsWith('~/')) return null;
  const parts = p.slice(2).split('/');
  const parent = parts.length >= 3 ? `${parts[0]}/${parts[1]}`.match(REPO_PARENTS) : null;
  if (parent) {
    const org = parent[1];
    return { root: `~/${parts[0]}/${parts[1]}/${parts[2]}`, name: parts[2], client: !!org };
  }
  if (parts.length >= 1 && parts[0] && !HOME_NON_REPOS.has(parts[0]) && !parts[0].startsWith('.')) {
    return { root: `~/${parts[0]}`, name: parts[0], client: false };
  }
  return null;
}

function homeForm(p: string | null | undefined, home: string): string | null {
  if (!p) return null;
  if (p === home) return '~';
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  if (/^\/(?:Users|home)\/[^/]+(\/|$)/.test(p)) return p.replace(/^\/(?:Users|home)\/[^/]+/, '~');
  return p;
}

function eachString(example: TrainingExample, fn: (s: string) => void): void {
  for (const m of example.messages) {
    if (m.content) fn(m.content);
    if (m.role === 'assistant') {
      if (m.reasoning) fn(m.reasoning);
      for (const c of m.tool_calls ?? []) fn(c.function.arguments);
    }
  }
}

/** Most common repo root among the absolute paths an example's tool calls touch (then all text). */
export function inferWorkspaceRoot(example: TrainingExample, home = os.homedir()): string | null {
  const score = (texts: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const t of texts) {
      PATH_RUN_RE.lastIndex = 0;
      for (const m of t.matchAll(PATH_RUN_RE)) {
        const p = trimTrailing(canonical(m[1], m[2] ?? '', home)).path;
        const repo = repoRootOf(p);
        if (repo) counts.set(repo.root, (counts.get(repo.root) ?? 0) + 1);
      }
    }
    return counts;
  };
  const args: string[] = [];
  for (const m of example.messages) for (const c of m.role === 'assistant' ? m.tool_calls ?? [] : []) args.push(c.function.arguments);
  let counts = score(args);
  if (!counts.size) {
    const all: string[] = [];
    eachString(example, s => all.push(s));
    counts = score(all);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [root, n] of counts) if (n > bestN) { best = root; bestN = n; }
  return best;
}

/** Rewrite every path in an example. Pure: returns a new example plus counts. */
export function relativizeExample(example: TrainingExample, options: RelativizeOptions = {}): RelativizeResult {
  const home = options.home ?? os.homedir();
  const hinted = homeForm(options.workspaceRoot, home);
  const hintedRepo = hinted && hinted !== '~' ? repoRootOf(hinted) : null;
  const root = hintedRepo?.root ?? (hinted && hinted !== '~' && hinted.startsWith('~/') ? hinted : null) ?? inferWorkspaceRoot(example, home);
  const rootRepo = root ? repoRootOf(root) : null;
  const result: RelativizeResult = { example, root, relative: 0, crossRepo: 0, external: 0, dropReason: null };
  if (rootRepo?.client) {
    result.dropReason = 'client-workspace';
    return result;
  }

  const rewritePath = (p: string): string => {
    if (root && (p === root || p.startsWith(`${root}/`))) {
      result.relative++;
      return p === root ? '.' : p.slice(root.length + 1) || '.';
    }
    const repo = repoRootOf(p);
    if (repo) {
      if (repo.client) {
        result.dropReason ??= 'client-workspace';
        result.external++;
        return '../[CLIENT]';
      }
      if (/^bandit-eval-|^app$/.test(repo.name) && SANDBOX_RE.test(p)) {
        // Another (or an unrecognized) eval sandbox: never a real location.
        result.external++;
        const rest = p.slice(repo.root.length);
        return rest ? rest.replace(/^\//, '') || '.' : '.';
      }
      result.crossRepo++;
      return `../${repo.name}${p.slice(repo.root.length)}`;
    }
    if (p.startsWith('~/')) {
      const first = p.slice(2).split('/')[0];
      if (HOME_KEEP.has(first)) return p;
      result.external++;
      if (options.externalPaths === 'drop') result.dropReason ??= 'external-path';
      if (first === 'Documents') return `~/files${p.slice('~/Documents'.length)}`;
      if (first === '.bandit') return p; // Bandit's own config dir: generic, taught by the product
      return `~/${p.slice(2).split('/').slice(-1)[0] || 'file'}`;
    }
    if (p === '~') return '~';
    // mounted volumes: generic names stay, anything else (often a user-named share) is neutral
    const vol = p.match(/^\/Volumes\/([^/]+)(.*)$/);
    if (vol) {
      if (GENERIC_VOLUMES.has(vol[1])) return p;
      result.external++;
      if (options.externalPaths === 'drop') result.dropReason ??= 'external-path';
      return `/Volumes/drive${vol[2]}`;
    }
    // temp dirs: keep only the tail so no machine-specific prefix survives
    if (/^\/(?:private\/)?(?:var\/folders|tmp)/.test(p)) {
      result.external++;
      if (options.externalPaths === 'drop') result.dropReason ??= 'external-path';
      const tail = p.split('/').filter(Boolean).slice(-1)[0];
      return tail ? `/tmp/${tail}` : '/tmp';
    }
    return p;
  };

  /**
   * `productText`: the system prompt is product text whose generic examples (`~/Desktop`,
   * `/tmp/something`) must match what the model sees at inference; only the workspace
   * itself (or an eval sandbox) is rewritten there.
   */
  const rewriteText = (text: string, productText = false): string => {
    if (!text) return text;
    PATH_RUN_RE.lastIndex = 0;
    return text.replace(PATH_RUN_RE, (match: string, head: string, rest: string) => {
      const { path: p, tail } = trimTrailing(canonical(head, rest ?? '', home));
      // a bare `~` in prose ("~ 5 minutes") is not a path
      if (head === '~' && !rest) return match;
      if (productText && !(root && (p === root || p.startsWith(`${root}/`))) && !SANDBOX_RE.test(p)) return match;
      return rewritePath(p) + tail;
    });
  };

  const rewriteArgs = (args: string): string => {
    try {
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') return rewriteText(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
      };
      return JSON.stringify(walk(JSON.parse(args)));
    } catch {
      return rewriteText(args);
    }
  };

  const messages: CanonicalMessage[] = example.messages.map(m => {
    if (m.role === 'assistant') {
      const next: CanonicalMessage = { ...m, content: rewriteText(m.content) };
      if (m.reasoning) next.reasoning = rewriteText(m.reasoning);
      if (m.tool_calls) {
        next.tool_calls = m.tool_calls.map(c => ({ ...c, function: { ...c.function, arguments: rewriteArgs(c.function.arguments) } }));
      }
      return next;
    }
    return { ...m, content: rewriteText(m.content, m.role === 'system') } as CanonicalMessage;
  });
  result.example = { ...example, sourceRef: rewriteText(example.sourceRef), messages };
  return result;
}

/** Leftover machine-specific paths the self-check refuses. */
export const ABSOLUTE_PATH_LEFTOVER_RE = /~\/Documents\b|\/Volumes\/(?!(?:drive|bootfs|boot|Public|Untitled|EFI|Recovery)\b)[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|~\/projects\/app\b|\/var\/folders\/|\/private\/var\/|\bbandit-eval-[A-Za-z0-9._-]+-[A-Za-z0-9]{4,}/;
