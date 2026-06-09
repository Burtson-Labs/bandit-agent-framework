# Build your own host

Bandit isn't just a CLI and an extension — it's the **runtime those two are built on**, published so you can build your own. A "host" is the thin layer that gives the agent three things: a **provider** (the model), **tools** (what it can do), and **I/O adapters** (how it touches the filesystem, shell, editor, or browser). The framework brings the reasoning loop; you bring the host.

This guide goes from a 15-line working agent to a fully custom host.

---

## The 15-line version

The fastest path is a prebuilt environment adapter. `@burtson-labs/agent-adapters-node` wires the runtime to a Node environment (filesystem + shell) for you:

```ts
import { createNodeAdapter } from "@burtson-labs/agent-adapters-node";

const adapter = createNodeAdapter();

const plan = await adapter.plan("Add error handling to src/db.ts");
plan.steps.forEach((s) => console.log(`- [${s.id}] ${s.title}`));

const results = await adapter.execute();
results.forEach((r) => console.log(`${r.stepId} → ${r.status}`));

console.log((await adapter.report()).summary);
```

```bash
pnpm add @burtson-labs/agent-adapters-node @burtson-labs/agent-core
```

That's a real agent: it plans against a goal, executes tool calls in your working directory, and reports. The full runnable version lives in [`examples/agent-node-demo`](https://github.com/Burtson-Labs/bandit-agent-framework/tree/main/examples/agent-node-demo).

---

## How the layers fit

```
your host
  └─ @burtson-labs/stealth-core-runtime   ← provider impls, model catalog, prompts, subagent queue
       └─ @burtson-labs/agent-core         ← the tool-use loop + tool registry (the reasoning engine)
            ├─ provider  (Ollama / OpenAI-compatible / cloud)
            ├─ tools     (read_file, run_command, web_search, your own …)
            └─ adapters  (node / web / vscode / github environment shims)
```

- [`agent-core`](./agent-core.html) is the engine — the loop that turns a goal into tool calls and a result.
- [`stealth-core-runtime`](./stealth-core-runtime.html) is the convenience layer the CLI and extension share — provider implementations, the model capability/behavior catalogs, system-prompt builders, and the subagent task queue. Use it when you want CLI/extension parity without re-wiring every piece.
- [`host-kit`](./host-kit.html) adds the host-side building blocks: memory, hooks, the security guard, MCP, `@`-mentions, and drop-in tools.
- [`agent-adapters`](./agent-adapters.html) normalizes the outside world (filesystem, shell, editor APIs, the browser) into the shapes the runtime expects.

---

## Customizing the host

When you outgrow the canned node adapter, drop down to `createStealthRuntime` and pass your own bindings — the same entry point both shipping products use:

```ts
import { createStealthRuntime, type StealthHostBindings } from "@burtson-labs/stealth-core-runtime";

const bindings: StealthHostBindings = {
  providerClient,         // Ollama, an OpenAI-compatible endpoint, or the Bandit cloud gateway
  modelId: "gemma3:12b",  // looked up in the model capability + behavior catalog
  fsAdapter,              // how the agent reads/writes files in your environment
  shellAdapter,           // how it runs commands
  telemetry,              // optional — OpenTelemetry export you control
};

const runtime = createStealthRuntime(bindings);

const plan = await runtime.plan("Audit src/auth.ts for unhandled errors");
const result = await runtime.execute();
```

Swap `providerClient` to change models (local ↔ cloud ↔ OpenAI-compatible), and swap `fsAdapter` / `shellAdapter` to run somewhere other than Node — a browser sandbox, a remote worker, a container. The runtime doesn't care where it runs; that's the whole point of the adapter layer. See [`agent-adapters`](./agent-adapters.html) for the shims and [`stealth-core-runtime`](./stealth-core-runtime.html) for the provider implementations and the model catalog.

---

## Giving the agent more tools

Tools are what the agent can *do*. [`host-kit`](./host-kit.html) ships ready-made ones you register straight into the tool registry:

```ts
import { buildWebSearchTool, buildTaskTool, buildTestRunTool } from "@burtson-labs/host-kit";

registry.register(buildWebSearchTool({ apiKey }));  // web search
registry.register(buildTaskTool({ /* … */ }));      // spawn subagents
registry.register(buildTestRunTool());              // detect the test framework + run it
```

Writing your own tool is the most common extension — a name, a description the model reads, a parameter schema, and a handler. (A dedicated **Writing a custom tool** guide is next on the list.)

---

## Going fully custom

For total control, skip the convenience layer and use `agent-core` directly:

```ts
import { createAgentRuntime } from "@burtson-labs/agent-core";

const runtime = createAgentRuntime({
  provider,            // your ProviderClient implementation
  // …tools, budgets, and the rest of the runtime options
});
```

This is the path for an entirely new host — a JetBrains plugin, a Slack bot, a CI runner. You own the provider and the tool set; `agent-core` owns the loop. The [`agent-core` reference](./agent-core.html) covers the full options surface.

---

## What you get for free

However you wire it, the runtime brings the hard parts: the tool-use loop with retries and fallbacks, model-aware prompting and tool-protocol selection, context compaction, secret redaction, and the optional pre-tool security guard. You write the host; Bandit handles the agent.

**Next:** [How a turn works](./how-a-turn-works.html) · [Configuration](./configuration.html) · or jump to the [packages](./host-kit.html).
