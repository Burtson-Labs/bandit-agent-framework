<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/core-chat

  **Shared chat message types and sanitizers used across every Bandit surface.**

  Tiny package, narrow surface — keeps every host on the same `ChatMessage` shape without dragging in the full runtime.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/core-chat
```

## <img src="https://api.iconify.design/lucide/shield-check.svg?color=%23a60ee5&width=22" align="absmiddle"> Status

Stable. The type surface is intentionally narrow; expanding it requires coordinated PRs across the hosts that consume it (CLI, VS Code extension, web UI).

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick example

```ts
import type { ChatMessage } from '@burtson-labs/core-chat';
import { sanitizeModelOutput } from '@burtson-labs/core-chat';

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are Bandit.' },
  { role: 'user', content: 'Hi.' },
];

const cleaned = sanitizeModelOutput(rawModelText);
```

`sanitizeModelOutput()` is the canonical pass for stripping control tokens, tool-call envelope markup, and other model-emitted artifacts that should never reach the user's screen.

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
