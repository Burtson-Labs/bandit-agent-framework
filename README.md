<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.burtson.ai/logos/burtson-labs-logo.png" />
    <img src="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" alt="Burtson Labs" width="200" />
  </picture>

  # Bandit Agent Framework

  **A local-first AI coding agent — in your editor, at your terminal, or embedded in your app.**

  Your code never leaves your machine. Works with any Ollama model.

  [![Docs](https://img.shields.io/badge/docs-docs.burtson.ai-a60ee5)](https://docs.burtson.ai)
  [![CLI on npm](https://img.shields.io/npm/v/@burtson-labs/bandit-stealth-cli?label=CLI&logo=npm)](https://www.npmjs.com/package/@burtson-labs/bandit-stealth-cli)
  [![VS Code Marketplace](https://img.shields.io/badge/VS%20Marketplace-install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=BurtsonLabs.bandit-stealth)
  [![Open VSX](https://img.shields.io/open-vsx/v/BurtsonLabs/bandit-stealth?label=Open%20VSX)](https://open-vsx.org/extension/BurtsonLabs/bandit-stealth)
  [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

  **<img src="https://api.iconify.design/lucide/book-open.svg?color=%23a60ee5&width=16" align="absmiddle"> Full documentation: [docs.burtson.ai](https://docs.burtson.ai)**

</div>

---

## Two hosts, one runtime

| Host | When to use | Install |
|------|-------------|---------|
| **Bandit Stealth** (VS Code / Cursor) | Editing code, reviewing diffs, rich panel UI | `code --install-extension BurtsonLabs.bandit-stealth` |
| **Bandit CLI** (`bandit`) | Terminal workflows, CI, scripting, remote dev over SSH | `npm i -g @burtson-labs/bandit-stealth-cli` |

Both talk to the same [`stealth-core-runtime`](packages/stealth-core-runtime/). Skills, memory files, and hooks work identically across them.

---

## Quick start — CLI

```bash
# 1. Install Ollama and a model
brew install ollama
ollama pull gemma4:e4b              # CLI default — ~3 GB, multimodal, agent-ready

# 2. Install the CLI
npm i -g @burtson-labs/bandit-stealth-cli

# 3. Run in any project
cd ~/my-project
bandit                              # interactive REPL
bandit "explain @src/auth.ts"       # one-shot with file mention
```

First launch:

```
╭── bandit 1.7.348 ───────────────────────────
│  ollama/gemma4:e4b  •  7 skills  •  session 20260530-091245-ab3c
╰────────────────────────────────────────────
Type /help for commands, @path to pin a file, or exit to quit.

› _
```

## Quick start — VS Code

Search **Bandit Stealth** in the Extensions panel, install, and open the side panel. The agent uses tools automatically — reading files, searching code, running commands, writing changes.

---

## Features

### <img src="https://api.iconify.design/lucide/brain.svg?color=%23a60ee5&width=22" align="absmiddle"> Skills that auto-activate

Drop a markdown skill into `.bandit/skills/` and it loads on the next turn.
Skills are context packages — YAML frontmatter for metadata, a markdown body
that becomes the playbook the agent reads when the skill activates. Triggers
are regex matches on the user prompt; skills with `activation: always` run
every turn. Legacy JSON skills still load.

The default set covers:

- **Filesystem core** (always on) — read/write/edit, search, run commands, todo tracking, web fetch/search
- **Git** (always on) — status, diff, log, blame, commit drafting
- **Code review** — activates on "review my changes" / "review this PR"
- **Testing** — activates on "write tests", auto-detects vitest / jest / mocha / pytest / cargo test
- **Planning** — activates on "refactor", multi-step prompts
- **Semantic search** — activates on "how does", "where is", embedding lookups via local nomic-embed-text
- **Mail search** — activates when a Gmail MCP server is connected and the prompt references mail

Run `/skills` inside the REPL for the full list with descriptions and tool sets.
See [examples/skills/README.md](examples/skills/README.md) for the authoring guide
and copy-paste starters.

### <img src="https://api.iconify.design/lucide/notebook-pen.svg?color=%23a60ee5&width=22" align="absmiddle"> Project memory

Drop a `BANDIT.md`, `CLAUDE.md`, or `AGENTS.md` at the workspace root — the
agent auto-loads it into the system prompt so it learns your conventions
once, not every turn. All three names work; `AGENTS.md` is the OpenAI Codex
/ GitHub Copilot convention and loads alongside the others if present.

The format that works best splits into two parts — **behavior** (how the agent
should act in this repo, inspired by Karpathy's CLAUDE.md) and **project facts**
(repo-specific things you'd otherwise re-explain every session):

```markdown
## Behavior

### Before editing
- Read the file first. Don't apply_edit blind.
- For changes larger than ~10 lines, prefer `replace_range` with line numbers
  over `apply_edit`'s exact-match string.

### When changing existing code
- Don't refactor adjacent code that wasn't broken.
- Match existing style, even if you'd do it differently.

### When finishing a task
- Run the relevant verification (`test_run` / `run_command lint`).
- Don't claim done until verification passed.

## Project Facts
- This repo uses pnpm, not npm.
- Integration tests must hit a real database — no mocks.
- Prefer small focused PRs. Don't batch unrelated changes.
```

The repo root [`BANDIT.md`](BANDIT.md) is the reference implementation.

Use `/remember <fact>` inside the REPL to append a bullet from any session.
`/memory` shows everything loaded on the current turn. `/init` scaffolds a
fresh BANDIT.md in this two-section shape by reading the repo.

#### Topic memory (lazy-loaded)

For facts that only matter on some tasks — a migration playbook, an API
quirk, a deprecated module's history — drop a `MEMORY.md` index at the
repo root that points at files under `memory/`:

```markdown
# Project memory — topic index

- [Auth conventions](memory/auth.md) — when editing src/auth/*
- [Migration playbook](memory/migrations.md) — when adding DB migrations
- [CLI ink refactor](memory/cli-ink-refactor.md) — when changing the CLI input layer
```

The index (capped at 4 KB) loads into every system prompt; the linked files
do NOT. The agent reads the hook on each entry, and when one matches the
current task it calls `read_memory(name="<slug>")` to pull in the full
file (capped at 32 KB).

**When to put a fact in BANDIT.md vs `memory/<slug>.md`:**
- BANDIT.md — true on every turn (style rules, repo layout, default commands).
- `memory/<slug>.md` — only relevant to some tasks (deep history, area-specific
  playbooks, things that would bloat the system prompt for every other task).

This repo's own [`MEMORY.md`](MEMORY.md) + [`memory/`](memory/) directory
is the reference implementation.

### <img src="https://api.iconify.design/lucide/search.svg?color=%23a60ee5&width=22" align="absmiddle"> File mentions

Prefix a path with `@` in any prompt and the CLI inlines the file contents before the model sees it:

```
› why is @src/auth/login.ts throwing on line 42?
```

Up to 8 mentions per prompt, 64 KB each, auto-truncated.

### <img src="https://api.iconify.design/lucide/save.svg?color=%23a60ee5&width=22" align="absmiddle"> Session persistence

Every REPL session is saved as JSONL under `~/.bandit/sessions/`. Resume anytime:

```bash
bandit --resume 20260419-124501-ab3c
# or inside the REPL:
› /session list
› /session resume 20260419-124501-ab3c
```

### <img src="https://api.iconify.design/lucide/list-todo.svg?color=%23a60ee5&width=22" align="absmiddle"> In-agent todos

The agent can call `todo_write` to track multi-step work. Useful for longer tasks — the model sees its own plan and checks off steps as it finishes them.

### <img src="https://api.iconify.design/lucide/globe.svg?color=%23a60ee5&width=22" align="absmiddle"> Web fetch and search

`web_fetch <url>` pulls docs, RFCs, release notes directly into the conversation.
HTML is stripped to readable text, 16 KB cap, no auth. SSRF-guarded — refuses
to hit RFC1918, loopback, or cloud-metadata addresses unless
`BANDIT_ALLOW_PRIVATE_WEB_FETCH=1` is set.

`web_search <query>` returns ranked snippets via Tavily (free tier, set
`TAVILY_API_KEY`). The model gets titles, URLs, and short content blurbs — it can
follow up with `web_fetch` on a result when it needs the full page.

### <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Slash commands (REPL)

| Command | Does |
|---|---|
| `/help` | List slash commands |
| `/doctor` | Check setup, provider, model profile, and next actions |
| `/clear` | Reset conversation (keeps session id) |
| `/model <name>` | Switch model mid-session |
| `/skills` | List loaded skills |
| `/session list` / `resume <id>` / `new` | Manage sessions |
| `/memory` | Show auto-loaded `BANDIT.md` / `CLAUDE.md` |
| `/remember <fact>` | Append a bullet to `BANDIT.md` so the next session knows it |
| `/trace`, `/trace list`, `/trace failed` | Inspect recent turn telemetry and failed runs from workspace/global `.bandit/turns`; the IDE opens the Trace Logs viewer |
| `/insights` | Generate a local HTML report that synthesizes sessions + turn logs into cross-repo wins, tool stats, and friction |
| `/exit` | Quit |

### <img src="https://api.iconify.design/lucide/scissors.svg?color=%23a60ee5&width=22" align="absmiddle"> Unified-diff approval gate

Every file edit (`write_file`, `apply_edit`, `replace_range`, `apply_patch`) goes through the approval gate. The CLI and extension show a compact diff before touching disk:

```
╭── edit: src/auth/login.ts
│   function login(user, pass) {
│ - return checkPassword(user, pass);
│ + if (!user || !pass) throw new Error('missing creds');
│ + return await checkPassword(user, pass);
│   }
│    (+2 -1)
╰── apply? [y/N]
```

Set `BANDIT_AUTO_APPROVE=1` to skip prompts in CI.

For large files, `read_file` paginates with line numbers and a `shown_hash`. The agent can call `replace_range` with `start_line`, `end_line`, replacement `content`, and optional `expected_hash` copied from `read_file` to land a method/component-sized refactor without resending the whole file or a giant exact-match string.

### <img src="https://api.iconify.design/lucide/webhook.svg?color=%23a60ee5&width=22" align="absmiddle"> Hooks

Drop `.bandit/settings.json` in any project:

```jsonc
{
  "hooks": {
    "PreToolUse":  [{ "match": "run_command", "command": "./scripts/guard.sh {{name}} {{primary}}" }],
    "PostToolUse": [{ "match": ".*", "command": "echo '{{name}} took {{duration}}ms' >> .bandit/audit.log" }],
    "Stop":        [{ "command": "osascript -e 'display notification \"bandit done\"'" }]
  }
}
```

- Hooks are shell commands. They run with `.bandit/` as the cwd.
- `{{name}}`, `{{primary}}`, `{{duration}}` are expanded at call time.
- A non-zero exit from a `PreToolUse` hook prints a warning (but doesn't yet abort — planned).

### <img src="https://api.iconify.design/lucide/chart-line.svg?color=%23a60ee5&width=22" align="absmiddle"> Insights — local-only activity report

`/insights` (CLI) or **Bandit Stealth: Open Insights** (IDE) generates a single self-contained HTML file from your local session and turn-log data — no server, no external resources, no telemetry, opens in any browser, sharable as one file. The report synthesizes how you and the agent have actually been working over time, broken into panels:

- **At a glance** — sessions, user prompts, token estimate, total tool calls, longest / current streak, peak day, days since first run, commits made
- **Your story** *(optional AI summary, gated by `insightsAiConsent`)* — three short narrative cards: *What you shipped* · *How you work* · *Where Bandit got in your way*. Cloud users see this when the cloud LLM consent is on; local Ollama users see it when a local model is configured. The framing prompt attributes every friction point to Bandit, never the user — the goal is empathetic product feedback, not a postmortem of the human
- **Recent wins** *(local synthesis, no AI)* — cross-repo arc detection from raw session text
- **How you felt** · **Bigger arcs** · **Largest work highlights** — extracted themes and longest investigations
- **Accomplishments** — files touched, edits + writes applied, git operations, subagents spawned, languages touched, most-touched files
- **Activity (last 14 days)** — inline SVG bar chart of prompt volume per day
- **Tool usage** — top N tools by call count with success/error split
- **Productivity tips** · **Recent sessions** · **Top error patterns**
- **Help shape Bandit** — one-click `mailto:` button that ships the HTML to `team@burtson.ai` only if you click it

Data sources are all local: `~/.bandit/sessions/*.jsonl` (every REPL session) + `<cwd>/.bandit/turns/*.jsonl` (per-turn telemetry for the current workspace). The report writes to `~/.bandit/insights.html` by default. The AI summary is the only path that touches a model — disable it with `insightsAiConsent: deny` in `~/.bandit/config.json` (or the equivalent setting in the IDE) for a fully offline report.

### <img src="https://api.iconify.design/lucide/wrench.svg?color=%23a60ee5&width=22" align="absmiddle"> Native tool calling (when the model supports it)

The runtime checks each model's built-in capability profile first (`bandit-logic`, the Qwen 3.6 family, Qwen 2.5 / 2.5-Coder, Llama 3.1+, Devstral, the bandit-core ≥12B fine-tunes) and routes tool schemas through Ollama's `tools:` field instead of the XML system-prompt block. Saves ~1.5–3 KB per turn and removes a whole class of "the model forgot the envelope" failures. Gemma 3 / Gemma 4 and other text-only families fall back to the XML protocol with the full mitigation stack armed. As of v1.7.340, the dispatch is gated on the built-in profile so an Ollama auto-detect glitch can't silently downgrade a tool-calling model — and the same retry ladder (3 native attempts → text channel switch → 3 text attempts → outer-text-retry → 3 more attempts → final-anchor re-prompt) protects every native-tools turn from transient gateway blips.

### <img src="https://api.iconify.design/lucide/plug.svg?color=%23a60ee5&width=22" align="absmiddle"> Model Context Protocol — both directions

Bandit speaks MCP as a **client** and a **server**. Drop any MCP server (filesystem, GitHub, Slack, GitLab, Gmail, Postgres, your own) into `~/.bandit/mcp-servers.json` or `<workspace>/.bandit/mcp-servers.json` and its tools surface as `<server>.<tool>` alongside the native ones. Stdio (`command`/`args`/`env`) and remote Streamable HTTP (`url` + `auth`, including `auth: "bandit"` for the hosted gateway) both supported as of v1.7.333. First spawn of any server requires user approval; "Always allow" persists a fingerprint to `~/.bandit/mcp-trust.json`. Connector wizards in the IDE Settings → Connections for GitHub/Slack/GitLab/Gmail/Custom; CLI parity via `/mcp add github <token>` etc.

`bandit mcp serve` turns the CLI into an MCP server exposing the native tool surface over stdio — any MCP client (Claude Desktop, Cursor, Cline, Continue) can drive Bandit's tools through the standard JSON-RPC envelope. `--read-only` strips write/exec tools for view-only clients.

### <img src="https://api.iconify.design/lucide/mic.svg?color=%23a60ee5&width=22" align="absmiddle"> Voice — pluggable providers, independent of chat

Speech-to-text and text-to-speech are configured separately from the chat provider. Run Ollama locally for chat and pair it with whichever voice setup matches your privacy / cost / latency preference. STT: Bandit cloud, OpenAI-compatible Whisper (faster-whisper-server, whisper.cpp HTTP, OpenAI, LiteLLM), or any custom multipart endpoint. TTS: Bandit cloud, OpenAI (`tts-1` / `tts-1-hd`), ElevenLabs, a local Piper HTTP server, or any custom URL. Local-only setups (Ollama + self-hosted Whisper + Piper) work without a cloud account.

### <img src="https://api.iconify.design/lucide/workflow.svg?color=%23a60ee5&width=22" align="absmiddle"> Mid-turn queue + background subagents

Type a follow-up while the agent is still working and it queues (`queued: N · sends after this turn` in the status row); Esc cancels the run and clears the queue. The agent can spawn background subagents for long investigations and keep iterating in the foreground — when a subagent finishes, its synopsis injects into the parent's next iteration instead of forcing a `check_task` poll loop (v1.7.336+). Inspect with `/tasks`, cancel with `/tasks cancel <id>`. Stop cascades to all in-flight subagents (v1.7.338).

### <img src="https://api.iconify.design/lucide/palette.svg?color=%23a60ee5&width=22" align="absmiddle"> UI/UX polish

- ANSI color, box-drawn headers, "shifty eyes" spinner with a breathing glow on truecolor terminals
- Clean `→ tool-name arg` tool-call lines with `✦ using skill: …` markers
- Live plan dock — `todo_write` updates commit to scrollback as the plan evolves
- Per-turn timer + live tok/s on the status line, terminal title reflects the active prompt
- Colored unified diff viewer in the approval gate
- Respects `NO_COLOR` / `BANDIT_NO_COLOR` / non-TTY stdout

---

## Model support

Built-in capability profiles ship for the families listed below. Anything else gets auto-introspected through Ollama's `/api/show` and matched to a behavior profile by name pattern. The canonical inventory lives in [`packages/stealth-core-runtime/src/runtime/modelCapabilities.ts`](packages/stealth-core-runtime/src/runtime/modelCapabilities.ts).

| Model | Size | Native tool calling | Vision | Context | Best for |
|---|---|---|---|---|---|
| `bandit-logic` (Qwen 3.6 27B, hosted) | — | ✓ | ✓ | 256K | Cloud default — agent-tuned, no local install, thinking mode |
| `qwen3.6:27b` | ~17 GB | ✓ | ✓ | 256K | Best local pick — same family as `bandit-logic`, M-series 48GB+ or H100-class |
| `qwen3.6:35b` | ~24 GB | ✓ | ✓ | 256K | Larger Qwen 3.6; tends to stall in reasoning-only output, prefer 27B for agent loops |
| `gemma4:31b` | ~19 GB | text-fallback | ✓ | 128K | RTX 5090 / GPU node — high-fidelity local |
| `gemma4:26b` | ~17 GB | text-fallback | ✓ | 128K | Mac 32GB+ alternative when Qwen 3.6 is too heavy |
| `gemma4:e4b` | ~3 GB | text-fallback | ✓ | 16K | Lightweight laptop pick — punches above its weight on tool sequencing |
| `gemma4:e2b` | ~2 GB | text-fallback | ✓ | 16K | Smallest "effective" Gemma 4 tune |
| `gemma3:12b` / `gemma3:27b` | ~9 / 17 GB | text-fallback | ✓ | 32K | Older Gemma 3 family — still works, gets less attention |
| `qwen2.5-coder:14b` / `:32b` / `:72b` | ~9 / 20 / 45 GB | ✓ | — | 128K | Code-completion tune — good on concrete tasks, weaker as autonomous agent |
| `qwen2.5:7b` / `:32b` / `:72b` | varies | ✓ | — | 128K | Qwen 2.5 base — text only, reliable tool emitter |
| `qwen2.5vl` / `qwen2-vl` | varies | ✓ | ✓ | 32–128K | Qwen vision-language variants |
| `llama3.1` | varies | ✓ | — | 128K | Meta's Llama 3.1 — text only |
| `llama3.2-vision` | varies | text-fallback | ✓ | 128K | Llama 3.2 multimodal |
| `llama3` | varies | text-fallback | — | 8K | Original Llama 3 — narrow context, kept for compatibility |
| `bandit-core:12b` / `:27b` / `:31b` | varies | ✓ | optional | 32K–128K | Our own Gemma-3-derived fine-tunes (12B / 27B / 31B) |
| `bandit-core-1` / `bandit-core-2` (hosted) | — | varies | varies | 128K | Hosted bandit fine-tunes — `-1` for lightweight, `-2` for RunPod 70B (text-only) |
| `deepseek-coder:6.7b` | ~4 GB | text-fallback | — | 16K | Small, fast code model |
| `llava` | varies | text-fallback | ✓ | 4K | Dedicated vision model (optional pull) |
| any other Ollama model | — | auto-detected via `/api/show` | auto-detected | auto-detected | Drop-in via `BANDIT_MODEL` |

**Primary development and test targets** are `bandit-logic` (cloud) and the **gemma4 / qwen3.6** local families. **Models we don't recommend for autonomous agent work** — `gpt-oss:120b` (post-trained for OpenAI's harmony tool-call format, narrates without emitting tool calls), and code-completion tunes like `qwen2.5-coder:32b` on ambiguous prompts (asks for paths instead of probing). See [`apps/bandit-stealth/README.md`](apps/bandit-stealth/README.md#models-we-dont-recommend-for-agent-work) for the full caveats.

Model behavior profiles now sit beside capability detection. `/profile` explains the active model's harness strategy — native vs text tools, fallback policy, safe context/output budget, thinking default, max tool parallelism, and reliability guardrails. Both the CLI and extension load `.bandit/model-profiles.json`, and the tool loop now uses those profile values to choose native-vs-text tools, serialize risky edit batches, cap parallel calls, and decide whether native failures should fall back to text tools.

---

## Benchmarks

A single reproducible run — `bandit-logic` (Qwen 3.6 27B via the hosted gateway) given a fresh **"deep dive this repo and tell me what it does at a high level"** prompt against a real React + TypeScript + Vite project (the author's personal portfolio site — 11 projects, ~30 files, no inlined `@`-mentions).

| Metric | Value |
|---|---|
| **Wall-clock turn duration** | 28.25 s |
| **LLM iterations** | 5 (4 tool-call rounds + 1 final answer) |
| **Tool calls** | 12 (`read_file` ×10, `ls` ×1, `list_files` ×1) |
| **Final answer length** | 2,022 chars (~500 tokens) |
| **Per-iteration LLM time** | 5.05 s → 2.95 s → 2.56 s → 4.85 s → 12.81 s (final answer) |
| **Provider** | `bandit` cloud (`provider=bandit`, `model=bandit-logic`) |
| **CLI version** | 1.7.348 |
| **Trace** | `Portfolio/.bandit/turns/turn-2026-05-30T21-26-52-368Z-afyl.jsonl` |

The shape of the run is what we want out of the harness: the model probes (`ls` + `package.json`), narrows (`README` + `src/**` listing), reads the entry points (`App.tsx`, `main.tsx`, `index.html`), pulls in the data files (`projects.ts`, `experience.ts`, `skills.ts`) and two representative section components, then commits to a final answer instead of padding with one more probe round. No reasoning-only stalls, no retry slots fired, no native-fallback re-prompts.

**Hardware:** the cloud provider serves `bandit-logic` from our own GPU pool; the client side ran on an M4 Max MacBook Pro. For local model comparisons, our reference rigs are an M4 Max (`qwen3.6:27b` ~ 17 GB resident, ~ 30 tok/s) and an RTX 5090 node (`gemma4:31b` ~ 19 GB resident, ~ 80 tok/s). Numbers will vary on different hardware; the run above is one data point, not a leaderboard.

**Reproduce it yourself:**

```bash
cd /path/to/any/medium-sized/repo
BANDIT_PROVIDER=bandit BANDIT_MODEL=bandit-logic \
  bandit "deep dive this repo and tell me what it does at a high level"
# Then read .bandit/turns/turn-*.jsonl for the full event timeline.
```

---

## CLI environment

| Var | Default | Description |
|---|---|---|
| `BANDIT_PROVIDER` | `ollama` | `ollama` or `bandit` |
| `BANDIT_MODEL` | `gemma4:e4b` | Model ID |
| `BANDIT_API_KEY` | — | Required when `BANDIT_PROVIDER=bandit` |
| `BANDIT_API_URL` | `https://api.burtson.ai/completions` | Completions / Bandit Cloud API endpoint |
| `BANDIT_AUTH_URL` | `https://auth.burtson.ai` | OIDC issuer / device-key auth API — point this at your own auth service when self-hosting |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `BANDIT_MAX_ITERATIONS` | `20` | Tool-use loop cap |
| `BANDIT_AUTO_APPROVE` | `0` | `1`/`true` to skip write-approval prompts |
| `TAVILY_API_KEY` | — | Enables the `web_search` tool (free tier at tavily.com) |
| `BANDIT_ALLOW_PRIVATE_WEB_FETCH` | `0` | `1` to allow `web_fetch` against RFC1918/loopback/link-local hosts |
| `BANDIT_NO_SECRET_REDACTION` | `0` | `1` to disable automatic secret redaction in tool output (debug only) |
| `NO_COLOR` | — | Disable ANSI colors |

---

## Architecture

```
User prompt
  ↓
SkillRegistry.resolveActiveSkills(prompt)
  ↓
ToolUseLoop (observe → act → replan)
  ↓
  ├─ ToolRegistry (XML tool defs in system prompt)
  │     ├─ Built-in tools (read, write, search, run, git, …)
  │     ├─ CLI tools (todo_write, remember, web_fetch, web_search)
  │     └─ Custom skills from .bandit/skills/*.md (or legacy *.json)
  │
  ├─ LLM Provider
  │     ├─ Ollama (/api/chat, streaming NDJSON)
  │     └─ Bandit Cloud (optional hosted inference)
  │
  ├─ LanguageAdapters (pre-write validation)
  │     └─ TypeScript, Python, JSON, C# (more via skills)
  │
  └─ Host-specific bindings
        ├─ bandit-stealth (VS Code / Cursor) — vscode API, webview UI
        └─ bandit-cli (terminal) — readline REPL, ANSI, sessions
```

**Design rules:**

1. Local models are first-class citizens, not a fallback.
2. One runtime, multiple hosts. Skills / memory / hooks are host-agnostic.
3. Language adapters validate before write. Invalid content never reaches disk.
4. Skills activate based on intent. The model decides when to plan vs. act directly.

---

## What is still maturing

To keep expectations honest — areas still on the roadmap:

- Plan mode (in the CLI — the VS Code extension has a variant)
- Status-line / full TUI polish
- Lossless trace replay for every native-tool run

See [`docs/integration-playlist/agent-roadmap-unified.md`](docs/integration-playlist/agent-roadmap-unified.md) for what's planned.

---

## Custom skills

Ask the agent to build one: *"create a skill that runs my linter"* — it writes `.bandit/skills/linter.md` (markdown with YAML frontmatter is the current shape; legacy `*.json` still loads) and next prompt it's live.

Or author by hand. The manifest format is documented in [`examples/skills/README.md`](examples/skills/README.md).

---

## Bandit Cloud

For teams that want hosted infrastructure — workspace indexing, Qdrant semantic search, team dashboards, GPU inference, PR automation — see [Bandit Cloud](https://burtson.ai).

## Contributing tests

The agent runtime (`@burtson-labs/agent-core`) is the most heavily tested package. New behaviors should land with a contract test, and recurring failure modes worth defending against should land with a real-trace replay fixture.

- **Run the suite:** `pnpm --filter @burtson-labs/agent-core test`
- **What's pinned:** see [packages/agent-core/README.md](packages/agent-core/README.md) for the full coverage map (constructor options, every detector cluster, cancellation, compaction, replay).
- **Adding a regression fixture from a real failure trace:** [packages/agent-core/test/fixtures/turns/README.md](packages/agent-core/test/fixtures/turns/README.md) walks through the steps — picking a `.bandit/turns/*.jsonl`, replay-completeness limits, naming, and what to assert.

## Contributing

Bug fixes, local-model improvements, new skills, and docs PRs are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the guide — repo layout, build commands, what we accept without prior discussion, and what to flag in an issue first.

## Security

Email **[team@burtson.ai](mailto:team@burtson.ai)** for security reports — don't open public GitHub issues. Full disclosure policy in [SECURITY.md](SECURITY.md).

## Issues & feature requests

[Open an issue](https://github.com/Burtson-Labs/bandit-agent-framework/issues) for bugs and feature ideas, or email [team@burtson.ai](mailto:team@burtson.ai) if you'd rather not go through the public tracker.

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Burtson Labs. See [NOTICE](NOTICE) for attribution.

## In Memory of Ryan Richard Burres

This project is dedicated to my little brother, Ryan.

You are under no obligation under the Apache 2.0 license, but if this software has been useful to you, please consider a donation to the [American Foundation for Suicide Prevention — Missouri Chapter](https://afsp.org/chapter/missouri).

AFSP funds research, education, advocacy, and survivor support — the work of preventing what took Ryan from us, and of helping the families left behind.
