<a href="https://burtson.ai">
  <picture>
    <img src="https://cdn.burtson.ai/logos/bandit-stealth.png" alt="Bandit Stealth" width="140" style="width: 140px !important; max-width: 140px !important; height: auto; display: inline-block;" />
  </picture>
</a>

# Bandit — Agent CLI

**Local-first AI coding agent for your terminal.**

Your code never leaves your machine. Works with any Ollama model.

*Prefer an IDE?* The sibling Bandit Stealth extension for VS Code / Cursor ships the same runtime, skills, and tool-use loop — install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=BurtsonLabs.bandit-stealth) or [Open VSX](https://open-vsx.org/extension/BurtsonLabs/bandit-stealth).

[![npm](https://img.shields.io/npm/v/%40burtson-labs%2Fbandit-stealth-cli?logo=npm&color=cb3837)](https://www.npmjs.com/package/@burtson-labs/bandit-stealth-cli)
[![node](https://img.shields.io/node/v/@burtson-labs/bandit-stealth-cli.svg)](https://nodejs.org)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

<p>
  <img src="https://cdn.burtson.ai/images/cli-demo.gif" alt="Bandit CLI demo: boot banner, shortcuts overlay, background subagent + live tile, /insights, async completion" width="780" />
</p>

---

## Install

1. Install **[Ollama](https://ollama.com)** and pull a model:

   ```bash
   brew install ollama                       # or download installer
   ollama pull qwen2.5-coder:7b              # fast, tool-calling, ~4.7 GB
   ```

2. Install the CLI globally — curl, or npm if you prefer:

   ```bash
   curl -fsSL https://burtson.ai/bandit-stealth-cli/install.sh | sh
   # or: npm i -g bandit-stealth-cli
   ```

3. Run it:

   ```bash
   bandit                                     # interactive REPL
   bandit "explain @src/auth/login.ts"        # one-shot with a file mention
   ```

That's it. No API keys. No cloud services. The agent reads your code, searches, runs commands, and writes changes — all locally.

---

## What it does

- **Agentic tool use** — reads files, searches code, runs commands, writes changes
- **Auditable approval gate** — writes show a colored diff, shell commands show the full command/cwd/risk, and `Allow once` / `Allow session` / `Always for target` scopes are recorded in turn traces
- **Pre-write validation** — TypeScript, Python, JSON, C# syntax-checked before the agent can write
- **Post-write validation** — JSON edits are re-parsed after write; failure feeds back to the agent on the next turn so it self-corrects without you flagging it
- **Skills system** — agent activates specialized skills based on your prompt, and can create its own
- **Background subagents** — long investigations spawn detached; status bar shows `bg:N running`; you keep talking; synopsis auto-injects when ready (`/tasks` to inspect, drill down, or cancel)
- **`watch_command`** — run a dev server / `--watch` test runner for a bounded window, agent reacts to what came out
- **`find_directory`** — cross-repo discovery; ask "open the auth-api repo" and the agent sweeps `~/Documents/GitHub`, `~/GitHub`, `~/Projects`, `~/code`, `~/dev`, `~/repos`, `~/work`, `~/src`, plus the workspace parent — no "where is that repo?" round-trips
- **MCP both directions** — speaks the Model Context Protocol as a client (`/mcp add github <token>`, `/mcp add slack`, `/mcp add gitlab`, `/mcp add custom <name> <cmd…>`) and as a server (`bandit mcp serve` exposes Bandit's native tool surface over stdio so Claude Desktop / Cursor / Cline / Continue can drive your codebase through it)
- **Installs CLIs on demand** — ask Bandit to install `ripgrep`, `httpie`, the GitHub CLI, etc. and it picks the right package manager (`brew`, `npm install -g`, `pip install`, `cargo install`, `gem install`, `go install`) and runs it through the permission gate
- **Interactive scaffolders work** — `create-vite`, `create-react-app`, `ng new`, etc. detect a non-TTY stdin and self-abort. Bandit recognizes the pattern and surfaces a clear *"run this with `!`"* recovery hint so the model doesn't loop on a "command appeared to succeed" misread
- **Live command output** — `npm install`, `pip install`, `watch_command npm run dev` stream their output to your terminal as it arrives, dimmed, while the spinner keeps animating. No more wondering if a 20-second install is hung
- **Interrupt + queue** — press **Esc** mid-turn to cancel the agent and clear your queue. Type a follow-up + Enter to queue it (`queued: N · sends after this turn` in the status row). The next turn picks it up automatically
- **Opt-in notifications** — `/notify on` enables desktop notifications for approvals, failures, background-task completion, and long turns; `/notify sound on` adds a terminal bell
- **`?` shortcuts overlay** — type `?` at an empty prompt for a live cheatsheet that disappears the moment you backspace it
- **`!`-prefix shell escape** — `!cmd` runs straight in your shell with full TTY access. First-use confirmation gate; per-call yellow box every time after so you can't miss the bypass. Catastrophic patterns (`rm -rf`, `mkfs`, `dd if=`) blocked even here
- **Plan execution** — structured multi-step plans for complex refactors
- **Session persistence** — every REPL session saved as JSONL under `~/.bandit/sessions/` for later resume
- **Turn traces** — every agent turn writes a JSONL trace under `.bandit/turns`; `/trace` turns the latest trace into a readable timeline, `/trace list` browses recent workspace/global turns, and `/trace failed` filters recovery/debugging runs
- **`/insights` HTML report** — local-only activity report: reads global sessions plus workspace/global turn logs, reconstructs cross-repo wins, surfaces bigger arcs and outcome snippets, then adds tool stats, top-touched files, languages, streak, peak day, error patterns, optional AI summary, and mailto share
- **Model behavior profiles** — `/profile` shows how Bandit treats the active model: native vs text tools, fallback policy, safe context budget, thinking default, parallel-tool limits, and known failure modes
- **Project memory** — drop a `BANDIT.md` or `CLAUDE.md` at your workspace root and it's auto-loaded into the system prompt
- **File + image mentions** — `@path` auto-inlines files; images are either sent multimodally or OCR'd locally (Apple Vision / tesseract)
- **Clipboard paste** — `Ctrl+V` in the REPL pastes an image straight from your clipboard
- **Hooks + security guard** — `PreToolUse` / `PostToolUse` / `Stop` shell hooks (global `~/.bandit/settings.json` or per-workspace), plus an opt-in built-in guard that blocks catastrophic commands. See [Settings file](#settings-file--hooks-permissions-security-guard)
- **12 themes** — Stealth Light/Dark, Midnight, Onyx, Charcoal, Dracula, Nord, Tokyo Night, Solarized Dark/Light, Catppuccin Mocha, Sepia. `/theme` to pick
- **Cross-platform** — macOS, Linux, Windows; Windows `.cmd`/`.bat` shims (npm/npx/pnpm/tsc) resolved correctly
- **Update-aware** — fire-and-forget npm-registry check at boot; `update vX.Y.Z available` shows in the status bar when a newer CLI is published

---

## Slash commands

Type `?` on an empty prompt for the at-a-glance overlay; `/help` for the full list.

| Command | Does |
|---|---|
| `/help` | Full slash-command list |
| `/doctor` | Check setup, provider, workspace context, permissions, and next best actions |
| `/login <key>` | Save a Bandit Cloud API key to `~/.bandit/config.json` (also `/login`, `/login clear`) |
| `/usage` | Bandit Cloud session + weekly usage limits (`/usage check` for one-line ⚠ flag) |
| `/model [name]` | Switch model mid-session |
| `/ollama [url]` | Show or set the Ollama endpoint — `/ollama default` resets to `http://localhost:11434` |
| `/think on`, `/think off`, `/think auto` | Override per-model thinking-mode default |
| `/profile [model]` | Show the active model behavior profile (tool protocol, fallback, context budget, known failure modes) |
| `/notify status` | Configure desktop/bell notifications for approvals, failures, background tasks, and long turns |
| `/theme [name]` | Pick a color palette (`/theme` lists; saved to global config) |
| `/skills` | List loaded skills |
| `/session list`, `/session resume <id>`, `/session new` | Manage sessions |
| `/memory` | Show auto-loaded `BANDIT.md` / `CLAUDE.md` |
| `/config` | Show effective config + path (secrets redacted) |
| `/clear` | Reset conversation (keeps session id) |
| `/compact` | Trim old tool results to fit the context window |
| `/rewind [id]` | Restore a file from a per-edit checkpoint |
| `/trace`, `/trace list`, `/trace failed`, `/trace <id>` | Inspect turn traces from workspace/global `.bandit/turns` |
| `/tasks` | List background subagent tasks (`/tasks <id>` drill-down, `/tasks cancel <id>`) |
| `/plan <goal>` | Heuristic plan first, y/N to execute |
| `/init` | Scaffold `BANDIT.md` from a repo scan |
| `/commit` | Draft a conventional-commit message from the staged diff |
| `/review [focus]` | Code review of staged changes or branch-vs-main, ends with 🟢/🟡/🔴 |
| `/refactor <target>` | Concrete refactor suggestions with before/after snippets |
| `/test <target>` | Generate tests in the project's existing framework |
| `/explain <target>` | Plain-English walkthrough of a file or function |
| `/onboard` | New-developer setup checklist for the repo |
| `/changelog [range]` | Release notes drafted from `git log` |
| `/exit` | Quit |

---

## Skills

The agent activates specialized skills based on your prompt:

| Skill | Trigger | What it does |
|---|---|---|
| Filesystem | always | Read, write, search, list, run commands |
| Git | always | Status, diff, log, commit |
| Code Review | "review my changes" | Diff + full file context |
| Testing | "write tests" | Auto-detect runner, generate tests |
| Planning | "refactor the auth system" | Structured multi-step decomposition |
| Semantic Search | "how is auth implemented" | Local embedding search |

### Custom skills (the agent can make its own)

Ask: *"create a skill that runs my linter"*

The agent writes `.bandit/skills/linter.md`. Next prompt, it's live. Ask *"lint my code"* and it runs.

---

## MCP — Model Context Protocol servers

Bandit speaks MCP as a client, so any MCP server you can spawn (filesystem, git, GitHub, Google Drive, Gmail, Slack, Postgres, custom workplace tools…) plugs straight into the same tool-use loop. Each server's tools are namespaced as `<server>.<tool>` and registered alongside `read_file`, `apply_edit`, etc.

**Configure** at `~/.bandit/mcp-servers.json` (global) or `.bandit/mcp-servers.json` (workspace, takes precedence). Schema is the standard MCP `mcpServers` shape — the same JSON other MCP clients use, so configs port between them:

```jsonc
{
  "mcpServers": {
    "fs-tmp": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

**Manage** with the `/mcp` slash command:

| Command | What it does |
|---|---|
| `/mcp` | List configured servers + status (connected / idle / error) and tool counts |
| `/mcp tools <name>` | Spawn the server (lazy) and introspect its exposed tools |
| `/mcp connect <name>` | Explicit warmup so the first invocation isn't slow |
| `/mcp disconnect <name>` | Close the server's child process (re-spawns lazily on next use) |
| `/mcp reload` | Re-read the config files from disk after edits — no restart needed |

Servers spawn lazily on first invocation, persist for the session, and get cleaned up on REPL exit. Failures are isolated — a broken server logs an error and the rest of the loop keeps running on native tools only. Off by default — no config file = zero behavior change.

---

## Recommended models

Pull one with `ollama pull <model>`. Bandit auto-detects each model's capabilities and takes the native tool-calling path when supported.

| Model | Where | Notes |
|---|---|---|
| `bandit-logic` (cloud) | Bandit gateway (API key) | **Default for cloud.** Agent-tuned wrapper around Qwen 3.6 27B with thinking mode. Best reliability on multi-step agent tasks — what we recommend trying first. |
| `qwen3.6:27b` | Local / Mac 48GB+, high-VRAM GPU (~17 GB) | **Best local pick.** Same family as `bandit-logic`, runs offline. Probes the filesystem instead of asking for clarification — real agent behavior. |
| `gemma4:26b` | Local / Mac 32GB+ (~17 GB) | Solid alternative when Qwen 3.6 is too heavy for your hardware. Multimodal, 128K context. |
| `gemma4:e4b` | Local / laptop-class (~3 GB) | Lightweight pick that punches above its weight. Validated on real Bandit runs — clean tool sequencing (`ls` → narrow → `read_file`), no hallucinated paths. Right pick when you want a local agent that doesn't pin your fans. |
| `gemma4:31b` | Local / Mac 64GB+, GPU node | Bigger context, better reasoning for complex refactors. |
| `qwen2.5-coder:7b` | Local / Mac (~4.7 GB) | Fast lightweight pick. Native tool calling. Best for "given context, do X" tasks rather than autonomous discovery. |
| `devstral:latest` | Local / Mac 32GB+ | Mistral's agent-tuned model — strong tool use. |
| `bandit-core-1` (cloud) | Bandit gateway (API key) | Lightweight cloud option. Faster first-token than `bandit-logic`, less reliable on multi-step agent tasks. |

### Models we don't recommend (for agent work)

Bandit is an autonomous agent harness — it expects the model to discover repo structure, plan edits, and emit tool calls without being hand-held. Some otherwise-impressive models aren't trained for that workflow and produce unexpected results:

- **`gpt-oss:120b` and other reasoning-tuned models** — post-trained for OpenAI's harmony tool-call format, not the XML/native protocols Bandit uses. Tends to narrate intent ("I'll search for the controllers...") without ever emitting an actual tool call.
- **`qwen2.5-coder:32b` and other code-completion-tuned models** — post-trained for fully-specified code-generation benchmarks. On ambiguous prompts it asks for paths instead of probing. Solid for concrete tasks; underwhelming as an autonomous agent.
- **`qwen3.6:35b`** — the larger Qwen 3.6 variant stalls in reasoning-only output and ignores the harness's "act now" nudges. The 27B is the better production pick from this family.

If you want to test models outside the recommended list, expect the reasoning-only / narrate-but-no-action / partial-completion detectors to fire frequently. Those are signal — they mean the model isn't a great fit for autonomous agent work.

**Capability dispatch**:

- **Native tool calling** — Qwen 3.6, Qwen 2.5 Coder, Llama 3.1+, Devstral, DeepSeek-Coder-V2+. Tool schemas go in Ollama's `tools:` field. Saves ~1500–3000 tokens per turn.
- **Text-parsing fallback** — Gemma 3/4 and anything else. XML-style tool block lives in the system prompt with the full mitigation stack armed.

**Behavior profiles** sit beside capability detection. Capabilities answer "can this model do native tools or vision?" Behavior profiles answer "what should the harness do with it?" For example, Qwen 3.6 starts on native tools and degrades to text tools on retryable native-parser/watchdog failures; Gemma-family models use compact text-tool prompting and earlier compaction; unknown models default to serialized text tools. The profile's `context.outputBudgetTokens` and `reliability.maxParallelTools` now directly drive the loop's heavy-batch serialization and parallel-call cap in both CLI and extension. Inspect the active profile with `/profile`.

Workspace overrides load from `.bandit/model-profiles.json`:

```jsonc
{
  "version": 1,
  "profiles": {
    "my-qwen": {
      "match": ["my-qwen:14b"],
      "protocol": { "preferred": "text-tools", "fallback": null, "envelope": "xml-json" },
      "context": { "safeInputTokens": 12000, "outputBudgetTokens": 2048, "compaction": "early" },
      "prompting": { "template": "qwen-agent", "examples": "strict", "thinking": "off" },
      "reliability": { "maxParallelTools": 1, "knownFailureModes": ["custom parser drift"] }
    }
  }
}
```

Any Ollama model works — capabilities auto-detect via `/api/show`.

---

## Configuration

### Config file (preferred)

`~/.bandit/config.json` or `<workspace>/.bandit/config.json`:

```jsonc
{
  "provider": "ollama",                       // or "bandit"
  "model": "qwen2.5-coder:7b",
  "ollama": {
    "url": "http://localhost:11434",
    "headers": { "Authorization": "Bearer ..." }  // optional
  },
  "bandit": {
    "apiKey": "bnd_...",
    "apiUrl": "https://api.burtson.ai"
  }
}
```

Workspace config overrides user config. Secrets belong in the user-level file, not in a committed workspace file.

### Environment variables

| Var | Default | Description |
|---|---|---|
| `BANDIT_PROVIDER` | `ollama` | `ollama` or `bandit` |
| `BANDIT_MODEL` | `gemma4:e4b` | Model ID |
| `BANDIT_API_KEY` | — | Required when `BANDIT_PROVIDER=bandit` |
| `BANDIT_API_URL` | `https://api.burtson.ai` | Override Bandit API endpoint |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `BANDIT_MAX_ITERATIONS` | `20` | Tool-use loop cap |
| `BANDIT_AUTO_APPROVE` | `0` | `1`/`true` to skip write-approval prompts |
| `BANDIT_TELEMETRY` | `0` | `1`/`true` to enable OTLP telemetry (opt-in) |
| `BANDIT_OTLP_ENDPOINT` | `https://otlp.burtson.ai` | OTLP/HTTP collector base URL |
| `BANDIT_OTLP_TOKEN` | — | Bearer token for the collector (defaults to your Bandit token) |
| `BANDIT_OTLP_MODE` | `metrics+traces` | `metrics-only` to drop span payloads |
| `NO_COLOR` | — | Disable ANSI colors |

### Settings file — hooks, permissions, security guard

Separate from `config.json`, a **settings** file controls what the agent is allowed to do. It's read from two places and **merged** — the global file applies to every repo, the workspace file adds project-specific rules on top:

- `~/.bandit/settings.json` — global (all workspaces)
- `<workspace>/.bandit/settings.json` (and `.bandit/settings.local.json`) — per-project

```jsonc
{
  // Built-in pre-tool security guard. OPT-IN, off by default. Blocks the
  // handful of tool calls that are almost never legitimate, BEFORE they run —
  // a safety net against the model footgunning (e.g. a hallucinated rm -rf /).
  "security": {
    "guard": {
      "enabled": true,
      "blockCommands": ["npm\\s+publish"],   // optional: extra regex patterns to block
      "protectPaths": ["/data/prod"]          // optional: extra write-protected path prefixes
    }
  },

  // Your own shell hooks around the tool loop. A non-zero exit from a
  // PreToolUse hook BLOCKS the tool call. Placeholders: {{name}}, {{primary}},
  // {{duration}} (PostToolUse only).
  "hooks": {
    "PreToolUse":  [{ "match": "write_file", "command": "./scripts/guard.sh {{name}}" }],
    "PostToolUse": [{ "match": ".*",         "command": "echo {{name}} took {{duration}}ms" }],
    "Stop":        [{ "command": "./scripts/notify-done.sh" }]
  },

  // Per-tool permission policy (deny > allow > ask > built-in defaults).
  "permissions": { "allow": ["run_command:git *"], "deny": [], "ask": ["run_command"] }
}
```

**What the guard blocks when enabled** (high-confidence patterns only, so false positives stay rare):
catastrophic `rm -rf /` · `~` · `/*` · a remote script piped to a shell (`curl … | sh`) · raw disk writes (`dd of=/dev/sda`, `mkfs`) · fork bombs · recursive `chmod`/`chown` on `/` · writes or redirects into system/credential paths (`/etc`, `~/.ssh`, `~/.aws`, …) · reading a credential file **and** sending it over the network in one command.

The guard is **defense-in-depth against the model**, not a sandbox and not protection against a malicious user (who controls this file). It runs **before** your hooks and the approval gate, and behaves identically in the CLI and the IDE extension.

#### Hooks — any scripted step, not just guardrails

Hooks run **your own commands** at three points in the loop. Only `PreToolUse` is a gate; the rest are fire-and-forget side effects — so reach for them for version bumps, formatters, notifications, CI triggers, anything scriptable.

| Event | Fires | Blocks the tool? |
|---|---|---|
| `PreToolUse` | before a tool runs | **Yes** — a non-zero exit aborts the call (this is the guardrail path) |
| `PostToolUse` | after a tool finishes | No — runs for its side effect |
| `Stop` | when the turn ends | No |

Each rule is `{ "match": "<regex on tool name — omit to match all>", "command": "<shell>", "timeout": 10000 }`. Placeholders are substituted into `command` (shell-escaped): **`{{name}}`** (tool name), **`{{primary}}`** (first arg — path / cmd / pattern / url), **`{{duration}}`** (ms, `PostToolUse` only).

```jsonc
"hooks": {
  // guardrail: refuse edits to a generated file
  "PreToolUse":  [{ "match": "write_file|apply_edit", "command": "grep -q '@generated' {{primary}} && exit 1 || exit 0" }],
  // housekeeping: format after every edit; bump the build number after any tool
  "PostToolUse": [
    { "match": "write_file|apply_edit", "command": "prettier --write {{primary}} || true" },
    { "match": ".*",                    "command": "./scripts/bump-build-number.sh {{name}}" }
  ],
  // notify when a turn ends
  "Stop": [{ "command": "terminal-notifier -message 'Bandit finished' || true" }]
}
```

### Telemetry (opt-in)

Off by default. When enabled, Bandit emits **OpenTelemetry** over OTLP/HTTP: one **trace per turn** (LLM + tool calls as spans, errors marked) plus **usage metrics** (tokens, time-to-first-token, turn duration). The wire format is standard OTLP, so **you point it at your own collector** — Grafana/Tempo, an OpenTelemetry Collector, App Insights, Datadog, anything that speaks OTLP/HTTP.

> **Where does it go?** You decide. Set `endpoint` to your collector. The example below uses `otlp.burtson.ai` — that's **Burtson's** hosted collector and only accepts Bandit Cloud accounts; if you're not a Bandit Cloud user, point `endpoint` at your own and set your own `headers`.

```jsonc
// ~/.bandit/config.json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://otel.your-company.com",   // YOUR OTLP collector (otlp.burtson.ai = Bandit Cloud only)
    "mode": "metrics+traces",                        // or "metrics-only" for stricter privacy
    "headers": { "Authorization": "Bearer ..." }     // your collector's auth (defaults to your Bandit token)
  }
}
```

The default `endpoint` is `https://otlp.burtson.ai` only because the default audience is Bandit Cloud; **set your own** otherwise.

**Privacy:** prompt and completion **text is never sent** — only metadata (model, tool name, durations, token counts), and that metadata is run through secret redaction first. `metrics-only` drops traces entirely. Nothing is sent unless you set `enabled: true` (or `BANDIT_TELEMETRY=1`).

### Remote GPU

Running a bigger model on a remote Ollama instance? Point `OLLAMA_URL` at the remote endpoint and set `BANDIT_MODEL` to the bigger model. Requests route to the remote node; everything else stays local.

#### Rented GPU (RunPod / Vast.ai / Lambda)

When you need to run a model your local hardware can't fit, Bandit talks to any remote Ollama endpoint — including rented GPU pods. Same shape on every provider: spin up a pod with Ollama on port 11434, copy the proxy URL, point `OLLAMA_URL` at it.

**RunPod** (recommended — simplest UX):

```bash
# 1. From the RunPod template gallery, pick any Ollama template.
#    H100 SXM is the right pick for 27-32B models; multi-GPU only
#    needed for 70B+. Network volume optional but useful if you want
#    model weights to persist across pod restarts.

# 2. Once the pod boots, copy its proxy URL from the dashboard.
#    Format: https://<pod-id>-11434.proxy.runpod.net

# 3. SSH into the pod and pull a model:
ollama pull qwen3.6:27b

# 4. Locally, point Bandit at it:
export OLLAMA_URL="https://<pod-id>-11434.proxy.runpod.net"
export BANDIT_MODEL="qwen3.6:27b"
bandit
```

Tear the pod down when you're done. ~$2/hr for an H100 SXM × 15-20 min agent session = under $1.

**Vast.ai / Lambda Labs**: same pattern. Find an Ollama-preloaded image (or `apt install` Ollama yourself), expose port 11434, set `OLLAMA_URL` to the host URL.

**Recommended models for rented GPU:**

| Model | Size | What it's good at |
|---|---|---|
| `qwen3.6:27b` | ~17 GB | Same model as `bandit-logic`. Native tool calling, vision, 256K context. Best general-purpose pick. |
| `qwen2.5-coder:32b` | ~20 GB | Code-specialist post-train. Strongest on file edits and refactors. |
| `qwen3.6:35b` | ~24 GB | Bigger Qwen 3.6 variant — slower, marginally better reasoning. |

**Avoid for agent work:** `gpt-oss:120b` and similar reasoning-tuned models. They're post-trained for OpenAI's harmony tool-call format, not the XML protocol Bandit uses for non-native models — they tend to narrate intent without emitting tool calls. Great for math/proofs in chat, poor for filesystem agent loops.

---

## Security & privacy

- **Local-first by default** — with `provider=ollama`, nothing leaves your machine.
- **Approval gate** — all file writes show a unified diff before touching disk (unless `BANDIT_AUTO_APPROVE=1`).
- **Command allowlist** — `run_command` only executes from an internal allowlist (git, gh, kubectl, helm, brew, standard *nix tools). Arbitrary shell is refused.
- **Pre-tool security guard** (opt-in) — enable `security.guard` in your [settings file](#settings-file--hooks-permissions-security-guard) to block catastrophic commands (`rm -rf /`, `curl … | sh`, disk wipes, credential exfil, writes to `/etc` or `~/.ssh`) before they run. Defense-in-depth against the model, applied in both CLI and IDE.
- **Custom hooks** — your own `PreToolUse` shell scripts can veto any tool call; configure globally (`~/.bandit/settings.json`) or per-project.
- **Secret hygiene** — API keys are redacted in `/config` output and never logged. The optional [telemetry](#telemetry-opt-in) exporter never sends prompt/response text and redacts metadata.
- **Local sessions** — stored as JSONL under `~/.bandit/sessions/`. Inspect at any time.

---

## Requirements

- Node.js 20+
- [Ollama](https://ollama.com) running locally (or remote via `OLLAMA_URL`) — unless you use `BANDIT_PROVIDER=bandit`
- `rg` (ripgrep) on `PATH` for fast code search; falls back to `grep` if absent

---

## Troubleshooting

**Ollama not detected** — Make sure it's running: `ollama serve`. The CLI checks on startup and surfaces a setup hint if it can't connect.

**Model not installed** — Pull it: `ollama pull <model>`. Run `/model <name>` in the REPL to switch without restarting.

**Slow responses** — Check your model size against available VRAM. Switch to a smaller model from the recommended list.

**Stuck approval prompt in CI** — Set `BANDIT_AUTO_APPROVE=1` to skip the diff-approval gate.

---

## Support

- Issues, feature requests, and questions: [team@burtson.ai](mailto:team@burtson.ai)
- More from Burtson Labs: [burtson.ai](https://burtson.ai)

*Bandit CLI is built by [Burtson Labs](https://burtson.ai). Source for the runtime packages is currently private — open source release planned.*
