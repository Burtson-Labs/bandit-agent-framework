<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/stealth-core-runtime

  **Host-agnostic agent runtime that powers both the Bandit CLI and the VS Code extension.**

  Same tool-use loop, same skill resolution, same compaction logic — different hosts.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/stealth-core-runtime @burtson-labs/agent-core
```

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick start

`stealth-core-runtime` is the higher-level convenience layer on top of [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core) — it ships the provider implementations, the model capabilities + behavior profile catalogs, the task queue for subagents, and the system-prompt builders. Use this when you want CLI / extension parity without re-wiring every piece yourself.

```ts
import { createStealthRuntime, type StealthHostBindings } from "@burtson-labs/stealth-core-runtime";

const bindings: StealthHostBindings = {
  // Provider + model selection
  providerClient,                  // Ollama / OpenAI-compatible / Bandit cloud
  modelId: "gemma3:12b",

  // Host integration (filesystem, shell, telemetry, etc.)
  fsAdapter,
  shellAdapter,
  telemetry,
};

const runtime = createStealthRuntime(bindings);

const plan = await runtime.plan("Audit src/auth.ts for unhandled errors");
const result = await runtime.execute();
```

### Model intelligence

```ts
import {
  getModelCapabilities,
  getModelBehaviorProfile
} from "@burtson-labs/stealth-core-runtime";

const caps = getModelCapabilities("gemma3:12b");
// → { contextWindow, supportsTools, supportsVision, tier, ... }

const behavior = getModelBehaviorProfile("gemma3:12b");
// → { preferredToolProtocol, textToolFallback, safeContextBudget, ... }
```

The catalog covers Bandit, Gemma 3 / 4, Qwen 2.5 / 3.6, Llama 3.x, GPT, Claude, and friends. Per-workspace overrides via `parseModelBehaviorConfig` + `.bandit/model-profiles.json`.

### Typical pairings

| You need | Add |
|---|---|
| Memory loading / hooks / `@`-mentions | [`@burtson-labs/host-kit`](https://www.npmjs.com/package/@burtson-labs/host-kit) |
| React UI for plan / chat / diff | [`@burtson-labs/agent-ui`](https://www.npmjs.com/package/@burtson-labs/agent-ui) |
| Sanitize raw model output for chat display | [`@burtson-labs/core-chat`](https://www.npmjs.com/package/@burtson-labs/core-chat) |
| Run on Node host | [`@burtson-labs/agent-adapters-node`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-node) |
| Run in browser host | [`@burtson-labs/agent-adapters-web`](https://www.npmjs.com/package/@burtson-labs/agent-adapters-web) |

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's in the box

- **Provider implementations** — `OllamaProvider`, `BanditEngineProvider` (cloud), `OpenAIProvider`, plus shape adapters for OpenAI-compatible endpoints
- **Model capabilities catalog** — `getModelCapabilities(modelId)` returns context window, tool-calling support, vision support, tier, and runtime options for every known model (Bandit, Gemma 3/4, Qwen 2.5/3.6, Llama, GPT, Claude, etc.)
- **Model behavior profiles** — `getModelBehaviorProfile(modelId)` separates harness strategy from raw capability detection: preferred tool protocol, text-tool fallback, safe input/output budgets, compaction mode, prompting template, thinking default, parallel-tool limits, and known failure modes. `parseModelBehaviorConfig` / `registerModelBehaviorConfig` power workspace `.bandit/model-profiles.json` overrides in both hosts.
- **Task queue** — fair-scheduled subagent backgrounding so the parent turn doesn't block
- **Rewrite generator** — small-model-friendly streaming patch emitter, used when the model can't reliably produce `apply_edit` find/replace pairs
- **System prompt builders** — both CLI and extension variants, with capability-aware branches (vision-on, tool-calling-on, etc.)

## <img src="https://api.iconify.design/lucide/shield-check.svg?color=%23a60ee5&width=22" align="absmiddle"> Status

Stable. This is the most-tested package in the monorepo after [`@burtson-labs/agent-core`](../agent-core/). Breaking changes need a coordinated PR across both hosts.

## <img src="https://api.iconify.design/lucide/flask-conical.svg?color=%23a60ee5&width=22" align="absmiddle"> Tests

```bash
pnpm --filter stealth-core-runtime test
```

The suite covers model capability/behavior resolution, provider behavior under each tool-calling mode, the task queue's fairness guarantees, and a small fleet of replay fixtures captured from real failure traces.

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
