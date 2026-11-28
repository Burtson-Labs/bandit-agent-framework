# syntax=docker/dockerfile:1
# Image for the Bandit ops CronJobs on the home cluster: nightly-banditbench,
# social-drafts and weekly-self-improve (manifests in Burtson-Labs/MinIo-k8s
# manifests/bandit-ops/). Built by .github/workflows/ops-cron-image.yaml from a
# release tag, so each job runs a known commit with a frozen lockfile and makes
# no package installs at run time.
#
# Two build contexts: the default one is the repo at the release tag being
# packaged, including .git (the jobs read history and self-improve pushes a
# branch; see Dockerfile.dockerignore), and `recipe` is this directory, which
# supplies the job scripts. The workflow takes the recipe from the commit it
# runs on, so a tag cut before these files existed can still be packaged.
#
#   docker buildx build --build-context recipe=ops/cron-image \
#     -f ops/cron-image/Dockerfile -t bandit-ops-cron .

# Same base the jobs used before (node:22-bookworm: git, python3 and the usual
# tools the eval fixtures run). Node 22.18+ strips TypeScript types by default,
# which propose.ts relies on. Digest = multi-arch index.
FROM node:22-bookworm@sha256:7c400d78797d8cbe3f6bb21d2227b86af4cd24b0014cc9f62ff989cc16de988e

# gh: self-improve pushes its branch through `gh auth setup-git`.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

USER node
WORKDIR /work
ENV HOME=/home/node
COPY --chown=node:node . .

# The CLI and the workspace packages it bundles; nothing else in the monorepo.
RUN pnpm install --frozen-lockfile --filter "@burtson-labs/bandit-stealth-cli..." \
 && pnpm --filter "@burtson-labs/bandit-stealth-cli..." build \
 && test -f apps/bandit-cli/dist/cli.js \
 && test -f apps/bandit-cli/dist/__eval__/eval.js \
 && test -f apps/bandit-cli/dist/__eval__/benchmark.js \
 && test -f apps/bandit-cli/dist/__eval__/brief.js \
 && test -f apps/bandit-cli/dist/__ops__/publish-email.js \
 && test -f apps/bandit-cli/dist/__ops__/pr-notify.js \
 && rm -rf /home/node/.cache/pnpm /home/node/.local/share/pnpm/store

COPY --from=recipe lib.sh nightly-bench.sh social-drafts.sh self-improve.sh /opt/bandit-ops/

# Runs with no network package manager: the job scripts call node directly.
ENV NODE_ENV=production \
    COREPACK_ENABLE_NETWORK=0 \
    BANDIT_OPS_IMAGE=1
ENTRYPOINT ["/bin/bash"]
CMD ["-c", "echo 'pick a job: /opt/bandit-ops/{nightly-bench,social-drafts,self-improve}.sh' >&2; exit 64"]
