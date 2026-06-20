# Bandit Stealth

**A real coding agent inside your IDE — without the subscription.** Runs locally on your own GPU for free, or on our cloud when you need more horsepower.

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Marketplace-install-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=BurtsonLabs.bandit-stealth)
[![Open VSX](https://img.shields.io/open-vsx/v/BurtsonLabs/bandit-stealth?label=Open%20VSX&color=a60ee5)](https://open-vsx.org/extension/BurtsonLabs/bandit-stealth)
[![CLI on npm](https://img.shields.io/npm/v/%40burtson-labs%2Fbandit-stealth-cli?label=CLI%20on%20npm&logo=npm&color=cb3837)](https://www.npmjs.com/package/@burtson-labs/bandit-stealth-cli)
![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)

---

Bandit reads your codebase, writes changes, runs commands, and stays out of your way. Local-first by default on any Ollama model — your code never leaves your machine. Optional Bandit cloud when you want managed inference with zero local setup.

- **Your choice of model.** Runs locally on any Ollama model — Gemma 4, Qwen 3.6, Devstral, your custom fine-tune. Or point at Bandit's hosted gateway for managed inference with thinking mode and zero local setup.
- **Works alongside you.** Bandit autonomously explores your code, reads and writes files, runs shell commands — every write gated by a unified-diff approval so you're never surprised.
- **Integrated with the editor.** Auto-context attaches the right files without you picking them. `@`-mention any file (or folder — drill in until you find it). Inline diffs stream into the editor as the agent works.
- **Powerful agentic features.** Skills the agent can author itself, plan preview with go/no-go confirmation, session checkpoints with `/rewind`, hooks for CI guardrails, and a tool-use loop with pre-write language validation (TypeScript / Python / JSON / C#).
- **Voice that's actually pluggable.** Speech-to-text and text-to-speech are independent of the chat provider. Use Bandit cloud, OpenAI-compatible Whisper (faster-whisper-server / whisper.cpp HTTP / OpenAI / LiteLLM), ElevenLabs, a local Piper server, or any custom URL. Run Ollama locally for chat + a self-hosted Whisper for voice and never touch a cloud account.
- **Type a message while Bandit is replying.** The composer keeps accepting input while the agent streams — your follow-up shows as a "queued" pill and fires automatically when the current turn finishes. The Stop button next to the spinner cancels the active turn AND clears your queue.
- **`!` runs straight in your integrated terminal.** Type `!npx create-vite my-app` in the composer and the next Enter opens VS Code's integrated terminal and runs the command there with full TTY (so interactive scaffolders work). The agent doesn't see the output; this is a user-invoked escape hatch with the same blocked-pattern guards as the safe path (`rm -rf`, `mkfs`, `dd if=` always refused). A yellow SHELL MODE banner appears in the composer the moment you type `!` so you can't miss the mode change.
- **Cross-repo discovery built in.** Ask the agent to "open the auth-api repo" or "edit the stt-api Dockerfile" and it locates the repo via `find_directory` — sweeps `~/Documents/GitHub`, `~/GitHub`, `~/Projects`, `~/code`, `~/dev`, `~/repos`, `~/work`, `~/src`, plus the parent of the active workspace. No more "where is that repo?" round-trips.
- **Installs CLIs and packages on demand.** When you ask Bandit to install `ripgrep`, `httpie`, the GitHub CLI, etc., it picks the right package manager (`brew`, `npm install -g`, `pip install`, `cargo install`, `gem install`, `go install`) and runs it through the permission gate — you approve, it installs.
- **Twelve themes.** Stealth Light / Stealth Dark / Midnight (defaults) plus Onyx, Charcoal, Dracula, Nord, Tokyo Night, Solarized Dark, Catppuccin Mocha, Solarized Light, and Sepia. Auto-mirror VS Code's light/dark or pick a Bandit theme to override.

## New to Bandit?

Visit [burtson.ai/stealth](https://burtson.ai/stealth) for the product tour, model comparison, and recommended configurations.

## Prefer the terminal?

Same runtime, same skills, same tool-use loop — in a shell instead of the IDE.

```bash
npm install -g bandit-stealth-cli
bandit
```

Flip `banditStealth.useTerminal` on and the Activity Bar icon (and `Alt+Shift+B`) will open the CLI in VS Code's integrated terminal instead of the chat panel. Toggle back any time via `Bandit Stealth: Toggle Terminal Mode`.

See [`@burtson-labs/bandit-stealth-cli`](https://www.npmjs.com/package/@burtson-labs/bandit-stealth-cli) on npm — a public package today, open source soon. Node.js 20+, works against the same local and cloud providers as the extension.

---

## Independent, opinionated, and honest about it

Bandit Stealth is built by Burtson Labs — a small independent shop, not a venture-funded research lab. The goal is simple: make agentic coding tools that work well without gating them behind enterprise pricing.

**The deal:**

- **Local is free, forever.** Point Bandit at Ollama and you never owe us a dollar. No account, no network calls on your code — and telemetry is **off by default** (opt-in, see below).
- **Cloud is optional.** If you'd rather skip the local setup, the hosted gateway runs tuned models with thinking mode ready to go. Rolling-window limits and transparent usage in the Account tab.
- **The roadmap is public.** Every release note and open rough edge lives in the repo. File an issue and you're talking to the people writing the code.

---

## Quick start

1. **Install a model** (local-first default). Two commands on a Mac:

   ```bash
   brew install ollama
   ollama pull gemma4:26b         # best balance for 32 GB+ Macs
   ```

2. **Install this extension** — you're already here.

3. Open the **Bandit Stealth** view from the Activity Bar. Start typing.

That's it. No API keys, no cloud services, and telemetry off by default. Prefer managed inference instead? Switch the provider to `bandit` in settings and paste an API key.

<details>
<summary><sub>See a quick session in action</sub></summary>

<br/>

<table>
<tr>
<td width="40%" align="center" valign="middle">
  <img src="https://cdn.burtson.ai/images/ide-demo.gif" alt="Bandit Stealth panel in VS Code — the agent reads and searches across the repo, then proposes edits behind an approval gate" width="340" />
</td>
<td valign="middle">
<b>A real session, sped up 6×.</b>
<br/><br/>
Bandit runs the whole agent loop right in the side panel — listing and reading files, searching the codebase, and planning its approach — with every tool call streaming live so you see exactly what it's doing. Edits land behind a diff you approve.
<br/><br/>
<sub>~33 seconds · captured in VS Code · recording unedited</sub>
</td>
</tr>
</table>

</details>

---

## Recommended models

Bandit auto-detects each model's capabilities and picks the right execution path (native tool calling vs. text-parse). Any Ollama model works — the table below is our tested shortlist, ordered by what we've actually validated on real codebases.

| Model | Where | Notes |
|---|---|---|
| `bandit-logic` (cloud) | Bandit gateway (API key) | **Default.** Agent-tuned wrapper around Qwen 3.6 27B with thinking mode. Strongest cloud pick for tool-use loops — what we recommend trying first. |
| `qwen3.6:27b` | Local / high-VRAM GPU or Mac 48 GB+ (~17 GB) | **Best local pick.** Same family as `bandit-logic`, runs offline. Native tool calling, 256 K context, multimodal. Probes the filesystem first instead of asking for clarification — real agent behavior. |
| `gemma4:26b` | Local / Mac 32 GB+ (~17 GB) | Solid alternative. Fast, multimodal, 128 K context. Good default when Qwen 3.6 is too heavy for your hardware. |
| `gemma4:e4b` | Local / laptop-class (~3 GB) | Lightweight pick that punches above its weight. Validated on real Bandit runs — clean tool sequencing (`ls` → narrow → `read_file`), no hallucinated paths. Right choice when you want a local agent that doesn't pin your fans. |
| `gemma4:31b` | Local / Mac 64 GB+ or GPU node | Bigger context, sharper reasoning for complex refactors. |
| `devstral:latest` | Local / Mac 32 GB+ | Mistral's agent-tuned model — strong tool use. |
| `bandit-core:12b-it-qat` | Local / Mac (~9 GB) | Our Gemma-12B fine-tune. Fits most laptops, agent-aware. |
| `bandit-core-1` (cloud) | Bandit gateway (API key) | Lightweight cloud option. Faster first-token than `bandit-logic`, but less reliable on multi-step agent tasks. |

### Models we don't recommend (for agent work)

Bandit is an autonomous agent harness — it expects the model to discover repo structure, plan edits, and emit tool calls without being hand-held. Some otherwise-impressive models aren't trained for that workflow and produce unexpected results:

- **`gpt-oss:120b` and other reasoning-tuned models** — post-trained for OpenAI's harmony tool-call format, not the XML/native protocols Bandit uses. Tends to narrate intent ("I'll search for the controllers...") without ever emitting an actual tool call. Great for math/reasoning Q&A in chat; poor for filesystem agent loops.
- **`qwen2.5-coder:32b` and other code-completion-tuned models** — post-trained for "given context, write code" benchmarks. On ambiguous prompts it asks the user for paths instead of probing the workspace itself. Solid pick if you give it concrete, fully-specified tasks; underwhelming as an autonomous agent.
- **`qwen3.6:35b`** — the larger Qwen 3.6 variant stalls in reasoning-only output and ignores the harness's "act now" nudges. The 27B is the better production pick from this family.

If you want to test models outside the recommended list, expect the harness's reasoning-only / narrate-but-no-action / partial-completion detectors to fire frequently. Those are signal, not noise — they mean the model isn't a great fit for autonomous agent work.

---

## Live UX touches

Small affordances we ship in both the CLI and the side-panel composer:

- **`?` shortcuts overlay (CLI).** Type `?` at an empty prompt and a keyboard cheatsheet pops above the input — input triggers, hotkey chords, common slash commands. Backspace it and it's gone. Live, no scrollback noise.
- **`!`-prefix shell escape.** Type `!cmd` to run something straight in the shell:
  - **CLI** — first use shows a full warning + y/N gate; every call after gets a yellow box reminding you the command bypasses the agent's allow-list and approval gate.
  - **Extension** — typing `!` lights up a yellow SHELL MODE banner above the composer with the field border tinted amber. Submitting opens the integrated terminal (`Bandit · shell`) and runs the command there with full TTY access — exactly what `create-vite`, `ng new`, or any other interactive scaffolder needs.
- **Queue while streaming.** Both the CLI and the side-panel composer accept new prompts while the agent is mid-turn. The CLI status bar shows `queued: N · Esc to stop`; the composer shows a `N queued · sends after this turn` pill below the textarea. Stop the active turn (Esc in CLI, Stop button in composer) and the queue clears with it.
- **Live command output.** `npm install`, `pip install`, `cargo build`, `watch_command npm run dev` — anything that takes more than a few seconds streams its output to your terminal as it arrives, dimmed, while the spinner keeps animating. No more wondering if a 20-second `npm install` is hung.
- **Notifications when attention is needed.** The extension surfaces VS Code notifications when the panel is hidden and Bandit needs approval, when a background task finishes or fails, when a turn fails, and when a long turn completes. Configure with `banditStealth.notifications.enabled` and `banditStealth.notifications.minTurnMs`.
- **`/doctor` setup check.** The CLI and IDE both render a no-model-call diagnostic of workspace, git state, project memory, provider/API key or Ollama model visibility, active model profile, watchdog setting, and next best actions. It is the first stop when Bandit feels confusing.
- **Retry and fallback for model stalls.** Both hosts tag no-token stalls as watchdog errors, retry text-tool calls when replay is safe, and degrade native tool calls to Bandit's text protocol when a model/gateway parser flakes. The extension uses the same first-token watchdog sizing as the CLI; tune it with `banditStealth.watchdogMs` or `BANDIT_NO_TOKEN_WATCHDOG_MS`.
- **`/insights` report.** A self-contained HTML report — cross-repo win synthesis, rolling activity, tool-usage stats, languages touched, longest streak, peak day, top errors, optional AI-generated *"what you shipped"* / *"where Bandit got in your way"* summary. Built from your global sessions plus workspace/global turn logs; nothing leaves your machine unless you ship the HTML yourself or click the **Share** mailto button.
- **`/trace` and `/profile`.** The IDE and CLI share the same debugging data. In the IDE, the Trace Logs toolbar button, Command Palette command, or `/trace` opens a turn browser with all/needs-attention filters, workspace/global source labels, prompt/final previews, metrics, permission/retry/fallback counts, a timeline, and an Open JSONL action. The CLI keeps the markdown view: `/trace list` browses recent workspace/global turns and `/trace failed` filters recovery/debugging runs. `/profile` explains the active model's behavior profile — native vs text tools, fallback policy, safe context budget, thinking default, parallelism, and known failure modes.

Custom model behavior overrides use the same workspace file in both hosts: `.bandit/model-profiles.json`. Set `match` prefixes plus protocol, context, prompting, and reliability fields when a local model needs a different harness path than the built-in defaults; the extension watches the file and reloads it when it changes. The loop uses those profile values for native-vs-text selection, native fallback policy, output-budget serialization, and max parallel tool calls.

## MCP — Model Context Protocol, both directions

Bandit speaks MCP as both a **client** and a **server**. Any MCP server you can spawn plugs into the same tool-use loop the IDE uses for `read_file` / `apply_edit`. Conversely, any MCP-speaking client (Claude Desktop, Cursor, Cline, Continue, etc.) can drive Bandit's native tools through the standard JSON-RPC envelope.

**As a client** — Configure at `~/.bandit/mcp-servers.json` (global) or `.bandit/mcp-servers.json` (workspace, takes precedence). Each server's tools surface as `<server>.<tool>` so collisions with native tools are impossible. Standard MCP schema — copy a working config from any other MCP-speaking client and paste it in:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

**Connector wizards** — Settings → **Connections** has one-click setup for GitHub, Slack, GitLab, and a generic "+ Custom" path that takes a name + raw command line + env block. Each writes a fully-formed config to `mcp-servers.json` and pre-trusts the fingerprint so first-spawn doesn't double-prompt. CLI parity via `/mcp add github <token>`, `/mcp add slack <bot-token> <team-id>`, `/mcp add gitlab <token>`, `/mcp add custom <name> <cmd…>`.

**Activation modes** — every server can be set to `always` (registers on every prompt — current default) or `on-mention` (only registers when the user's prompt mentions the server name or a trigger keyword). Lets you wire up 5+ MCP servers without paying for 30+ tool definitions in every prompt budget. Auto-derived triggers for well-known providers (slack, github, gmail, gdrive, calendar, outlook, postgres, mongo, filesystem, …); explicit `triggers: [...]` in the config layers on top.

**Trust gate** — first spawn of any server requires user approval (Allow once / Always allow / Deny). "Always" persists a fingerprint of the command + args to `~/.bandit/mcp-trust.json`; revoke from Settings → Connections or `/mcp revoke <name>`.

**As a server** — `bandit mcp serve` (CLI subcommand) turns Bandit into an MCP server that exposes its native tool surface (read_file / write_file / apply_edit / replace_range / list_files / ls / search_code / find_directory / run_command / …) over stdio. Drop one entry into Claude Desktop / Cursor / Cline / Continue's `mcpServers` config and that client can drive Bandit's tools through the same JSON-RPC envelope it uses for every other server. `--read-only` strips write/exec tools so a client gets a view-only window into your codebase.

Servers spawn lazily on first invocation. A failed server logs its error and the rest of the agent loop keeps running on native tools only. Off by default — no config file means no behavior change.

---

## Voice — pluggable providers, independent of chat

Speech-to-text and text-to-speech are configured separately from the chat provider. Run Ollama locally for chat and pair it with whichever voice setup matches your privacy / cost / latency preference. The Bandit-API-key gate only fires when you've actually picked Bandit cloud as your voice provider — local-only setups (Ollama chat + self-hosted Whisper + Piper TTS) work without a cloud account.

Open **Settings → Voice** to configure:

**Speech-to-text providers**
- **Bandit cloud** — `/api/stealth/stt/transcribe`. Needs a Bandit API key.
- **OpenAI-compatible Whisper** — works with OpenAI's `/v1/audio/transcriptions`, faster-whisper-server, whisper.cpp HTTP, LiteLLM, vLLM-Whisper. Bring any URL with the standard multipart `file` + `model` shape.
- **Custom URL** — any endpoint that takes multipart audio in and returns JSON `{ text }`.

**Text-to-speech providers**
- **Bandit cloud** — Brian voice through the Bandit gateway.
- **OpenAI** — `/v1/audio/speech` with `tts-1` / `tts-1-hd`. Works with OpenAI itself, LiteLLM, any compatible proxy.
- **ElevenLabs** — `/v1/text-to-speech/{voice}` with `xi-api-key` auth.
- **Piper** — local Piper HTTP server (POST text/plain or JSON). Zero-cost, fully offline.
- **Custom URL** — any endpoint that takes `{ text, voice }` and returns audio bytes (or JSON `{ audio: <base64>, mimeType }`).

| Setting | Default | Description |
|---|---|---|
| `banditStealth.voice.autoSpeak` | `false` | Auto-narrate short assistant responses (>120 words are skipped). |
| `banditStealth.voice.maxAutoSpeakWords` | `120` | Word-count cap for auto-speak. |
| `banditStealth.voice.micEnabled` | `false` | Show the mic button in the composer for voice prompts. |
| `banditStealth.voice.stt.provider` | `bandit` | `bandit` / `openai-whisper` / `custom`. |
| `banditStealth.voice.tts.provider` | `bandit` | `bandit` / `openai` / `elevenlabs` / `piper` / `custom`. |
| `banditStealth.voice.stt.url` / `tts.url` | — | Endpoint URL when the provider isn't `bandit`. |
| `banditStealth.voice.stt.apiKey` / `tts.apiKey` | — | Bearer / API key for the chosen provider. |
| `banditStealth.voice.stt.model` / `tts.model` | `whisper-1` / `tts-1` | Model name for OpenAI-compatible providers. |
| `banditStealth.voice.voiceId` | `en_US-brian-premium` | Voice identifier (Bandit voice id, OpenAI voice name, ElevenLabs voice id). |

Code blocks, tool calls, and diff cards are automatically stripped from spoken text — Bandit reads the model's prose, never the code. A speaker icon on every assistant message plays on demand regardless of the auto-speak setting.

---

## Account & Usage (cloud only)

Open **Settings → Account → View usage** to see what you're burning. Two rolling windows, Claude-style:

- **5-hour session** — resets on a rolling clock from your first request
- **7-day weekly** — longer-horizon cap for steady use

Limits by plan: Free 100 / 500 · Pro 500 / 5,000 · Team 2,000 / 20,000. Hit the ceiling and you'll get a rate-limit toast with a "View usage" deep link and a countdown to the next reset. Need more headroom? Email [team@burtson.ai](mailto:team@burtson.ai).

The CLI exposes the same breakdown via `/usage` with colored meters.

---

## CLI slash commands (quick reference)

Install once with `npm install -g bandit-stealth-cli`, then run `bandit` in any project. Type `?` at the prompt for the live overlay; `/help` for the full list.

| Command | What it does |
|---|---|
| `/doctor` | Check setup, provider, workspace context, permissions, active profile, and next best actions. |
| `/plan <goal>` | Heuristic plan for the goal, then **y/N to run it** — queues the goal for the tool loop. |
| `/plan-preview on` | Every prompt gets a plan preview + y/N before the model runs. |
| `/insights` | Generate a self-contained HTML report — cross-repo wins, activity, tool stats, top-touched files, languages, streak, peak day, errors, optional AI summary, mailto share. |
| `/trace`, `/trace list`, `/trace failed`, `/trace <id>` | Inspect turn traces from workspace/global `.bandit/turns`; in the IDE this opens the Trace Logs viewer. |
| `/usage` | Cloud session + weekly breakdown with reset countdowns. |
| `/model [name]` | Show or switch the active model (Ollama list ranked by current match). |
| `/provider <ollama\|bandit>` | Hot-swap providers without restarting. |
| `/rewind [id]` | Restore a file from a checkpoint — `/rewind last` is the common shortcut. |
| `/think on \| off \| auto` | Force chain-of-thought mode for reasoning-capable models this session. |
| `/profile [model]` | Show the model behavior profile that governs tool protocol, fallback, context budget, and reliability guardrails. |
| `/compact` | Collapse older tool results to keep the context window happy. |
| `/session list`, `/session resume <id>` | Multi-session memory — every conversation is persisted to `~/.bandit/sessions/`. |
| `/ollama [url]` | Show or set the Ollama endpoint — `/ollama default` resets to `http://localhost:11434`. |
| `/mcp`, `/mcp tools <name>`, `/mcp add github <token>`, `/mcp activation <name> <mode>`, `/mcp revoke <name>` | Full MCP management surface — list, add, configure, trust, drive any MCP server. |
| `/theme` | Pick a color palette — 12 shipped: Stealth Light/Dark, Midnight, Onyx, Charcoal, Dracula, Nord, Tokyo Night, Solarized Dark/Light, Catppuccin Mocha, Sepia. |
| `/init`, `/commit`, `/review`, `/refactor`, `/test`, `/explain`, `/onboard`, `/changelog` | Skill-driven assistants — repo bootstrap, conventional commits, code review, refactor suggestions, test gen, explain-this-code, onboarding checklists, changelog drafts. |

While the agent is mid-turn: **Esc** stops the run and clears the queue. Typing a follow-up + Enter pushes it onto the queue (`queued: N` in the status row); the agent picks it up automatically when the current turn finishes.

---

## Configuration

Open VS Code Settings and search **Bandit Stealth**:

| Setting | Default | Description |
|---|---|---|
| `banditStealth.provider` | `ollama` | `ollama` (local) or `bandit` (cloud) |
| `banditStealth.ollamaModel` | `gemma3:12b` | Any Ollama model ID |
| `banditStealth.ollamaBaseUrl` | `http://localhost:11434` | Ollama endpoint. **One-click reset:** Settings → Providers → Ollama Endpoint has a "Use default" button that flips it back to `http://localhost:11434`. |
| `banditStealth.thinkingMode` | `auto` | Chain-of-thought override (auto / on / off) |
| `banditStealth.watchdogMs` | `-1` | No-token watchdog override in ms (`-1` auto, `0` off, positive value pins the timeout). `BANDIT_NO_TOKEN_WATCHDOG_MS` still wins. |
| `banditStealth.enableToolUse` | `true` | Agentic tool-use loop |
| `banditStealth.voice.*` | — | See **Voice** section above |

### Security guard & hooks

Beyond the per-write approval gate, you can lock down what the agent is allowed to do via a **settings file** — read from `~/.bandit/settings.json` (global, every workspace) and `<workspace>/.bandit/settings.json` (per-project), merged.

```jsonc
{
  // Opt-in built-in guard (off by default). Blocks catastrophic tool calls
  // BEFORE they run — rm -rf /, curl … | sh, disk wipes, fork bombs, writes
  // to /etc or ~/.ssh, credential exfil. Defense-in-depth against the model.
  "security": { "guard": { "enabled": true } },

  // Your own shell commands at loop checkpoints — NOT just guardrails. PreToolUse
  // can block (non-zero exit aborts the call); PostToolUse / Stop are fire-and-
  // forget for formatters, version bumps, notifications, CI, etc.
  // Placeholders: {{name}}, {{primary}}, {{duration}} (PostToolUse only).
  "hooks": {
    "PreToolUse":  [{ "match": "write_file", "command": "./scripts/guard.sh {{name}}" }],
    "PostToolUse": [{ "match": "write_file|apply_edit", "command": "prettier --write {{primary}} || true" }],
    "Stop":        [{ "command": "terminal-notifier -message 'Bandit finished' || true" }]
  },

  // Per-tool permission policy.
  "permissions": { "deny": ["run_command:rm *"], "ask": ["run_command"] }
}
```

Same format and behavior as the [CLI](../bandit-cli/README.md#settings-file--hooks-permissions-security-guard) — settings written once apply to both the IDE and the terminal.

### Telemetry (opt-in, off by default)

Bandit is **telemetry-capable but ships with it off**. Nothing is sent unless you turn it on. When you do, it emits OpenTelemetry — a trace per turn plus usage metrics (tokens, time-to-first-token, turn duration) — over standard OTLP/HTTP. **Prompt and response text are never sent**; only metadata, run through secret redaction.

- **Bandit Cloud users** can flip it on to see their usage in Bandit's hosted dashboards — it ships to `otlp.burtson.ai` authenticated with your Bandit account.
- **Everyone else** can point it at their own OTLP collector (Grafana/Tempo, an OTel Collector, App Insights, …).

Enable it in `~/.bandit/config.json` (shared with the CLI):

```jsonc
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://otlp.burtson.ai",   // Bandit Cloud — or YOUR collector
    "mode": "metrics+traces"                   // or "metrics-only"
  }
}
```

See the [CLI telemetry docs](../bandit-cli/README.md#telemetry-opt-in) for the full reference.

### Remote GPU

Running a bigger model on a remote Ollama instance? Set `banditStealth.ollamaNodeUrl` to the remote endpoint and `banditStealth.ollamaModel` to your larger model. Requests route to the remote node; everything else stays local.

#### Rented GPU (RunPod / Vast.ai / Lambda)

When you want to run a model your local hardware can't fit — or just want H100-class throughput for a session — Bandit talks to any Ollama endpoint, including rented GPU pods. The setup is the same shape on every provider: spin up a pod with Ollama running on port 11434, copy the proxy URL, paste it into Bandit.

**RunPod** (recommended — simplest UX):
1. From the RunPod template gallery, pick any Ollama template (search "ollama"). Choose your GPU (H100 SXM for 27-32B models; multi-GPU only needed for 70B+).
2. Once the pod boots, copy the public proxy URL — RunPod exposes it as `https://<pod-id>-11434.proxy.runpod.net`.
3. In VS Code: set `banditStealth.ollamaBaseUrl` to that URL and switch the model dropdown to whichever tag you'll pull.
4. SSH into the pod and pull the model: `ollama pull qwen3.6:27b` (or whichever tag matches what you set in step 3).
5. Use Bandit normally. Tool calls, edits, voice — everything works against the remote endpoint.

**Vast.ai / Lambda Labs**: same pattern. Look for an Ollama-preloaded image, expose port 11434, set `banditStealth.ollamaBaseUrl` to the host's public URL.

**Recommended models for rented GPU:**
- `qwen3.6:27b` (~17 GB) — same model as `bandit-logic`. Native tool calling, vision, 256K context. Best general-purpose pick.
- `qwen2.5-coder:32b` (~20 GB) — code-specialist post-train, strongest on file edits and refactors.
- Avoid `gpt-oss:120b` for agent loops — it's a reasoning model post-trained for OpenAI's harmony tool-call format and doesn't follow Bandit's text protocol reliably. Great for math/proofs, poor for tool use.

**Cost note:** rented H100s run ~$2/hr. A typical agent session burns 10-20 minutes — under $1. Tear the pod down when you're done; the model weights persist in network storage if you keep that around.

---

## Requirements

- VS Code 1.75+ or Cursor 0.40+
- [Ollama](https://ollama.com) running locally or remotely (unless you use the Bandit cloud provider)
- Python 3 on `PATH` (used by a few agent helpers)

---

## Troubleshooting

**Ollama not detected** — make sure it's running: `ollama serve`. The extension checks on startup and shows a setup guide if it can't connect.

**Model not installed** — the extension detects missing models and offers to pull them automatically.

**Slow first token on Qwen 3.6** — thinking mode is on by default for reasoning-capable models. It's where the agent decides what tool to call, so leave it on for multi-step work. Turn it off (`banditStealth.thinkingMode: off`) when you only need fast Q&A.

**Response feels incomplete** — if an agent stops mid-plan, check the session log at `.bandit/turns/<timestamp>.jsonl`. Every tool call, tool result, and LLM message is recorded so you can see exactly where it stopped.

---

## Docs & Support

- Product page: [burtson.ai/stealth](https://burtson.ai/stealth)
- Issues, feature requests, and questions: [team@burtson.ai](mailto:team@burtson.ai)
- More from Burtson Labs: [burtson.ai](https://burtson.ai)

*Bandit Stealth is built by [Burtson Labs](https://burtson.ai) and released under the [Apache License 2.0](https://github.com/Burtson-Labs/bandit-agent-framework/blob/main/LICENSE). The terminal CLI and the monorepo source live at [github.com/Burtson-Labs/bandit-agent-framework](https://github.com/Burtson-Labs/bandit-agent-framework).*
