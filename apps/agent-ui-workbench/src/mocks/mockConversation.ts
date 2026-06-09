import type { ChatMessage } from "@burtson-labs/agent-ui";
import type { BanditPermissionPayload } from "@burtson-labs/agent-ui";

// Tool-call timeline rows use the same `bandit-tl` fence the extension
// emits. Mixed statuses ("done") show the vertical rail palette
// without needing a live agent.
const skillMarker = `_▸ using skill: Filesystem & Shell_\n`;

const toolTimeline = [
  { name: "list_files", primary: "*", status: "done", durationMs: 6 },
  { name: "read_file", primary: "package.json", status: "done", durationMs: 2 },
  { name: "read_file", primary: "pnpm-workspace.yaml", status: "done", durationMs: 1 },
  { name: "read_file", primary: "turbo.json", status: "done", durationMs: 1 },
  { name: "list_files", primary: "apps/*", status: "done", durationMs: 4 },
  { name: "list_files", primary: "packages/*", status: "done", durationMs: 4 },
  { name: "read_file", primary: "README.md", status: "done", durationMs: 3 },
  { name: "read_file", primary: "BANDIT.md", status: "done", durationMs: 4 },
  { name: "read_file", primary: "apps/bandit-stealth/package.json", status: "done", durationMs: 2 },
  { name: "read_file", primary: "packages/agent-core/src/index.ts", status: "done", durationMs: 3 },
  { name: "list_files", primary: "packages/agent-ui/src/components/*.tsx", status: "done", durationMs: 9 }
]
  .map((entry) => "```bandit-tl\n" + JSON.stringify(entry) + "\n```")
  .join("\n");

const reasoningFence = "```bandit-reasoning\nMonorepo with apps and packages. The CLI, VS Code extension, and workbench all share agent-core + agent-ui. Let me lay out what each piece is for.\n```";

const assistantFinalMarkdown = `Here's the full picture of this repo:

## bandit-agent-framework — Burtson Labs' OSS coding-agent stack

**Purpose:** A local-first agent framework that ships as a CLI, a VS Code extension (Bandit Stealth), and shared UI/runtime packages. Goal: agentic coding that works against your own Ollama (or hosted) models without enterprise gating.

### Workspace layout

| Path | What it is |
| --- | --- |
| \`apps/bandit-cli\` | Terminal client — same skills + tool-use loop as the extension |
| \`apps/bandit-stealth\` | VS Code / Cursor extension — chat panel, diff approvals, voice |
| \`apps/agent-ui-workbench\` | This workbench — design surface for the extension's React UI |
| \`packages/agent-core\` | Runtime: tool registry, planning, goals/tasks, telemetry |
| \`packages/agent-ui\` | React: ChatComposer / ChatConversation / PermissionCard / TaskList / themes |
| \`packages/agent-adapters\` | Provider adapters: Bandit cloud, Ollama, OpenAI-compatible |
| \`packages/core-chat\` | Streaming + queue + message normalization |
| \`packages/host-kit\` | Helpers for embedding the agent in custom hosts |
| \`packages/stealth-core-runtime\` | Extension-side runtime glue |

### Stack

- **Build:** pnpm workspaces + Turborepo, TypeScript (strict, ES2020).
- **UI:** React 19 + Vite for the workbench; the extension webview uses the same agent-ui package.
- **Themes:** 12-theme registry (Stealth Light/Dark, Midnight, Onyx, Charcoal, Dracula, Nord, Tokyo Night, Solarized Dark/Light, Catppuccin Mocha, Sepia) + IDE Sync.

Want me to dig deeper into one of the apps or packages, or pick a specific area to refactor?`;

export const mockMessages: ChatMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "tell me all about this repo"
  },
  {
    id: "assistant-1",
    role: "assistant",
    content: `${skillMarker}\n${toolTimeline}\n\n${reasoningFence}\n\n${assistantFinalMarkdown}`
  }
];

// Renders above the composer to mirror the extension's approval queue
// (the real panel shows pending approvals docked just above the input,
// not inline in the message scrollback — agent-ui's ChatMessage would
// otherwise downgrade an inline `bandit-permission` fence into an
// "Awaiting approval · see card above composer" placeholder).
export const mockPendingApproval: BanditPermissionPayload = {
  type: "bandit:permission",
  id: "perm-001",
  tool: "write_file",
  primary: "packages/agent-ui/src/theme/theme-registry.ts",
  description: "Add the Sepia palette to the theme registry",
  risk: "low",
  bodyPreview: `--- a/packages/agent-ui/src/theme/theme-registry.ts
+++ b/packages/agent-ui/src/theme/theme-registry.ts
@@ -10,6 +10,7 @@ import onyxTheme from "./onyx.json";
 import charcoalTheme from "./charcoal.json";
 import solarizedLightTheme from "./solarized-light.json";
+import sepiaTheme from "./sepia.json";
 import { createTheme, type BanditTheme, type ThemeConfig } from "./theme-base";
@@ -28,6 +29,7 @@ const themeConfigs = {
   "solarized-dark": solarizedDarkTheme as ThemeConfig,
   "catppuccin-mocha": catppuccinMochaTheme as ThemeConfig,
-  "solarized-light": solarizedLightTheme as ThemeConfig
+  "solarized-light": solarizedLightTheme as ThemeConfig,
+  sepia: sepiaTheme as ThemeConfig
 } satisfies Record<string, ThemeConfig>;`,
  diffStats: { added: 4, removed: 1 }
};
