/**
 * search_code without ripgrep: express a ripgrep-style `file_glob` with plain `grep -r`.
 *
 * Hosts search with `rg --glob <glob>` and fall back to `grep -rn --include <glob>` when rg
 * is not on PATH (it is a shell function, not a binary, in some setups; it is missing from
 * the Electron environment on others). grep's `--include` matches file BASENAMES only, so
 * any glob with a directory in it silently matched nothing:
 *
 *   search_code({"pattern":"//.*","file_glob":"src/utils/scoring.ts"}) → "No matches found"
 *
 * on a file full of `//` comments, and the model then told the user there were none. The
 * earlier fallback handled the one shape `prefix/**\/leaf`; `src/utils/scoring.ts`,
 * `src/utils/*.ts` and `**\/*.ts` still returned nothing.
 *
 * planGrepForGlob splits any glob into what grep can do (start in the wildcard-free
 * leading directories, `--include` the basename pattern) and a predicate for the rest, so
 * the host can drop output lines from files the full glob does not cover. Semantics follow
 * ripgrep: a glob without `/` matches a basename at any depth; a glob with `/` is anchored
 * at the search root, `*` and `?` stay inside one path segment, `**` crosses segments.
 */

export interface GrepGlobPlan {
  /** Wildcard-free leading directories of the glob, relative to the search root ('' = the root). */
  subDir: string;
  /** Basename patterns for `grep --include`. Empty means every file under `subDir`. */
  includes: string[];
  /** Whether a file path (relative to the search root) satisfies the whole glob. */
  matches(relPath: string): boolean;
}

const GLOB_META = /[*?{}[\]]/;

function braceExpand(pattern: string): string[] {
  const match = /^(.*?)\{([^{}]*)\}(.*)$/.exec(pattern);
  if (!match) {return [pattern];}
  const [, before, body, after] = match;
  return body.split(',').flatMap((option) => braceExpand(`${before}${option.trim()}${after}`));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One brace-free glob → regex source. */
function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?'; // `**/` — zero or more directories
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        out += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

export function planGrepForGlob(fileGlob: string): GrepGlobPlan {
  const glob = fileGlob.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  const segments = glob.split('/');
  const leaf = segments.pop() ?? '';
  const anchored = segments.length > 0;

  const literalDirs: string[] = [];
  for (const segment of segments) {
    if (GLOB_META.test(segment)) {break;}
    literalDirs.push(segment);
  }

  // `dir/` and `dir/**` name a directory: every file under it.
  const everyFile = leaf === '' || leaf === '**';
  const includes = everyFile ? [] : [...new Set(braceExpand(leaf))];

  const alternatives = braceExpand(everyFile ? `${segments.join('/')}/**` : glob).map(globSource);
  const body = `(?:${alternatives.join('|')})`;
  const matcher = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);

  return {
    subDir: literalDirs.join('/'),
    includes,
    matches: (relPath: string) => matcher.test(relPath.replace(/\\/g, '/').replace(/^\.\//, ''))
  };
}

/**
 * Keep the `path:line:text` lines of grep output whose file satisfies the glob.
 * `relativeTo` turns the path grep printed into one relative to the search root.
 */
export function filterGrepOutputByGlob(output: string, plan: GrepGlobPlan, relativeTo: (filePath: string) => string): string {
  if (!output) {return output;}
  const kept = output.split('\n').filter((line) => {
    const match = /^(.*?):\d+:/.exec(line);
    // Lines that are not a match record (a truncated tail, "Binary file … matches") pass through.
    return !match || plan.matches(relativeTo(match[1]));
  });
  return kept.join('\n');
}
