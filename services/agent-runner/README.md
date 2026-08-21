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

`pnpm build && pnpm smoke` proves the seam with the scripted provider —
full event grammar, workspace jailing (including the macOS /var symlink
case), and protocol negotiation — no model attached.

Next increments, in order: ollama + openai-compat providers (contract
already accepts them), gateway delegation behind a flag in
StealthRuntimeService, per-turn sandboxing.
