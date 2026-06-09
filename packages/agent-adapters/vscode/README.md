<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-adapters-vscode

  **VS Code extension adapter for the Bandit Agent Framework.**

  Bridges [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core) to the VS Code workspace API — filesystem reads/writes via `workspace.fs`, URI handling via `Uri.file`, status messages via `window.showInformationMessage`, and event posting to a webview.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-adapters-vscode @burtson-labs/agent-core
```

## <img src="https://api.iconify.design/lucide/puzzle.svg?color=%23a60ee5&width=22" align="absmiddle"> What's inside

- `VscodeLike` — minimal structural type for the `vscode` namespace so the adapter compiles outside a real extension host (useful in tests)
- `VscodeAdapterFs` — `workspace.fs` shim used by step executors that read/write files
- An adapter that streams `AgentEvent`s through `postMessage` so the webview can render plan + diff + log timelines
- `Buffer` import comes from the `buffer` package so the adapter runs in the extension's Node host without relying on globals

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick example

```ts
import * as vscode from "vscode";
import { createVscodeAdapter } from "@burtson-labs/agent-adapters-vscode";

const adapter = createVscodeAdapter({
  vscode,
  postMessage: (msg) => webviewPanel.webview.postMessage(msg)
});

const plan = await adapter.plan("Refactor login flow");
```

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Burtson Labs.
