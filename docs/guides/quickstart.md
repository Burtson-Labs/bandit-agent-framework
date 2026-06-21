# Quickstart

Two ways to start, depending on what you want:

- **Use it** — install the CLI or the editor extension and run an agent against your code. ~2 minutes.
- **Build on it** — pull the packages and stand up your own agent in ~15 lines. ~5 minutes.

Both are **local-first**: point them at a model running on your own machine (via [Ollama](https://ollama.com)) and nothing leaves the box. No account, no phone-home.

---

## Use it

### In the terminal — Bandit CLI

```bash
curl -fsSL https://burtson.ai/bandit-stealth-cli/install.sh | sh
# or: npm i -g bandit-stealth-cli
ollama pull gemma4:e4b   # Bandit's default local model
bandit
```

That drops you into an interactive session in the current directory. Ask for what you want:

```
> add error handling to src/db.ts and run the tests
```

Bandit plans, edits files, runs commands, and shows you each step. One-shot mode (no REPL) is `bandit "your goal"`. To use the cloud or any OpenAI-compatible endpoint instead of a local model, see [Configuration](./configuration.html).

### In your editor — VS Code / Cursor

Install **Bandit Stealth** from the marketplace, open the Bandit panel, and chat. It's the same agent docked into your editor, with inline diffs, approvals, and tool runs. See the [extension page](./bandit-stealth.html).

---

## Build on it

The CLI and the extension are both *hosts* built on the same runtime — and that runtime is published, so you can build your own. The fastest path is the prebuilt Node adapter, which wires the agent to your filesystem and shell:

```bash
pnpm add @burtson-labs/agent-adapters-node @burtson-labs/agent-core
```

```ts
import { createNodeAdapter } from "@burtson-labs/agent-adapters-node";

const adapter = createNodeAdapter();

// Plan against a goal, run the steps in the working directory, then report.
const plan = await adapter.plan("Add error handling to src/db.ts");
plan.steps.forEach((s) => console.log(`- [${s.id}] ${s.title}`));

const results = await adapter.execute();
results.forEach((r) => console.log(`${r.stepId} → ${r.status}`));

console.log((await adapter.report()).summary);
```

That's a real agent: it plans, runs tool calls in your working directory, and reports. The full runnable version lives in [`examples/agent-node-demo`](https://github.com/Burtson-Labs/bandit-agent-framework/tree/main/examples/agent-node-demo).

---

## Where to go next

- **New to agents?** Read [How a turn works](./how-a-turn-works.html), then the [Patterns](./the-agent-loop.html) section — it teaches the techniques behind modern agents, with sources.
- **Extending the agent?** [Tools](./tools.html), [Skills](./skills.html), and [MCP connectors](./mcp.html) cover what it can do; [Writing a custom tool](./writing-a-custom-tool.html) walks through adding your own.
- **Building a host?** [Build your own host](./build-your-own-host.html) goes from these 15 lines to fully custom.

**Next:** [How a turn works](./how-a-turn-works.html) · [Build your own host](./build-your-own-host.html)
