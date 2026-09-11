# Agent-runner service image (ADR-001 runtime unification).
#
# Build context is the REPO ROOT — the runner consumes agent-core and
# stealth-core-runtime as workspace packages, so the image build runs the
# same `pnpm --filter agent-runner...` pipeline CI does, then `pnpm deploy`
# produces a self-contained production bundle (validated locally: the
# bundle boots and serves /healthz with no workspace around it).
#
#   docker build -f services/agent-runner/Dockerfile -t agent-runner .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@burtson-labs/agent-runner..."
RUN pnpm --filter "@burtson-labs/agent-runner..." build
RUN pnpm --filter "@burtson-labs/agent-runner" deploy --prod /out

FROM node:22-alpine
# git: the turn loop's command allowlist includes git, and workspace
# operations diff/restore through it.
RUN apk add --no-cache git
ENV NODE_ENV=production
ENV PORT=8790
WORKDIR /app
COPY --from=build --chown=node:node /out .

# SEC-008: this process executes model-authored file writes and commands,
# which is the last thing that should run as uid 0. `node` (uid 1000) ships
# with the base image, so nothing about the build pipeline changes — only
# who the entrypoint runs as. /app stays root-owned and read-only to the
# runtime user; the service writes exclusively inside the workspace.
#
# /workspaces is the conventional mount point for AGENT_RUNNER_WORKSPACE_ROOT
# and is pre-owned by uid 1000 so a volume mounted there is writable. A
# workspace mounted from elsewhere must be owned by uid 1000 too — both for
# write access and because git refuses repositories owned by another user.
RUN mkdir -p /workspaces && chown node:node /workspaces
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "dist/server.js"]
