#!/usr/bin/env bash
# weekly-self-improve: a fresh eval, the deterministic proposer, and a
# self-improve/<date> branch pushed for review (ops/self-improve/README.md).
# Exit 75 = out of credits.
# Nothing here can push to main.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
write_cli_config
cd "$CLI_DIR"

echo "── eval (fresh evidence for the proposer) ──"
# A failing eval is evidence here, not a job failure. --json-out carries each
# fixture's actual assertion failures. Reports land under apps/bandit-cli/.bandit.
node dist/__eval__/eval.js --provider bandit --model bandit-core-2 \
  --json-out .bandit/eval-report.json \
  2>&1 | tee /tmp/eval.out || echo "eval reported failures (expected input for the proposer)"
# A billing refusal is not evidence: proposals built from it would be noise.
credits_guard /tmp/eval.out

cd "$REPO"
echo "── propose ──"
REPORT=apps/bandit-cli/.bandit/eval-report.md
[ -f "$REPORT" ] || REPORT=.bandit/eval-report.md
EVAL_JSON="${REPORT%.md}.json"
echo "propose: report $REPORT, json ${EVAL_JSON} ($([ -f "$EVAL_JSON" ] && echo present || echo MISSING))"
node ops/self-improve/propose.ts "$REPORT" --json "$EVAL_JSON" --out /tmp/proposals.json || exit 1

echo "── push branch for review ──"
# open-pr.sh pushes self-improve/<date> and emails the compare link itself
# (pr-notify), so there is no separate notify step here.
export GH_TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is not set — see ops/self-improve/README.md}"
bash ops/self-improve/open-pr.sh /tmp/proposals.json
