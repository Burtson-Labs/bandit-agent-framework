# @burtson-labs/agent-runner

The service Bandit's commercial gateway delegates cloud turns to — and,
deliberately, nothing more than **another host of the framework**: a
`ToolExecutionContext` rooted at a prepared workspace, a provider, and the
same `ToolUseLoop` the CLI and IDE run.

Decided in the runtime-unification ADR (Option A): the gateway keeps auth,
credits, tasks and GitHub; this runner executes turns. The seam is
`src/contract.ts` — versioned, task-in / NDJSON-events-out, and nothing
else crosses in either direction.

```
POST /v1/turns    TurnRequest → NDJSON RunnerEvent stream
GET  /healthz     { ok, protocol }
```

Stream rule the gateway relies on: `turn.completed` / `turn.error` is
always the final line; a stream that ends without one is a failed turn,
never a completed one. Completing with zero artifacts requires a
`noChangeReason` a human can read.

`pnpm test` runs the service's suite: auth, the workspace jail (`..`,
absolute and symlink escapes), the request body cap, correlation ids,
cancellation, the permission gate, and the stream-termination rule.
`pnpm build && pnpm smoke` additionally proves the seam end-to-end with the
scripted provider — full event grammar, jailing (including the macOS /var
symlink case), protocol negotiation — no model attached.

## Deployment & trust boundary

**This service executes model-authored file writes and commands inside the
workspace you give it. Treat it as the most privileged thing you run, and
never put it on a network where anything unauthenticated can reach it.**

The runner deliberately owns none of the concerns a product needs: no
users, no credits, no repository access, no task bookkeeping. Those belong
to the component in front of it. That split is what keeps the seam small —
and it means the runner is **half a system**: deploying it alone, reachable,
is a misconfiguration, not a deployment.

Two supported postures, and the service refuses to start outside them:

1. **Behind an authenticating gateway.** Something in front authenticates
   the caller, decides they may run a turn, prepares the workspace, and
   proxies to the runner over a private network. Set `AGENT_RUNNER_TOKEN`
   anyway — defence in depth costs one environment variable.
2. **Standalone with its own token.** Set `AGENT_RUNNER_TOKEN` and every
   request except `GET /healthz` must present
   `Authorization: Bearer <token>` (compared in constant time). Unknown
   routes are authenticated too, so the surface does not leak.

With no token configured the runner is a development instance: it binds
loopback only, and asking it to bind anything else is a startup error, not
a warning. There is no mode in which an unauthenticated runner listens on
a routable address.

What the runner enforces on its own, regardless of what is in front:

| Control | Behaviour |
| --- | --- |
| Workspace jail | `workspacePath` must resolve inside `AGENT_RUNNER_WORKSPACE_ROOT` both lexically and after `realpath`. No root configured = every turn is refused. |
| Provider egress | `provider.baseUrl` must be http(s), and must match `AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS` when that is set. |
| Tool policy | Every tool call passes the permission gate; a security floor (destructive commands, credential paths, writes outside the workspace) applies in every mode. |
| Request size | Bodies over the cap are refused with `413` and the connection is torn down rather than buffered. |
| Cancellation | A caller that disconnects aborts the turn — the loop stops and no further tool call executes. |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8790` | Listen port. |
| `AGENT_RUNNER_HOST` | `0.0.0.0` with a token, `127.0.0.1` without | Interface to bind. A non-loopback value without a token refuses to start. |
| `AGENT_RUNNER_TOKEN` | unset | Bearer token required on every endpoint except `/healthz`. Unset = loopback-only dev mode. |
| `AGENT_RUNNER_WORKSPACE_ROOT` | unset | Containment root every `workspacePath` must resolve inside. **Required** — without it every turn is refused. |
| `AGENT_RUNNER_ALLOWED_PROVIDER_HOSTS` | unset (any http(s) host) | Comma-separated provider allowlist. Entries match the hostname, or `host:port` when they contain a colon. |
| `AGENT_RUNNER_PERMISSION_MODE` | `standard` | `standard` (deny the critical risk tier), `read-only` (reads and searches only), `unrestricted` (tier checks off — isolated sandboxes only; the security floor still applies). |
| `AGENT_RUNNER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`. |
| `AGENT_RUNNER_MAX_BODY_BYTES` | `1000000` | Largest request body buffered before a `413`. |
| `RUNNER_GRAPH` | enabled | Set `0` to disable graph decomposition and run every turn as a plain loop. |

### Logs and correlation

Every line is a single JSON object: `ts`, `level`, `requestId`, `event`,
then situational fields. Each request carries a correlation id — the
caller's `X-Request-Id` when it is well-formed, a generated one otherwise —
which is echoed on the response (including errors) and stamped on every log
line that request produces. Liveness probes log at `debug`.

### Container

The published image runs as uid 1000, not root, and ships `/workspaces`
owned by that uid as the conventional mount point for
`AGENT_RUNNER_WORKSPACE_ROOT`. A workspace mounted from elsewhere must be
owned by the same uid — both for write access and because `git` refuses
repositories owned by another user.

Recommended orchestrator settings, all of which the image already
satisfies: run as non-root, disallow privilege escalation, drop all
capabilities, read-only root filesystem with a writable volume at the
workspace root, and a network policy that admits traffic only from the
component in front and permits egress only to the configured provider
hosts.

Next increments, in order: gateway delegation behind a flag in
StealthRuntimeService, per-turn sandboxing.
