<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" />
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.burtson.ai/logos/burtson-labs-logo.png" />
    <img src="https://cdn.burtson.ai/logos/burtson-labs-logo-alt.png" alt="Burtson Labs" width="150" />
  </picture>

  # agent-ui-workbench

  **Mock-driven dev harness for iterating on [`@burtson-labs/agent-ui`](../../packages/agent-ui/) components in isolation.**

  Not a shipped product — internal-facing developer tool only.
</div>

---

## <img src="https://api.iconify.design/lucide/shield-check.svg?color=%23a60ee5&width=22" align="absmiddle"> Status

Experimental, internal-facing. Not currently open to external contributions — file an issue if you spot a bug.

The mocks under `src/mocks/` simulate provider events the components would normally receive from the agent runtime.

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Local dev

```bash
pnpm --filter agent-ui-workbench dev
```

## <img src="https://api.iconify.design/lucide/book-open.svg?color=%23a60ee5&width=22" align="absmiddle"> When to use this

If you're contributing a fix to a component in [`packages/agent-ui/`](../../packages/agent-ui/) and want to see it render in isolation without spinning up the VS Code extension host or the Bandit Stealth web app. Otherwise you probably want the actual host — the [VS Code extension](../bandit-stealth/) for IDE work, or the Bandit Stealth web app (hosted product, separate repo) for the control plane.

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
