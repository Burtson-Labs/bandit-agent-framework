/**
 * Every path a write-family call could land on.
 *
 * `write_file` / `apply_edit` / `replace_range` / `delete_file` name their
 * target in `path`. `apply_patch` does not have to: it accepts a whole patch
 * whose targets live in `+++ b/<path>` headers (unified diff) or
 * `*** Update|Add|Delete File: <path>` lines (Codex envelope), with `path` as
 * an optional override. Reading only `params.path` would leave a patch-shaped
 * bypass wide open — for the privileged-config guard and for the risk
 * classifier alike — so the patch body is parsed for targets too. Shared so
 * the two never disagree about what a patch touches.
 */
export function patchTargets(params: Record<string, string>): string[] {
  const targets: string[] = [];
  if (params.path) targets.push(params.path);
  const patch = params.patch;
  if (typeof patch === 'string' && patch) {
    const headerRe = /^(?:\+\+\+\s+(?:b\/)?(.+?)\s*$|\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$)/gm;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(patch)) !== null) {
      const p = (m[1] ?? m[2] ?? '').trim();
      // `/dev/null` is the unified-diff marker for "no such side", not a path.
      if (p && p !== '/dev/null') targets.push(p);
    }
  }
  return targets;
}
