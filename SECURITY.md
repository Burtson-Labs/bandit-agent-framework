# Security Policy

## Reporting a vulnerability

Email **[team@burtson.ai](mailto:team@burtson.ai)** with details. Please don't open a public GitHub issue for security reports — that's what gets vulnerabilities exploited before there's a fix to ship.

What to include:

- A clear description of the issue and its impact
- Reproduction steps or a minimal proof-of-concept
- The affected package(s) and version(s) (`apps/bandit-stealth/package.json` for the extension, `apps/bandit-cli/package.json` for the CLI)
- Whether you've coordinated with anyone else on disclosure

You should hear back within **72 hours**. We'll work with you on disclosure timing — generally we aim to ship a fix within 14 days for high-severity issues.

## What's in scope

This policy covers:

- The published VS Code extension (`BurtsonLabs.bandit-stealth` on the Marketplace + Open VSX)
- The published CLI (`@burtson-labs/bandit-stealth-cli` on npm)
- All packages under `packages/` that ship as part of those products

## What's out of scope

The following are intentionally out of scope for this policy:

- **Self-hosted infrastructure** — Bandit Cloud (`api.burtson.ai`), AuthApi (`auth.burtson.ai`), the MCP broker, and other Burtson Labs hosted services are separately operated. Vulnerabilities there go through the same `team@burtson.ai` channel.
- **User-installed local models** — if your Ollama setup or local model has a vulnerability, that's an upstream issue. We will, of course, fix Bandit if it exposes a model to attack.
- **Prompt injection** — by design, the agent acts on the contents of files and tool outputs in your workspace. Reading attacker-controlled input that then influences the agent's behavior isn't a vulnerability in Bandit — it's the agent doing its job. *However*, if you find a way to escalate prompt injection into something the user didn't grant consent to (exfiltrating credentials, executing commands without the permission gate firing), that IS in scope.

## Injection containment

Prompt injection can't be prevented, so Bandit is built to keep an injected instruction from turning into an un-consented action. Three boundaries carry that weight. Breaking any of them is in scope for a report.

**The permission config is not agent-writable.** `.bandit/settings.json` and `.bandit/settings.local.json` hold `hooks` (shell commands the host runs on every tool call) and `permissions.allow`; `.vscode/settings.json` holds the auto-approve toggle; `.vscode/tasks.json` can run on folder open. Writing any of them would convert one innocuous-looking "edit a JSON file" approval into unbounded execution afterwards, so the write tools are blocked from all four — including via `apply_patch`, whose targets live inside the patch body. This check is **always on** and is deliberately not tied to `security.guard.enabled`: a protection you can disable by writing the file it protects would be decorative. `.bandit/skills/` stays writable on purpose — skills are prompt text the model can already put in its own context.

**Tool output can't forge its own framing.** Everything the agent learns about the outside world arrives inside a `<tool_result>` envelope. Content that closes that envelope and continues in a fake one is indistinguishable to the model from a trusted frame, so the envelope tags are escaped in tool output before the model sees it.

**The chat panel doesn't fetch remote resources.** An `<img>` in model-authored markdown is a silent outbound GET on render — no click, no prompt — which makes it an exfiltration channel for anything the agent just read. Images are blocked at the markdown renderer, with the sanitizer's tag filter behind it.

**Destructive actions always require an explicit answer.** Tool calls are classified `routine`, `elevated`, or `critical`. Auto mode (`permissions.mode: "auto"`) runs `routine` calls unprompted — reads, in-workspace edits, builds and tests — and nothing else. `critical` calls prompt no matter what: deletes, writes outside the workspace, force-push and history rewrites, global installs and publishes, credential paths, network calls carrying a body, and irreversible operations on connected MCP services. That floor overrides a stored allow rule, so a broad pattern like `run_command:git *` in `settings.json` cannot authorize `git push --force`. The one mode without a floor is `dangerous`, which is named for what it does and is not settable from the CLI's `/auto` command.

**Grants are scoped to what the prompt displayed.** A permission card renders the exact rule each choice would store, and the host stores that string verbatim. Approving `git status` for the session grants `run_command:git status*`, not the whole tool; approving `npx create-vite my-app` grants `run_command:npx create-vite*`, not every `npx` package. Persisted grants on file edits stay path-narrow.

What these do **not** cover, and what we would want to hear about: an injected instruction that gets the user to approve a genuinely harmful action through a legitimate-looking permission card, a `run_command` allow-list entry with more reach than it appears to have (`npm run`, `make`, and `docker` all execute project-controlled code by design), or any path that reaches the filesystem or network without passing the gate.

## Secret redaction

As of v1.7.263 the agent runtime redacts known secret patterns (GitHub PATs, Slack tokens, AWS keys, Anthropic/OpenAI keys, JWTs, PEM private keys, etc.) from tool output before it reaches the model context, the host UI, and the session log on disk. If you find a high-confidence secret pattern we're missing, an issue or PR adding it to [`packages/agent-core/src/security/secretPatterns.ts`](packages/agent-core/src/security/secretPatterns.ts) is welcome — that's a strict-additive change that doesn't need a private channel.
