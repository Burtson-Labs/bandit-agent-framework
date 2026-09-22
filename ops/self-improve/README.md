# Self-improve PR loop (Rung 3)

The nightly bench (`ops/nightly-bench/`) measures. This loop **proposes**: it
mines the bench output and the agent's own turn logs for recurring failure
patterns and turns them into a pull request against `main`. The PR is the
system's terminal output — Bandit proposing changes to Bandit, with a human
and the eval gate between proposal and merge.

## Trust model

The whole design is "narrow hands, real review":

- **Allowlisted paths only.** A proposal may create *new* files under
  `apps/bandit-cli/src/__eval__/fixtures/` or `.bandit/evals/`, and edit
  `.bandit/lessons.md`. Nothing else — no source, no prompts, no CI, no
  configs. Both `propose.ts` (at generation) and `open-pr.sh` (at write time)
  enforce the allowlist independently; neither trusts the other.
- **Branches only (since 2026-09-22).** `open-pr.sh` commits to a fresh
  `self-improve/<date>` branch and pushes it; the compare link is what gets
  reviewed (and emailed by the notifier when a key is present). It opens a
  PR only with `SELF_IMPROVE_OPEN_PR=1`, once the proposals have earned that.
  There is no code path that pushes to `main`.
- **The eval gate must pass.** Every PR body carries the standing rule:
  *"Merge only if the Eval gate passes — the gate is the reviewer of record."*
- **Mark merges.** Nothing lands without a human clicking merge.

One deliberate wrinkle: `.bandit/lessons.md` is gitignored by default
(per-workspace machine memory). The lessons store is documented as
git-committable, so `open-pr.sh` force-adds exactly that one path — the PR
makes "should this repo share its lessons" a reviewable choice instead of a
silent one. Declining the PR keeps the status quo.

## What v1 detects (deterministic — no LLM call)

`propose.ts` is honest, dumb pattern mining. Every rationale states its
observed counts; lessons are phrased as observed patterns, not root-cause
claims.

| Detector | Evidence | Proposal |
|----------|----------|----------|
| Repeated tool errors — same tool erroring ≥3× across ≥2 of the last ~20 turn logs | `tool-execute`/`tool-result` pairs in `.bandit/turns/*.jsonl` | `lesson` bullet naming the tool + most common failing target |
| Phantom tools — the model invoking a nonexistent tool ≥2× | `tool-not-found` events | `fixture` (a workspace eval in `.bandit/evals/` pinning `mustNotCall` on the phantom name) + a `lesson` bullet |
| Fabricated tool results ≥2× | `fake-tool-result` / `hallucinated-tool-result` events | `lesson` bullet |
| Failing bench fixtures | the eval report / tee'd bench log passed as the path arg | `prompt-tier` proposal — materialized as `.bandit/lessons.md` bullets, because lessons are the only prompt-injected surface inside the allowlist (real prompt-tier files stay human-owned) |

Proposals that touch `.bandit/lessons.md` compose cumulatively and are meant
to be applied **in array order** (which `open-pr.sh` does), so the final file
is coherent even when two proposals edit it. New bullets are deduped against
existing lessons and the store keeps the host-kit cap of 40.

If nothing crosses a threshold, `proposals.json` is `[]` and `open-pr.sh`
exits 0 without a branch or PR.

## Run it locally

Requires Node ≥ 22.18 (type stripping on by default) and `gh` (authed).

```sh
# 1) generate proposals — both args optional
node ops/self-improve/propose.ts .bandit/eval-report.md \
  --turns-dir .bandit/turns --out proposals.json

# 2) inspect proposals.json — this is the review surface before any branch exists

# 3) branch + commit + push + PR (no-op when proposals.json is [])
bash ops/self-improve/open-pr.sh proposals.json
```

`propose.ts` flags: positional path or `--report` (eval-report.md *or* a
tee'd `bandit eval` console log — ANSI is stripped), `--turns-dir`,
`--repo-root`, `--out`, `--tail N` (default 20 turn logs).

## Cron (weekly, Sunday 10:00 UTC)

Run it on any scheduler (cron or CI). The job needs two environment variables: `BANDIT_API_KEY` (a Bandit cloud key for the evidence eval) and `GITHUB_TOKEN` (a repo-scoped PAT so `open-pr.sh` can push a branch and open the PR). Provide them however your scheduler provides secrets.

## Seed fixture

This scaffold ships with one regression-derived builtin fixture to prove the
shape proposals aspire to: `context_reuse.artifact_revision`
(`apps/bandit-cli/src/__eval__/fixtures/artifact-revision-no-reread.ts`) —
when asked to revise an artifact it just published, the agent must edit from
the transcript instead of re-reading the file it was handed. That is the
bar: a fixture that pins one observed behavior with a trace-level assertion.

## v2 roadmap

- **LLM-driven proposals.** Swap the deterministic bullet-writer for a
  Bandit one-shot: hand it the same evidence bundle (bench report, mined
  turn-log aggregates) plus Mongo `outcomeCode`/`decision` data from the
  gateway, and let it draft the fixture/lesson content — still inside the
  same allowlist and still landing as a PR.
- **Fixture synthesis from real prompts.** v1's phantom-tool fixture uses a
  generic task; v2 should reconstruct a minimal repro from the failing
  turn's actual prompt shape.
- **Outcome feedback.** Track which merged proposals moved the bench
  baseline, and let that feed the next week's proposal ranking.

## Identity: who authors these commits and PRs

Two separate identities, and they are set in different places.

**Commit author** — `open-pr.sh` configures `Bandit Stealth <bandit@burtson.ai>`
when the checkout has no identity (CI pods never do). Previously this fell back
to `team@burtson.ai`, which GitHub resolves to a human account, so machine-written
commits appeared under a person's name and avatar.

**PR author** — whoever owns the `GH_TOKEN` the job runs with. Today that is the
PAT in `bandit-eval-secrets`, so the PR reads as opened by that person even though
the commit inside it does not. Fixing this needs its own credential; nothing in
this repo can change it.

The durable fix is a **GitHub App** rather than a machine-user PAT: no seat is
consumed, the token is short-lived, and the PR is attributed to `<app>[bot]`.

1. Org → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Repository permissions: **Contents: Read & write**, **Pull requests: Read & write**.
   Nothing else — this loop only writes allowlisted files and opens PRs.
3. Install it on `bandit-agent-framework` only.
4. Store the App ID and private key in `bandit-eval-secrets`, mint an installation
   token at job start, and export it as `GH_TOKEN` in place of the PAT.

A machine user with its own PAT also works and is quicker, but it occupies a seat
and the token is long-lived — strictly worse on both counts.
