#!/usr/bin/env bash
# Self-improve PR opener (Rung 3). Takes proposals.json (from propose.ts),
# materializes the proposed files on a fresh `self-improve/<date>` branch,
# commits, pushes, and opens a PR against main. The PR — not a merge — is
# this system's terminal output: nothing here ever pushes to main.
#
# Trust boundaries enforced HERE, independently of propose.ts (neither side
# trusts the other):
#   - only NEW files under apps/bandit-cli/src/__eval__/fixtures/ or
#     .bandit/evals/, and edits to .bandit/lessons.md — nothing else
#   - no absolute paths, no `..` segments
#   - only the written files are staged (never `git add -A`)
#
# Auth: `gh` reads GH_TOKEN / GITHUB_TOKEN; when a token is present we also
# wire git's https credentials through gh so `git push` works in CI pods.
#
# Usage: ops/self-improve/open-pr.sh [proposals.json]
set -euo pipefail

PROPOSALS="${1:-proposals.json}"

command -v node >/dev/null || { echo "open-pr: node is required" >&2; exit 1; }
command -v gh   >/dev/null || { echo "open-pr: gh (GitHub CLI) is required" >&2; exit 1; }
[[ -f "$PROPOSALS" ]] || { echo "open-pr: $PROPOSALS not found (run propose.ts first)" >&2; exit 1; }
PROPOSALS="$(cd "$(dirname "$PROPOSALS")" && pwd)/$(basename "$PROPOSALS")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

COUNT="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(p)) {console.error("proposals.json must be a JSON array"); process.exit(1);} console.log(p.length);' "$PROPOSALS")"
if [[ "$COUNT" == "0" ]]; then
  echo "open-pr: proposals.json is empty — nothing crossed the thresholds, no PR this week."
  exit 0
fi

DATE_UTC="$(date -u +%F)"
BRANCH="self-improve/${DATE_UTC}"
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
  || git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  BRANCH="${BRANCH}-$(date -u +%H%M%S)"   # same-day rerun — keep branches unique
fi

# CI pods have no git identity; set a repo-local one only when unset so local
# runs keep the operator's own. Plain identity, and deliberately NO co-author
# trailer on the commit.
git config user.name  >/dev/null 2>&1 || git config user.name  "bandit-self-improve"
git config user.email >/dev/null 2>&1 || git config user.email "team@burtson.ai"
if [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

START_REF="$(git rev-parse --abbrev-ref HEAD)"

# Materialize proposal files BEFORE branching: the writer runs while we are
# still on the start ref, so an allowlist abort leaves the checkout exactly
# where it began. `git switch -c` from the same HEAD never touches the
# worktree, so the written files ride onto the new branch untouched.
# The node writer re-validates the allowlist and prints each written
# repo-relative path on stdout; anything off-allowlist aborts the whole run
# before a single byte is staged. (while-read, not mapfile — macOS ships
# bash 3.2 and this script runs locally too.)
WRITTEN=()
while IFS= read -r written_path; do
  [[ -n "$written_path" ]] && WRITTEN+=("$written_path")
done < <(node - "$PROPOSALS" <<'NODE'
const fs = require('fs');
const path = require('path');
const proposals = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const NEW_FILE_PREFIXES = ['apps/bandit-cli/src/__eval__/fixtures/', '.bandit/evals/'];
const EDITABLE_FILES = ['.bandit/lessons.md'];
// Pass 1: validate EVERY path before writing ANY — an abort must leave the
// working tree byte-identical, not littered with the compliant half.
const files = proposals.flatMap(p => p.files ?? []);
for (const file of files) {
  const rel = String(file.path);
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    console.error(`open-pr: allowlist violation (path escape): ${rel}`); process.exit(1);
  }
  const editable = EDITABLE_FILES.includes(rel);
  const underAllowedDir = NEW_FILE_PREFIXES.some(p => rel.startsWith(p) && rel.length > p.length);
  if (!editable && !underAllowedDir) {
    console.error(`open-pr: allowlist violation (outside allowlist): ${rel}`); process.exit(1);
  }
  if (!editable && fs.existsSync(rel)) {
    console.error(`open-pr: allowlist violation (would overwrite): ${rel}`); process.exit(1);
  }
}
if (files.length === 0) { console.error('open-pr: proposals carried no files'); process.exit(1); }
// Pass 2: write. Later entries may legitimately rewrite lessons.md (the
// proposer composes cumulatively and open-pr applies in array order).
const written = [];
for (const file of files) {
  const rel = String(file.path);
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, String(file.content), 'utf8');
  written.push(rel);
}
console.log([...new Set(written)].join('\n'));
NODE
)

# Process substitution swallows the writer's exit code — an empty WRITTEN is
# the reliable failure signal (and `${#arr[@]}` is safe under bash 3.2's -u).
if [[ ${#WRITTEN[@]} -eq 0 ]]; then
  echo "open-pr: writer produced no files (allowlist violation or bad proposals.json) — aborting" >&2
  exit 1
fi

git switch -c "$BRANCH"

for rel in "${WRITTEN[@]}"; do
  if [[ "$rel" == ".bandit/lessons.md" ]]; then
    # lessons.md is gitignored by default (per-workspace machine memory). The
    # store is documented as git-committable; this PR makes committing it a
    # REVIEWABLE choice — force-add exactly this one path, nothing else.
    git add -f -- "$rel"
  else
    git add -- "$rel"
  fi
done

TITLES="$(node -e 'for (const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))) console.log(`- [${p.kind}] ${p.title}`);' "$PROPOSALS")"
git commit -m "self-improve: ${COUNT} proposal(s) (${DATE_UTC})" -m "$TITLES"
git push -u origin "$BRANCH"

BODY="$(mktemp)"
{
  echo "Automated proposals from the weekly self-improve loop (\`ops/self-improve/\` — deterministic v1 miner, no LLM)."
  echo
  node -e '
const proposals = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const p of proposals) {
  console.log(`### [${p.kind}] ${p.title}`);
  console.log();
  console.log(p.rationale);
  console.log();
  for (const f of p.files ?? []) console.log(`- \`${f.path}\``);
  console.log();
}' "$PROPOSALS"
  echo "---"
  echo
  echo "Scope is hard-allowlisted (new eval fixtures + \`.bandit/lessons.md\` only) and this loop only ever opens PRs — it cannot push to main. Merge only if the Eval gate passes — the gate is the reviewer of record."
} > "$BODY"

PR_URL="$(gh pr create --base main --head "$BRANCH" \
  --title "self-improve: ${COUNT} proposal(s) — ${DATE_UTC}" \
  --body-file "$BODY")"
rm -f "$BODY"
echo "open-pr: ${PR_URL}"

# Leave local checkouts where they started (harmless no-op in throwaway pods).
if [[ "$START_REF" != "HEAD" && "$START_REF" != "$BRANCH" ]]; then
  git switch "$START_REF" >/dev/null 2>&1 || true
fi
