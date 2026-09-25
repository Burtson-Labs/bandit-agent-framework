<div align="center">
  <a href="https://burtson.ai">
    <picture>
      <img src="https://cdn.burtson.ai/logos/burtson-labs-logo.png" alt="Burtson Labs" width="200" style="width: 200px !important; max-width: 200px !important; height: auto; display: inline-block;" />
    </picture>
  </a>

  # @burtson-labs/agent-ui

  **UI primitives shared between the Bandit Stealth web app and the VS Code extension webview.**

  Host-agnostic React components — they consume a normalized event stream from the runtime and don't know whether they're rendering inside Vite, a VS Code webview, or the workbench harness.
</div>

---

## <img src="https://api.iconify.design/lucide/package.svg?color=%23a60ee5&width=22" align="absmiddle"> Install

```bash
pnpm add @burtson-labs/agent-ui
```

Peer-depends on React 19, MUI 7, and emotion — the host app provides them. The runtime side (the event stream the components consume) comes from [`@burtson-labs/agent-core`](https://www.npmjs.com/package/@burtson-labs/agent-core) or the pre-wired [`@burtson-labs/stealth-core-runtime`](https://www.npmjs.com/package/@burtson-labs/stealth-core-runtime).

## <img src="https://api.iconify.design/lucide/zap.svg?color=%23a60ee5&width=22" align="absmiddle"> Quick start

Components are pure — they consume props and don't reach for any host. Import the CSS once at your app root, then drop components in:

```tsx
import {
  MarkdownMessage,
  ChatComposer,
  ChatConversation,
  PlanTree,
  DiffStream,
  TelemetryPanel,
  AgentConsole
} from "@burtson-labs/agent-ui";
import "@burtson-labs/agent-ui/styles/agent-ui.css";

function ChatPanel({ messages, onSend }) {
  return (
    <>
      <ChatConversation messages={messages} />
      <ChatComposer onSubmit={onSend} placeholder="Type a message…" />
    </>
  );
}
```

Import from the package root. `import` resolves to an ES module build and the package marks only its stylesheet as a side effect, so bundlers keep just the components you use: one card from the root adds about 7 KB, not the whole library. `require` still gets the CommonJS build.

### What's in the box

| Component | What it renders |
|---|---|
| `ChatComposer` | Multi-line input + submit, with model picker, mode toggle, and skill chips |
| `ChatConversation` | Streaming message list with assistant / user / tool / reasoning blocks |
| `MarkdownMessage` | Single message bubble — markdown + syntax highlighting + file-reference links |
| `PlanTree` | Plan + steps tree with progress states |
| `PlanActivity` | Per-step activity feed (tool calls, diffs, logs) |
| `DiffStream` | Live unified-diff viewer for proposed edits |
| `DiffReview/DiffReviewPanel` | Multi-file accept / reject before applying |
| `TelemetryPanel` | Token usage + per-iteration timing; counts a provider never reported read "Unknown" |
| `UsageMeter` / `ContextMeter` | Used-of-limit meter that shows unknown usage as unknown and draws no bar without a reported limit |
| `AgentConsole` | Combined chat + plan + diff cockpit for the simple case |
| `PermissionCard` | Inline allow/deny prompt for write-tool execution. Pass `status` to let the host own the decision state (`pending`, `submitting`, `resolved`, `error`, `expired`); a request never reports a decision twice. Focuses itself while pending (without scrolling the page); `autoFocus={false}` opts out |
| `QuestionCard` | `ask_user` questions: radio options, typed answers, tabs plus a review step for several questions. `toUserInputResponse` builds the host's `userInputResponse` message. Focuses itself on mount without scrolling the page; `autoFocus={false}` opts out (e.g. a demo below the fold) |
| `TaskList` | Compact list of in-flight + recent agent runs |
| `BackgroundTaskTile` | Live tile for a subagent the parent turn spawned |

## <img src="https://api.iconify.design/lucide/shield-check.svg?color=%23a60ee5&width=22" align="absmiddle"> Status

Stable. Used by the Bandit Stealth web app, the Bandit VS Code extension webview, and a mock-driven dev workbench. Breaking changes need a coordinated PR across the consumers.

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23a60ee5&width=22" align="absmiddle"> Authoring a new component

Components live under `src/components/`. Each one should:

1. Consume props only — no global state, no host-specific imports
2. Be testable from a mock event-source harness
3. Match the existing visual language (MUI primitives, dark/light theme aware)

## License

[Apache License 2.0](../../LICENSE) — Copyright 2026 Burtson Labs.
