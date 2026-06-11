# bandit-stealth-cli

Unscoped alias for [`@burtson-labs/bandit-stealth-cli`](https://www.npmjs.com/package/@burtson-labs/bandit-stealth-cli) — **Bandit**, a local-first AI coding agent for your terminal. Your code never leaves your machine; works with any Ollama model.

```bash
npm i -g bandit-stealth-cli
bandit
```

Installing this package pulls the latest scoped package and exposes the same `bandit` command. Both install paths are equivalent — pick one. They can't coexist globally: both own the `bandit` bin, so installing one while the other is present fails with `npm error code EEXIST` on the `bandit` bin path. If you previously installed the scoped package globally, remove it first:

```bash
npm rm -g @burtson-labs/bandit-stealth-cli
```

- Repo: https://github.com/Burtson-Labs/bandit-agent-framework
- Docs: https://docs.burtson.ai

Apache-2.0
