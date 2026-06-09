<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/host-kit

  **Host-agnostic building blocks shared between the Bandit CLI and the VS Code extension.**

  Writing a new host (a Cursor sidebar, a JetBrains plugin, a custom CLI)? Pull from here.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/host-kit
```

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's in the box

- **Memory loader** — discovers and merges `BANDIT.md` / `CLAUDE.md` / `AGENTS.md` files across workspace + global locations; deduplicates overlapping content at load time; `consolidateMemory()` unifies multiple entry files into a single canonical `BANDIT.md` (symlink on macOS/Linux, copy-with-drift-warning on Windows)
- **Topic memory** — lazy-load index at `.bandit/memory/MEMORY.md` (preferred) with back-compat reads from legacy root `MEMORY.md`; writes always go to `.bandit/memory/`; `migrateMemoryToBanditDir()` moves an existing root `memory/` layout into `.bandit/memory/` idempotently
- **`@-mention` expansion** — detects `@path/to/file` in user input and inlines file contents (with secret redaction) or attaches images as base64
- **Hook runner** — executes PreToolUse / PostToolUse / Stop / UserPromptSubmit hooks; `loadHookSettings` merges the **global** `~/.bandit/settings.json` under the workspace `.bandit/settings.json` so hooks + permissions + the guard apply across every repo
- **Pre-tool security guard** — `evaluateSecurityGuard(call, settings, ctx)`: an opt-in, in-process safety net (no shell spawn) that blocks catastrophic tool calls (`rm -rf /`, `curl … | sh`, disk wipes, credential exfil, writes to system/credential paths) before they run. Wired into `beforeToolExecute` in both hosts
- **MCP loader** — reads `mcp-servers.json` (global + workspace, workspace wins), auto-injects `BANDIT_API_KEY`, registers servers with the pool
- **Turn trace reader** — parses workspace and global `.bandit/turns/*.jsonl` into summaries and markdown timelines for CLI `/trace`, IDE `/trace`, tests, and future bug-bundle export
- **Insights** — usage analytics aggregator (CLI sessions → human report)
- **Extra tool builders** — `todo_write`, `web_fetch`, `web_search`, `task` (subagent), `remember`, `test_run`, `pdf_read`

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23a60ee5&width=22" align="absmiddle"> What you can do

**Load and merge project memory** — `BANDIT.md` / `CLAUDE.md` / `AGENTS.md`, deduped:

```ts
import { loadMemory, consolidateMemory } from '@burtson-labs/host-kit';

const { content } = await loadMemory(cwd);   // merged, overlapping content removed
await consolidateMemory(cwd);                // unify duplicates into one canonical BANDIT.md
```

**Lazy topic memory** — keep a tiny index in context, load topics on demand:

```ts
import { loadMemoryIndex, writeMemoryTopic } from '@burtson-labs/host-kit';

const index = await loadMemoryIndex(cwd);              // .bandit/memory/MEMORY.md
await writeMemoryTopic(cwd, 'auth-flow', '# Auth flow\n…');
```

**Inline `@-mentions`** — file contents (secret-redacted) and images, expanded into the prompt:

```ts
import { expandMentions } from '@burtson-labs/host-kit';

const { prompt, images } = await expandMentions('explain @src/auth.ts and @diagram.png', cwd);
```

**Block dangerous tool calls before they run** — opt-in, in-process, no shell spawn:

```ts
import { evaluateSecurityGuard } from '@burtson-labs/host-kit';

const verdict = evaluateSecurityGuard(call, settings.security?.guard, ctx);
if (!verdict.allow) abort(verdict.reason);   // rm -rf /, curl | sh, disk wipes, credential exfil, …
```

**Run lifecycle hooks** — `PreToolUse` blocks; `PostToolUse` / `Stop` fire-and-forget:

```ts
import { loadHookSettings, runHooks } from '@burtson-labs/host-kit';

const settings = await loadHookSettings(cwd);          // global ~/.bandit + workspace, merged
await runHooks('PostToolUse', settings, { name, primary, duration });
```

**Register MCP servers** from `mcp-servers.json` (global + workspace, `BANDIT_API_KEY` injected):

```ts
import { registerMcpServersFromDisk, addMcpServerToConfig } from '@burtson-labs/host-kit';

await registerMcpServersFromDisk(cwd, mcpPool);
```

**Drop-in agent tools** — register them straight into your tool registry:

```ts
import { buildWebSearchTool, buildTaskTool, buildTestRunTool } from '@burtson-labs/host-kit';

registry.register(buildWebSearchTool({ apiKey }));     // web search
registry.register(buildTaskTool({ /* … */ }));         // spawn subagents
registry.register(buildTestRunTool());                 // detect framework + run tests
```

**Read turn traces** — for a `/trace` view, audits, or bug bundles:

```ts
import { listTurnTraces, readTurnTrace, formatTurnTraceMarkdown } from '@burtson-labs/host-kit';

const traces = await listTurnTraces(cwd);
console.log(formatTurnTraceMarkdown(await readTurnTrace(cwd, traces[0].id)));
```

## <img src="https://api.iconify.design/lucide/shield-check.svg?color=%23a60ee5&width=22" align="absmiddle"> Status

Stable. Imported by both [`apps/bandit-cli/`](../../apps/bandit-cli/) and [`apps/bandit-stealth/`](../../apps/bandit-stealth/) — breaking changes here require coordinated PRs to both hosts.

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick example

```ts
import { loadMemory, expandMentions, registerMcpServersFromDisk } from '@burtson-labs/host-kit';

const memory = await loadMemory(workspaceCwd);
const { prompt, images } = await expandMentions(rawUserInput, workspaceCwd);
const count = await registerMcpServersFromDisk(workspaceCwd, mcpPool);
```

## <img src="https://api.iconify.design/lucide/flask-conical.svg?color=%23a60ee5&width=22" align="absmiddle"> Tests

```bash
pnpm --filter @burtson-labs/host-kit test
```

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
