# Ops CronJob image

`ghcr.io/burtson-labs/bandit-ops-cron` runs the three Bandit jobs on the home
cluster. The CronJob manifests live in Burtson-Labs/MinIo-k8s
(`manifests/bandit-ops/`) and pin the image by digest.

| Job | Script | Schedule (UTC) | Secrets |
|---|---|---|---|
| `nightly-banditbench` | `nightly-bench.sh` | daily 09:00 | `BANDIT_API_KEY` |
| `social-drafts` | `social-drafts.sh` | Mon/Wed/Fri 14:00 | `BANDIT_API_KEY` |
| `weekly-self-improve` | `self-improve.sh` | Sun 10:00 | `BANDIT_API_KEY`, `GITHUB_TOKEN` |

The image holds the repo at a release tag, built with the frozen lockfile
(`pnpm install --frozen-lockfile`, CLI and its workspace packages only), and the
scripts call `node` directly, so a run installs nothing. Network use at run time:
the Bandit gateway, plus `git fetch` of recent `main` history in social-drafts
(data only) and the branch push in self-improve.

Exit 75 means the gateway refused the key with `402 insufficient_credits`. The
scripts stop there instead of reporting every fixture as a regression.

## Build

`.github/workflows/ops-cron-image.yaml` runs on every `v*` tag, or by hand with a
tag name. The code comes from the tag, the scripts from the workflow's commit.
The tag is `:<release tag>-<script commit>`; the digest is in the run summary.

Local build (native arm64 on Apple silicon):

```bash
git clone --depth 1 --branch v1.7.458 https://github.com/Burtson-Labs/bandit-agent-framework.git /tmp/src
docker buildx build --load --build-context recipe=ops/cron-image \
  -f ops/cron-image/Dockerfile -t bandit-ops-cron:local /tmp/src
```

Releasing a new image to the jobs: run the workflow for the tag, then update the
`image:` digest in the three manifests and `kubectl apply` them.
