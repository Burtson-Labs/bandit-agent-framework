#!/usr/bin/env bash
# social-drafts: three candidate X posts from the last 4 days of shipped work,
# written to an HTML page and emailed to Mark for approval. Never posts anywhere.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO"

# Source material comes from current main, not the image's commit: fetch just
# the recent history (git data only, nothing is installed or run from it).
SINCE_FETCH="$(date -u -d '6 days ago' +%Y-%m-%d)"
git fetch --quiet --no-tags --shallow-since="$SINCE_FETCH" origin main
mkdir -p .bandit/social
git log --oneline --since="4 days ago" FETCH_HEAD > .bandit/social/recent-commits.txt
# Through a file: `git show | head` dies of SIGPIPE under pipefail.
git show FETCH_HEAD:apps/bandit-stealth/CHANGELOG.md > /tmp/changelog.md
head -n 120 /tmp/changelog.md > .bandit/social/changelog-top.md
echo "social-drafts: $(wc -l < .bandit/social/recent-commits.txt) commits since 4 days ago (main $(git rev-parse --short FETCH_HEAD))"

write_cli_config
# auto mode approves routine calls only; pre-approve exactly what this job
# needs. run_command stays un-allowed, and critical calls still fail loudly.
cat > .bandit/settings.json <<'SETTINGS'
{
  "permissions": {
    "allow": ["read_file", "list_files", "search_code", "ls", "write_file"],
    "deny": [],
    "ask": []
  }
}
SETTINGS

node apps/bandit-cli/dist/cli.js -p 'Read .bandit/social/recent-commits.txt (output of: git log --oneline --since="4 days ago") and .bandit/social/changelog-top.md (top entries of apps/bandit-stealth/CHANGELOG.md). Using ONLY that real shipped work as source material, draft exactly 3 candidate X posts for Burtson Labs: (1) a feature announcement about something that actually shipped; (2) a build-in-public post about why things take time, grounded in the real work in those files; (3) a developer tip built around a real Bandit command — verify the exact command against README.md or docs/ in this repo before using it. HARD RULES, apply to every post: never mention the npm scope "@burtson-labs" or the handle "@burtson" (use the unscoped name "bandit-stealth-cli" or just "Bandit"); never name any backing model or third-party AI product — describe Bandit in Bandit terms; no fabricated metrics; posts must be <= 275 chars each; tone: confident builder, no hype-words like "revolutionary". Now write the 3 candidates into one small self-contained HTML page (use the write_file tool to save it, do NOT shell out to node/bash to write files): one section per candidate with a short label and a one-line rationale, the post text ALONE inside a copy-friendly <pre> block (nothing but the post text in the block, so it can be selected and copied as-is), and the exact character count shown under each block. Save it as .bandit/social/social-drafts.html. Do NOT publish or email anything yourself — the job handles delivery after checking the content. This job NEVER posts anywhere. You are drafting candidates for human approval only — do not post, schedule, or submit anything to any social platform or API; your only outputs are the HTML artifact and the approval email.' 2>&1 | tee /tmp/social.out || true
credits_guard /tmp/social.out

# A job that drafted nothing must not report success. Check the file, not the
# transcript (-p mode does not echo tool results).
DRAFTS="$REPO/.bandit/social/social-drafts.html"
if [ ! -s "$DRAFTS" ]; then
  echo "social-drafts: no drafts were written to $DRAFTS — failing so this is visible" >&2
  exit 1
fi
if ! grep -qi "<pre" "$DRAFTS"; then
  echo "social-drafts: $DRAFTS has no post blocks — failing so this is visible" >&2
  exit 1
fi
echo "social-drafts: wrote $(wc -c < "$DRAFTS") bytes of drafts"
# Delivery is deterministic and gated: the client-work denylist is checked
# before anything leaves the pod.
node apps/bandit-cli/dist/__ops__/publish-email.js \
  --file "$DRAFTS" \
  --to mark@burtson.ai \
  --subject 'Bandit social drafts awaiting approval' \
  --forbid 'lockton'
