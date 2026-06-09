<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-adapters-github

  **GitHub Actions adapter for the Bandit Agent Framework.**

  Run an agent inside a workflow and surface its plan, execution, and report as a GitHub check run — backed by [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core).
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-adapters-github @burtson-labs/agent-core
```

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's inside

- `GithubAdapterOptions` — extends `CreateAgentRuntimeOptions` with `repository`, `headSha`, and `workflowName`
- `GithubCheckRunPayload` — the shape POSTed to the GitHub `/check-runs` endpoint after a planned run
- `GithubCheckRunOutput` — title / summary / text fields that render in the workflow UI
- An adapter that maps agent plan + execution + report into a single check-run payload

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick example

```ts
import { createGithubAdapter } from "@burtson-labs/agent-adapters-github";

const adapter = createGithubAdapter({
  repository: "burtson-labs/bandit-agent-framework",
  headSha: process.env.GITHUB_SHA,
  workflowName: "Bandit Agent"
});

const checkRun = await adapter.toCheckRun(await adapter.plan("Audit PR"));
```

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Burtson Labs.
