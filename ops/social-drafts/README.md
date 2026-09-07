# Social drafts (approval-first)

A cluster CronJob that has Bandit draft X post candidates from real shipped work — and
**never posts anything anywhere**. Its only outputs are a published HTML artifact and an
approval email to Mark.

## What it does

Three mornings a week, [cronjob.yaml](cronjob.yaml) clones this repo, builds it, and runs
the Bandit CLI one-shot. Bandit reads the last ~4 days of shipped work
(`git log --oneline --since="4 days ago"` plus the top entries of
`apps/bandit-stealth/CHANGELOG.md`) and drafts 3 candidates:

1. a feature announcement (something that actually shipped)
2. a build-in-public post (why things take time)
3. a developer tip built around a real Bandit command

Each candidate lands in a small self-contained HTML page — post text in a copy-friendly
block with its character count — which Bandit publishes as an artifact and emails
(`email_artifact`) to mark@burtson.io.

Guardrails are embedded in the drafting prompt: no `@burtson-labs` scope or `@burtson`
handle (unscoped `bandit-stealth-cli` or just "Bandit"), no backing-model or third-party
AI product names, no fabricated metrics, <= 275 chars per post, confident-builder tone
with no hype-words.

## Approval flow

1. Email arrives with the artifact link.
2. Mark opens it, copies the candidate he likes (or none).
3. He posts it manually.

Auto-posting via the X API is explicitly **out of scope for v1**. The job has no social
credentials and no posting tools — drafting and emailing is all it can do.

## Changing the cadence

Edit `spec.schedule` in [cronjob.yaml](cronjob.yaml) and re-apply. Current:
`"0 14 * * 1,3,5"` UTC = 09:00 Central (CDT) Mon/Wed/Fri; the timezone is pinned to
`Etc/UTC`, so it lands 08:00 during CST.

```bash
kubectl apply -f ops/social-drafts/cronjob.yaml
```

## Run it once manually

```bash
kubectl -n bandit create job --from=cronjob/social-drafts social-drafts-manual-$(date +%s)
kubectl -n bandit logs -f job/<the job name printed above>
```

## Secret

Reuses `bandit-eval-secrets` (`BANDIT_API_KEY`), the same secret
[ops/nightly-bench](../nightly-bench/cronjob.yaml) uses — no new setup if the nightly
bench already runs.
