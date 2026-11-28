#!/usr/bin/env bash
# nightly-banditbench: the eval (pass/fail, 1 run per fixture) and the benchmark
# against the frozen baseline, then a morning brief by email. Exit code is the
# bench verdict only; brief delivery never changes it. 75 = out of credits.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
write_cli_config
cd "$CLI_DIR"
BENCH_EXIT=0

# ONE run per fixture: this job detects drift; the release-tag eval keeps the
# 3x majority-pass standard. --json-out feeds the fallback brief.
echo "── eval (pass/fail fixtures, 1 run per fixture) ──"
node dist/__eval__/eval.js \
  --provider bandit --model bandit-core-2 --runs 1 \
  --json-out /tmp/eval.json \
  2>&1 | tee /tmp/eval.out || BENCH_EXIT=1
credits_guard /tmp/eval.out

# --runs 3 matches the frozen baseline's runsPerFixture. --baseline writes this
# run's scores for the fallback brief to diff locally.
echo "── benchmark vs frozen baseline (score drift) ──"
node dist/__eval__/benchmark.js \
  --models bandit-core-2 --provider bandit --runs 3 \
  --compare src/__eval__/baselines/production.json \
  --baseline /tmp/bench-current.json \
  2>&1 | tee /tmp/bench.out || BENCH_EXIT=1
credits_guard /tmp/bench.out

# ── Morning brief: Bandit analyzes its own scores and emails the result ──
# Best effort. The report lands under apps/bandit-cli/.bandit (cwd of the eval).
cp .bandit/eval-report.md /tmp/eval-report.md 2>/dev/null || true
# The brief reads these through the tool layer, where a /tmp path is
# "outside-workspace" (critical) and would prompt; staged in-workspace the reads
# are routine. The /tmp copies stay for the fallback.
cd "$REPO"
mkdir -p .bandit/brief
for f in eval.json eval.out bench.out eval-report.md; do
  cp "/tmp/$f" ".bandit/brief/$f" 2>/dev/null || true
done
node apps/bandit-cli/dist/cli.js -p "Read .bandit/brief/eval.json, .bandit/brief/eval.out, .bandit/brief/bench.out, and .bandit/brief/eval-report.md (whichever exist; eval.json is the structured one). Write a SHORT self-contained HTML morning brief for the Bandit team: overall pass rate, any fixture failures or baseline regressions (name them, quote the error one-liners), notable score drift, and a 3-bullet 'what to do next'. If everything passed, say so plainly in one screen. Then publish_artifact the HTML file and email_artifact the published URL to mark@burtson.ai, then call email_artifact AGAIN with the same URL to brett@burtson.com (the tool takes one recipient per call — send to both) with subject-appropriate framing. Keep it under a page." \
  2>&1 | tee /tmp/brief.out || echo "model brief exited non-zero (bench verdict unaffected)"

# ── Fallback brief: an email goes out even with no working model ──
# Unless the agent demonstrably mailed BOTH recipients, send the deterministic
# one. A duplicate email beats a missing one.
BRIEF_OK=1
for addr in mark@burtson.ai brett@burtson.com; do
  grep -qF "Emailed the share link to $addr" /tmp/brief.out 2>/dev/null || BRIEF_OK=0
done
if [ "$BRIEF_OK" = "1" ]; then
  echo "model-authored brief emailed both recipients"
else
  echo "model brief did not confirm delivery to both — sending deterministic fallback"
  node apps/bandit-cli/dist/__eval__/brief.js \
    --eval-json /tmp/eval.json \
    --bench-json /tmp/bench-current.json \
    --baseline "$CLI_DIR/src/__eval__/baselines/production.json" \
    --out /tmp/nightly-brief.html \
    || echo "fallback brief also failed (bench verdict unaffected)"
fi
exit "$BENCH_EXIT"
