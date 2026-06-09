<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-adapters-node

  **Node.js host adapter for the Bandit Agent Framework.**

  Wires [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core)'s runtime to a Node process — shell execution, filesystem reads/writes, and an `AgentRuntime` factory configured for server-side hosts.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-adapters-node @burtson-labs/agent-core
```

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's inside

- `runCommand` / `CommandRunOptions` / `CommandRunResult` — promise-wrapped `child_process.exec` with cwd, env, and timeout knobs
- Node-targeted `AgentRuntime` factory built on top of `createAgentRuntime` from `agent-core`
- Step executors that read/write files through `fs/promises`

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick example

```ts
import { runCommand } from "@burtson-labs/agent-adapters-node";

const result = await runCommand("pnpm test", {
  cwd: "/path/to/repo",
  timeoutMs: 60_000
});

console.log(result.exitCode, result.stdout);
```

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Burtson Labs.
