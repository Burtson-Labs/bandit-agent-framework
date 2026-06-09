<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-adapters

  **Adapter layer for the things Bandit talks to outside its own runtime.**

  LLM providers, embedding models, vector stores, GitHub, the VS Code extension API, and the web — intentionally thin shims that normalize one external API surface into the shape [`@burtson-labs/agent-core`](../agent-core/) expects.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-adapters
```

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's here

| Subdir | What |
|---|---|
| `provider/` | LLM provider adapters (Ollama, Bandit cloud gateway, OpenAI-compatible endpoints) |
| `github/` | GitHub API client used by GitHub-flavored tools |
| `vscode/` | VS Code-specific adapter shims (workspace, terminal, output channel) |
| `web/` | Browser-runtime shims (used by the standalone web UI and the extension webview) |
| `node/` | Node.js-runtime shims (filesystem, child_process) |

## <img src="https://api.iconify.design/lucide/shield-check.svg?color=%23a60ee5&width=22" align="absmiddle"> Status

Stable. Adding a new provider goes here; adding a new tool generally does NOT (that's [`@burtson-labs/agent-core`](../agent-core/) or [`@burtson-labs/host-kit`](../host-kit/)).

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23a60ee5&width=22" align="absmiddle"> When to extend this package

- **New LLM provider** — add a class under `provider/` that implements the `ChatProvider` shape from `@burtson-labs/agent-core`. See `OllamaProvider` for the reference implementation.
- **New embedding backend** — same pattern under `provider/`. Embedding adapters are simpler — single method, deterministic output.
- **New host adapter** — only if you're writing a new top-level host (a JetBrains plugin, a Slack bot, etc.). Discuss in an issue first; we'd rather absorb the use case into an existing adapter than fork a new subdirectory.

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
