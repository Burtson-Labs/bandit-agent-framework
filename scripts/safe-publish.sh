#!/usr/bin/env bash
#
# Run `pnpm publish` and only soft-skip the "version already published"
# 409/403 case. Every other publish failure (auth, scope mismatch,
# tarball rejected, network, etc) returns non-zero so CI goes red.
#
# The original workflow used `pnpm publish ... || true` for every
# publish step, which masked every failure mode equally. Result: when
# a publish actually broke (e.g. registry auth expired, package name
# mismatch), CI stayed green and we shipped nothing — for as long as
# nobody noticed the registry's `latest` tag wasn't moving.
#
# Usage (from a workflow step):
#   - run: ../../scripts/safe-publish.sh --access restricted
#     working-directory: packages/agent-core
#     env:
#       NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
#
# All arguments are forwarded to `pnpm publish`. `--no-git-checks` is
# always added so workflow runs on any commit shape.

set -o pipefail

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

# Forward every arg + always pass --no-git-checks.
if pnpm publish --no-git-checks "$@" 2>&1 | tee "$LOG"; then
  PUBLISHED_VERSION=$(node -p "require('./package.json').version")
  PUBLISHED_NAME=$(node -p "require('./package.json').name")
  echo "::notice::Published ${PUBLISHED_NAME}@${PUBLISHED_VERSION}"
  exit 0
fi

# `pnpm publish` returns non-zero for both "already published" and
# real failures. Distinguish by scanning the captured output for the
# narrow set of phrases the registry uses for "version exists."
if grep -qE 'You cannot publish over the previously published versions|cannot publish over|EPUBLISHCONFLICT|already published|cannot modify pre-existing|409 Conflict|conflict' "$LOG"; then
  PUBLISHED_VERSION=$(node -p "require('./package.json').version")
  PUBLISHED_NAME=$(node -p "require('./package.json').name")
  echo "::notice::${PUBLISHED_NAME}@${PUBLISHED_VERSION} already on registry — no-op."
  exit 0
fi

echo "::error::pnpm publish failed for reasons other than 'already published'. See log above."
exit 1
