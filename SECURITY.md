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

## Secret redaction

As of v1.7.263 the agent runtime redacts known secret patterns (GitHub PATs, Slack tokens, AWS keys, Anthropic/OpenAI keys, JWTs, PEM private keys, etc.) from tool output before it reaches the model context, the host UI, and the session log on disk. If you find a high-confidence secret pattern we're missing, an issue or PR adding it to [`packages/agent-core/src/security/secretPatterns.ts`](packages/agent-core/src/security/secretPatterns.ts) is welcome — that's a strict-additive change that doesn't need a private channel.
