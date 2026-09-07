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
- **PRs only.** `open-pr.sh` commits to a fresh `self-improve/<date>` branch
  and opens a PR. There is no code path that pushes to `main`.
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

`cronjob.yaml` mirrors the nightly bench job: same namespace, same
`bandit-eval-secrets`, fresh clone, `pnpm install && pnpm build`, then
eval → propose → open-pr. Differences worth knowing:

- **GITHUB_TOKEN required.** The secret needs a `GITHUB_TOKEN` key (repo
  scope: push branches + open PRs on `Burtson-Labs/bandit-agent-framework`)
  alongside the existing `BANDIT_API_KEY`. Add it to the existing secret
  out-of-band — never commit token values:

  ```sh
  kubectl -n bandit patch secret bandit-eval-secrets \
    --type merge -p '{"stringData":{"GITHUB_TOKEN":"<repo-scoped PAT>"}}'
  ```

- **In-cluster evidence is the bench report only.** A fresh clone has no
  `.bandit/turns/` (turn logs are local-machine evidence and gitignored), so
  the pod runs the eval itself and proposes from that report. Local runs get
  both evidence sources.
- A failing eval inside the pod is treated as *input* to the proposer, not a
  job failure.

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
