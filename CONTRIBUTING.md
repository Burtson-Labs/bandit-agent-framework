# Contributing

Thanks for showing up. This is a working monorepo for a real shipped product — Bandit Stealth (VS Code extension) and Bandit CLI both build out of here — so a few things to know before you open a PR.

## Quick start

```bash
git clone https://github.com/Burtson-Labs/bandit-agent-framework.git
cd bandit-agent-framework
pnpm install
pnpm build
pnpm --filter @burtson-labs/agent-core test
```

Node 22+, pnpm 9+. The build is incremental; rebuilding a single package is `pnpm --filter <name> build`.

## What we accept

- **Bug fixes** to shipped behavior. Include a minimal repro in the PR description; a regression test is a strong plus.
- **Improvements to local-model behavior** — tool-call reliability, prompt fixes, watchdog tuning. We're a local-first project; making Ollama models work better is the most valuable contribution shape.
- **New skills** under `examples/skills/` — small, focused, well-documented.
- **Docs / README clarity** — anything that helps a new contributor get further faster.

## What needs a discussion first

Open an issue (or comment on an existing one) before writing code for:

- New top-level tools added to the registry — the surface is intentionally small
- New provider adapters — we want to keep the matrix manageable
- Major architectural changes — refactors that span more than ~5 files
- Anything affecting the on-disk session format under `~/.bandit/sessions/`

## Repo layout

| Path | Stable / Experimental | Notes |
|---|---|---|
| [`apps/bandit-stealth/`](apps/bandit-stealth/) | **Stable** | VS Code extension, published to Marketplace |
| [`apps/bandit-cli/`](apps/bandit-cli/) | **Stable** | npm-published as `@burtson-labs/bandit-stealth-cli` |
| [`apps/bandit-stealth-web/`](apps/bandit-stealth-web/) | Experimental | Standalone web UI, not yet open to external contributions |
| [`apps/agent-ui-workbench/`](apps/agent-ui-workbench/) | Experimental | Internal component dev harness |
| [`packages/agent-core/`](packages/agent-core/) | Stable | Tool registry + tool-use loop; most heavily tested |
| [`packages/agent-adapters/`](packages/agent-adapters/) | Stable | Provider + embedding + integration adapters |
| [`packages/stealth-core-runtime/`](packages/stealth-core-runtime/) | Stable | Host-agnostic agent runtime |
| [`packages/host-kit/`](packages/host-kit/) | Stable | Host building blocks (memory, mentions, hooks) |
| [`packages/core-chat/`](packages/core-chat/) | Stable | Shared chat message types |
| [`packages/agent-ui/`](packages/agent-ui/) | Stable | UI primitives shared between web + extension webview |

## Code style

- TypeScript everywhere except the Swift recorder. Strict mode is on; PRs that break `pnpm build` won't be reviewed.
- We don't ship a Prettier config; match the file you're editing.
- Comments: explain the *why* when it's non-obvious. Don't narrate what the code does.

## PR checklist

- [ ] `pnpm build` passes
- [ ] Relevant tests added or updated (`pnpm --filter <pkg> test`)
- [ ] CHANGELOG.md updated for user-visible changes (in `apps/bandit-stealth/` if the change affects the extension or CLI)
- [ ] Commit messages are short and explain the *why*, not the *what*

## CI for outside contributors

PRs from forks run [`.github/workflows/pr-checks.yaml`](.github/workflows/pr-checks.yaml) on `ubuntu-latest`. The main release pipeline (self-hosted runners, multi-platform smoke tests, marketplace publish) only fires on push to `main` and tags, so you don't need access to our cluster to get green CI on a PR.

## Reporting security issues

Don't open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the disclosure process.

## License

By contributing, you agree your contributions will be licensed under the [Apache License 2.0](LICENSE). Apache 2.0 includes an explicit patent grant from contributors to downstream users — see the LICENSE file for the full text.
