<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-adapters-provider

  **LLM provider adapters for the Bandit Agent Framework.**

  Thin streaming wrappers that normalize one provider API surface into the shape [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core) expects, so the agent runtime is provider-agnostic.
</div>

---

## <img src="https://icons.burtson.ai/svg-accent/download.svg" width="22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-adapters-provider @burtson-labs/agent-core
```

## <img src="https://icons.burtson.ai/svg-accent/blocks.svg" width="22" align="absmiddle"> What's inside

- `ProviderClient` — base provider abstraction consumed by `agent-core`'s tool-use loop
- `DeterministicProviderClient` — replay-friendly client for tests and trace fixtures
- `ProviderChatOptions` — normalized request shape across providers
- A polyfilled `TextDecoder` fallback for runtimes that don't ship one (some constrained worker environments)

## <img src="https://icons.burtson.ai/svg-accent/zap.svg" width="22" align="absmiddle"> Quick example

```ts
import { DeterministicProviderClient } from "@burtson-labs/agent-adapters-provider";
import { createAgentRuntime } from "@burtson-labs/agent-core";

const provider = new DeterministicProviderClient({
  responses: ["Hello from a pinned reply."]
});

const runtime = createAgentRuntime({ providerClient: provider });
```

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Burtson Labs.
