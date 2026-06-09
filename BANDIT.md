# Bandit Agent Framework — project memory

## Behavior

### Before editing
- Read the file first. Don't `apply_edit` blind — the `find` string must match verbatim.
- For changes larger than ~10 lines in an existing file, prefer `replace_range` with `start_line`, `end_line`, and the `shown_hash` from the most recent `read_file`.
- Use `write_file` only to create a new file or replace more than ~70% of an existing one.

### When changing code
- Match existing style. Don't refactor adjacent code that wasn't asked for.
- Trust internal callers; only validate at system boundaries (user input, external APIs).
- Default heavy-context features OFF (auto-context, eager tool output, long prompt prefixes).
- Browser stubs in `apps/bandit-stealth-web/src/runtime/` are Vite build aliases, NOT dead code.

### When finishing a task
- Typecheck + smoke + vitest: `pnpm --filter @burtson-labs/bandit-stealth-cli run typecheck && pnpm --filter @burtson-labs/bandit-stealth-cli run smoke && pnpm -r test`.
- Bump the relevant `version` and append a CHANGELOG.md entry for user-visible changes only (CI fixes / test-only changes get a bump but no CHANGELOG line).
- Push tags one at a time. Batched tag pushes drop GitHub Actions tag-create events and the Marketplace publisher silently misses them.
- Never amend a tagged release commit — bump to the next version instead. OpenVSX / Marketplace hard-fail on duplicate versions.

### Communication
- No `Co-Authored-By` trailers on commits.
- Commit messages: imperative subject + ≤3 bullets. Infra details belong in the README, not git log.
- CHANGELOG tone: lead with what the user sees changed. No internal-process meta ("the trace shows…", "diagnostics paid off").
- No competitor / OSS-project names in release notes — describe Bandit changes in Bandit terms.

## Project facts

### Repo layout
- `apps/bandit-cli` — terminal CLI (`bandit` binary).
- `apps/bandit-stealth` — VS Code / Cursor extension.
- `apps/bandit-stealth-web` — Stealth Web SPA (React 19, Vite).
- `packages/host-kit` — host-agnostic building blocks: memory loaders, hooks, mentions, extra tools (`todo_write`, `web_fetch`, `web_search`, `remember`, `read_memory`).
- `packages/agent-core` — tool registry + tool-use loop, skill loader, default tool set.
- `packages/stealth-core-runtime` — host-agnostic agent runtime, layered system prompt.
- `packages/agent-adapters*` — LLM provider + embedding adapters.
- `packages/core-chat` — `ChatMessage` types + `sanitizeModelOutput`.

### Defaults
- Local model: `gemma4:e4b`. Cloud default: `bandit-logic`.
- pnpm workspaces; React 19 pinned via root `pnpm.overrides`.
- ESM CLI bundle via esbuild; banner polyfills `require` / `__filename` / `__dirname`.
- `BANDIT_INK_INPUT=1` or `bandit --ink` opts into the ink input frame; default is readline.

### Conventions
- Auto-loaded memory candidates: `BANDIT.md`, `CLAUDE.md`, `AGENTS.md`, `.bandit/BANDIT.md`, `.bandit/memory.md`. Each capped at 32 KB.
- Lazy-loaded topic memory: `MEMORY.md` at the workspace root is an index of `[Title](memory/<slug>.md) — hook` entries. Agent reads the index every turn and calls `read_memory(name="<slug>")` on demand.
- `/remember <fact>` appends to `BANDIT.md`. `/init` scaffolds a fresh BANDIT.md in the shape above.
- Latest agent-run output: `.bandit/agent-report.json`.
