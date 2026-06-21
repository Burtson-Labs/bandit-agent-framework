# syntax=docker/dockerfile:1

# ── Build ──────────────────────────────────────────────────────────────────
# The Agent UI Workbench is a Vite app inside this pnpm + turbo monorepo. Its
# vite.config aliases @burtson-labs/agent-ui to packages/agent-ui/src and pulls
# cross-app files from apps/bandit-stealth/**, so it must be built from the full
# monorepo: install at the root, then build the single app via pnpm --filter.
FROM node:lts-alpine AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter agent-ui-workbench build

# ── Serve ──────────────────────────────────────────────────────────────────
FROM nginx:alpine-slim AS prod
WORKDIR /usr/share/nginx/html
COPY --from=build /app/apps/agent-ui-workbench/dist ./
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
