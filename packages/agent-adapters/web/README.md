<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-adapters-web

  **Browser host adapter for the Bandit Agent Framework.**

  Run an [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core) runtime in the browser — agent events are dispatched through a configurable `EventTarget` so any host (a React app, a webview, a worker) can subscribe with normal DOM event listeners.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-adapters-web @burtson-labs/agent-core
```

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's inside

- `WebAdapter` — wraps an `AgentRuntime` with `plan` / `execute` / `report` plus a `subscribe(listener)` returning an unsubscribe function
- `WebAdapterOptions` — extends `CreateAgentRuntimeOptions` with `target` (custom `EventTarget`) and `eventName` for the dispatched event type
- `MinimalEventTarget` — structural type for hosts that ship a partial event target (workers, custom impls)

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick example

```ts
import { createWebAdapter } from "@burtson-labs/agent-adapters-web";

const adapter = createWebAdapter({
  target: window,
  eventName: "bandit-agent-event"
});

const unsubscribe = adapter.subscribe((event) => {
  console.log(event.type, event.payload);
});

await adapter.plan("Summarize the current page");
unsubscribe();
```

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Burtson Labs.
