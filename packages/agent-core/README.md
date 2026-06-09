<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-core

  **Core reasoning and planning engine for the Bandit Agent Framework.**

  Owns the `ToolUseLoop` — the iteration controller that drives every Bandit agent run, parent or subagent, in both the VS Code extension and the CLI host.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-core
```

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick start

`agent-core` is provider-agnostic — pair it with a provider client (`@burtson-labs/agent-adapters-provider` wraps Ollama, OpenAI-compatible endpoints, and the hosted Bandit gateway) and a host-side tool set (`@burtson-labs/host-kit` ships the extras the CLI and extension use). The minimal shape:

```ts
import { createAgentRuntime } from "@burtson-labs/agent-core";

const runtime = createAgentRuntime({
  providerClient,                    // satisfies ProviderClient
  systemPrompt: "You are a helpful coding agent.",
  tools: [/* built-ins + your own */]
});

const plan = await runtime.plan("Summarize this repo");
const result = await runtime.execute();
const report = await runtime.report();
```

The host wires up streaming + auth on the provider; the loop owns iteration, retry/fallback, compaction, output-budget serialization, and the detector contract.

### Typical pairings

| You need | Add |
|---|---|
| LLM provider (Ollama / OpenAI / cloud) | [`@burtson-labs/agent-adapters-provider`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-provider) |
| Run on Node (shell + filesystem) | [`@burtson-labs/agent-adapters-node`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-node) |
| Run in the browser | [`@burtson-labs/agent-adapters-web`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-web) |
| Run inside a VS Code extension | [`@burtson-labs/agent-adapters-vscode`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-vscode) |
| Run from a GitHub Action | [`@burtson-labs/agent-adapters-github`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-github) |
| Memory / hooks / `@`-mentions / extra tools | [`@burtson-labs/host-kit`](https://www.npmjs.com/package/@burtson-labs/host-kit) |
| Pre-built runtime (CLI + extension parity) | [`@burtson-labs/stealth-core-runtime`](https://www.npmjs.com/package/@burtson-labs/stealth-core-runtime) |
| React UI for plan / chat / diff / telemetry | [`@burtson-labs/agent-ui`](https://www.npmjs.com/package/@burtson-labs/agent-ui) |

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's inside

| Path | Purpose |
|---|---|
| `src/tools/tool-use-loop.ts` | The loop itself. Orchestrates LLM call → response parsing → detector pass → tool execution → repeat. |
| `src/tools/tool-use-parser.ts` | Extracts `<tool_call>` envelopes (XML, fenced, bare-JSON, pythonic fallbacks). |
| `src/tools/tool-registry.ts` | Tool registration + native-schema generation for Ollama's `tools` field. |
| `src/tools/core-tools.ts` | Built-in tools: `read_file`, `apply_edit`, `apply_patch`, `run_command`, `git_*`, etc. |
| `src/tools/compactMessages.ts` | Greedy compaction of stale tool-result messages when the message-token budget bites. |
| `src/tools/post-edit-checks.ts` | Auto type-check after TS/TSX edits. |
| `src/security/secretPatterns.ts` | Secret detection + `redactSecretsString` (used everywhere user/tool text is surfaced). |
| `src/telemetry/otlpExporter.ts` | Opt-in, SDK-less OTLP exporter (`TelemetryExporter`, `resolveTelemetryConfig`). Host-agnostic (Web Crypto + `fetch`); maps a turn to a trace + token/TTFT/duration metrics. Shared by the CLI and IDE host. |

## <img src="https://api.iconify.design/lucide/flask-conical.svg?color=%23a60ee5&width=22" align="absmiddle"> Running tests

```bash
pnpm --filter @burtson-labs/agent-core test
```

The suite is split across **synthetic contract tests** (one file per detector cluster) and **real-trace replay tests** (turn logs from `.bandit/turns/` replayed through a fresh loop):

| Concern | File |
|---|---|
| Constructor options merged into runtime | [test/constructorOptionsContract.test.ts](test/constructorOptionsContract.test.ts) |
| "Claim without doing" detectors (false-completion, partial-completion, announce-then-stall) | [test/claimWithoutDoingDetectors.test.ts](test/claimWithoutDoingDetectors.test.ts) |
| "Structured output instead of tool" detectors (code-fence, JSON-todo auto-promote) | [test/structuredOutputDetectors.test.ts](test/structuredOutputDetectors.test.ts) |
| Loop detectors (prose-loop, todo-churn) | [test/loopDetectors.test.ts](test/loopDetectors.test.ts) |
| Malformed/empty recovery (empty-retry, thinking-off-recovery, parse-retry) | [test/malformedEmptyDetectors.test.ts](test/malformedEmptyDetectors.test.ts) |
| Hallucinated `<tool_result>` recovery | [test/hallucinationDetectors.test.ts](test/hallucinationDetectors.test.ts) |
| Subagent coordination (fired-and-forgotten) | [test/subagentCoordinationDetectors.test.ts](test/subagentCoordinationDetectors.test.ts) |
| Tool execution edge cases (dedup, cap, repeat-breaker, not-found, error, todo-progress) | [test/toolExecutionDetectors.test.ts](test/toolExecutionDetectors.test.ts) |
| Cancellation contract | [test/cancellationContract.test.ts](test/cancellationContract.test.ts) |
| Compaction + goal-anchor contract | [test/compactionContract.test.ts](test/compactionContract.test.ts) |
| Real-trace replay | [test/turnReplay.test.ts](test/turnReplay.test.ts) |

### Adding a regression fixture from a real failure trace

When you see a weird agent behavior in a real run, drop the turn-log fixture into the test suite so a future loop change can't silently regress it. **See [test/fixtures/turns/README.md](test/fixtures/turns/README.md)** for the full guide — replay-completeness limits, naming conventions, what to assert, and a copy-paste test template.

## <img src="https://api.iconify.design/lucide/book-open.svg?color=%23a60ee5&width=22" align="absmiddle"> Conventions

- **Every detector is one-shot per turn.** Each `tool_loop:*_nudge` event fires at most once before the loop terminates or the model recovers. Adding a new detector means adding the gate flag + a contract test.
- **Constructor options must flow through to runtime.** `ToolUseLoopOptions` set at construction time apply to every `runWithMessages` call. The merge happens in `runWithMessages` — see `effectiveOptions = { ...defaultOptions, ...perCall }`. New options need a corresponding entry in [test/constructorOptionsContract.test.ts](test/constructorOptionsContract.test.ts) (the file's exhaustiveness check fails build if you forget).
- **Helpers go in `test/_helpers.ts`; the replay harness in `test/_replay.ts`.** Both file names start with `_` so they're excluded from vitest's `test/**/*.test.ts` glob.

## <img src="https://api.iconify.design/lucide/network.svg?color=%23a60ee5&width=22" align="absmiddle"> Position in the framework

```
[host: VS Code extension or CLI]
              │
              ▼
       ┌──────────────┐
       │ ToolUseLoop  │  ← this package
       └──────┬───────┘
              │
        ┌─────┴─────┐
        ▼           ▼
 [tool registry]   [chat function]
        │              │
        ▼              ▼
  [host-kit tools]   [Ollama / Bandit cloud / etc.]
```

The loop is host-agnostic. Hosts wire up the chat function (with their own watchdogs / streaming / auth) and supply a tool registry; the loop owns iteration, retry/fallback policy, compaction, output-budget serialization, and the detector contract.

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
