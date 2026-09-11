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

## Credential storage

Keys the agent holds go to the host's secure store, never to a settings file. In the VS Code extension that's `SecretStorage` (the OS keychain): the Bandit cloud key, the Ollama auth token, the OpenAI-compatible bearer, the STT/TTS keys, and the Tavily key. Four of those were plain `settings.json` strings until the migration in [`apps/bandit-stealth/src/helpers/secretMigration.ts`](apps/bandit-stealth/src/helpers/secretMigration.ts) — a workspace-scoped value lands in a file that gets committed, and a user-scoped value rides Settings Sync in cleartext. The migration runs on every activation and clears any value it finds, so a key restored by a synced profile or a committed workspace file gets lifted out again rather than sitting there.

Two stores are deliberately not the keychain. `~/.bandit/config.json` (mode `0600`) holds the Tavily key so the CLI and the extension share one source of truth, and `.bandit/mcp-servers.json` holds MCP server credentials in the workspace — treat that file as sensitive and keep it out of version control.

## Runtime safety switches

Each of these turns off a protection that is on by default. They exist for cases that genuinely need them — unattended CI, air-gapped endpoints, debugging the guard itself — and every one of them is a supported configuration, not a backdoor. They are listed together here because a control that can be disabled by an environment variable is only as good as the inventory of who can set it: in a shared CI runner or a container image, an inherited variable disables a security control with no signal at the call site.

Activation is inconsistent by accident, so read the "Set to" column carefully. Anything not listed leaves the protection on.

| Variable | Default | Set to | What it turns off |
| --- | --- | --- | --- |
| `BANDIT_PERMISSION_MODE` | `ask` | `plan` \| `ask` \| `auto` \| `dangerous` | Overrides the approval mode. `auto` runs routine calls unprompted but keeps the destructive-action floor; **`dangerous` removes the floor entirely**. An unrecognised value fails closed to `ask`. Takes precedence over both variables below. |
| `BANDIT_DANGEROUSLY_APPROVE_ALL` | off | `1` or `true` | Every approval prompt, **including the destructive-action floor** — deletes, force-push, credential paths, writes outside the workspace. The widest switch here; named for what it does. |
| `BANDIT_AUTO_APPROVE` | off | `1` or `true` | Deprecated alias for the row above, with the same effect. Prefer `BANDIT_PERMISSION_MODE=auto` if what you wanted was auto mode, which still prompts for destructive calls. |
| `BANDIT_NO_SECRET_REDACTION` | off | `1` or `true` | Secret-pattern redaction of tool output and `@file` mentions. Credentials in command output then reach the model context, the host UI, and the session log on disk. |
| `BANDIT_ALLOW_PRIVATE_WEB_FETCH` | off | `1` exactly | The SSRF guard on `web_fetch`: private, loopback and link-local addresses, and the per-redirect re-check. Cloud instance-metadata endpoints become reachable. |
| `BANDIT_DISABLE_POST_EDIT_CHECKS` | off | `1` exactly (not `true`) | The post-edit typecheck, so new type errors introduced by an agent edit are never surfaced. Correctness, not a security boundary. |
| `BANDIT_NO_TOKEN_WATCHDOG_MS` | auto-sized | any integer ≥ 0; **`0` disables** | Pins or disables the no-first-token watchdog. At `0` a hung model or gateway never times out. Overrides both the `/watchdog` command and `~/.bandit/config.json`. |
| `BANDIT_MAX_ITERATIONS` | model-aware (20–40) | any number | Raises or lowers the tool-loop iteration cap. Unbounded and unvalidated — a runaway-loop guard rather than a security control. |

`BANDIT_GRAPH=0` also appears in this shape but is **not** a safety switch — it disables graph decomposition and makes execution more conservative, not less. It is noted here only because its opt-out form (`0`/`false` to disable, anything else leaves it on) is easy to confuse with the rows above.

For the `agent-runner` service the risk runs the other way: its controls are fail-closed, and the exposure is **leaving one unset** rather than setting it. `AGENT_RUNNER_WORKSPACE_ROOT` unset means every turn is refused; a non-loopback `AGENT_RUNNER_HOST` without `AGENT_RUNNER_TOKEN` refuses to start. The one permissive default is `AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS`, which allows any http(s) host until you set it. `AGENT_RUNNER_PERMISSION_MODE=unrestricted` disables the risk-tier check but not the security floor, and `AGENT_RUNNER_LOG_LEVEL=silent` suppresses the audit log. Full table in [`services/agent-runner/README.md`](services/agent-runner/README.md).

If you find a way to set any of these from inside a session — through a settings file the agent can write, a hook, or an MCP server — that is a report we want. The agent is not supposed to be able to widen its own permissions.

## Deployment trust boundary

The services in this repo (`agent-runner`, `agent-orchestrator`, `gateway-api`) assume something authenticates the caller before the request arrives. They execute model-authored commands and file writes, so anything that can reach them can run code in whatever workspace they are configured for. Run them behind an authenticating gateway, or give them their own token auth and bind them somewhere only that gateway can reach — `agent-runner` enforces the second of those itself and refuses to bind a non-loopback interface without a token.

Two things do not substitute for that boundary. Network isolation alone doesn't, because the permission modes and the provider-host allowlist are the only things standing between a caller and arbitrary execution once a request is accepted. And the agent's own permission gate doesn't either — it is a guard against an injected instruction escalating within a session, not an authentication layer. Treat a reachable, unauthenticated runner as equivalent to handing out shell access.
