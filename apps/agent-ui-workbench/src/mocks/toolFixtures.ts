import type { Goal } from "@burtson-labs/agent-core";
import type { BanditPermissionPayload } from "@burtson-labs/agent-ui";

// Each fixture mirrors the on-the-wire shape the real Bandit agent
// emits for the matching tool. The Tool palette inserts these into
// the conversation so we can iterate on the rendering of each tool's
// UI surface without booting a live agent. Keep them realistic — if
// a real fetch wouldn't return a 4-line snippet, neither should the
// fixture.

export const READ_FILE_FIXTURE = {
  path: "packages/agent-ui/src/theme/BanditThemeProvider.tsx",
  language: "typescript",
  excerpt: `import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { applyTheme, type BanditTheme } from "./theme-base";
import { DEFAULT_THEME_ID, banditThemes, getThemeById, type RegisteredThemeId } from "./theme-registry";
import { readVsCodeTheme } from "./vscode-theme";

export type ThemePreference = "auto" | RegisteredThemeId;

export const BanditThemeProvider = ({ children }) => {
  const [preference, setPreference] = useState<ThemePreference>("auto");
  const [ideTheme, setIdeTheme] = useState<BanditTheme | null>(() => readVsCodeTheme());
  const theme = useMemo(() => {
    if (preference === "auto") return ideTheme ?? getThemeById(DEFAULT_THEME_ID);
    return getThemeById(preference);
  }, [ideTheme, preference]);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>;
};`,
  durationMs: 3
};

export const LIST_FILES_FIXTURE = {
  pattern: "packages/agent-ui/src/components/*.tsx",
  results: [
    "packages/agent-ui/src/components/AgentConsole.tsx",
    "packages/agent-ui/src/components/AgentSummaryCard.tsx",
    "packages/agent-ui/src/components/ChatComposer.tsx",
    "packages/agent-ui/src/components/ChatConversation.tsx",
    "packages/agent-ui/src/components/ChatMessage.tsx",
    "packages/agent-ui/src/components/DiffBlock.tsx",
    "packages/agent-ui/src/components/DiffReviewCard.tsx",
    "packages/agent-ui/src/components/MarkdownMessage.tsx",
    "packages/agent-ui/src/components/PermissionCard.tsx",
    "packages/agent-ui/src/components/PlanActivity.tsx",
    "packages/agent-ui/src/components/PlanTree.tsx",
    "packages/agent-ui/src/components/TaskList.tsx"
  ],
  durationMs: 9
};

export const RUN_TERMINAL_FIXTURE = {
  command: "pnpm -F @burtson-labs/agent-ui test",
  output: `> @burtson-labs/agent-ui@1.2.0 test
> vitest run

 ✓ src/components/PermissionCard.test.tsx (12 tests) 184ms
 ✓ src/components/ChatComposer.test.tsx (8 tests) 96ms
 ✓ src/components/DiffBlock.test.tsx (5 tests) 41ms
 ✓ src/components/TaskList.test.tsx (6 tests) 33ms
 ✓ src/theme/BanditThemeProvider.test.tsx (9 tests) 58ms

 Test Files  5 passed (5)
      Tests  40 passed (40)
   Start at  09:21:54
   Duration  612ms`,
  exitCode: 0,
  durationMs: 612
};

export const WEB_SEARCH_FIXTURE = {
  query: "vscode theming css variables for sidebars",
  results: [
    {
      title: "Theme Color | Visual Studio Code Extension API",
      url: "https://code.visualstudio.com/api/references/theme-color",
      snippet:
        "Editor and sidebar variables — sideBar.background, sideBar.foreground, sideBarSectionHeader.background, sideBarTitle.foreground — let extensions blend with the active theme."
    },
    {
      title: "Theming · VS Code Webview UI Toolkit",
      url: "https://github.com/microsoft/vscode-webview-ui-toolkit/blob/main/docs/recipes/theming.md",
      snippet:
        "Webviews inherit a stylesheet that maps VS Code theme tokens to CSS variables — --vscode-sideBar-background etc. — so a webview can adopt the active theme without bundling its own palette."
    },
    {
      title: "How VS Code uses CSS variables to support themes",
      url: "https://github.com/microsoft/vscode/wiki/Webview-CSS-variables",
      snippet:
        "Every theme token is published as a --vscode- prefixed CSS variable on the webview <html> element. Updates are live: switching themes updates the variables in place."
    }
  ],
  durationMs: 412
};

export const WEB_FETCH_FIXTURE = {
  url: "https://code.visualstudio.com/api/references/theme-color",
  title: "Theme Color | Visual Studio Code Extension API",
  publishedAt: "2025-11-12",
  summary:
    "Reference for every named VS Code theme color. Groups: editor, sidebar, activity bar, status bar, terminal, panels, debug, notifications. Each token is exposed as both a JSON key (for theme files) and a CSS variable (for webviews) so extension authors and theme authors share the same vocabulary.",
  highlights: [
    "Sidebar tokens: sideBar.background, sideBar.foreground, sideBar.border, sideBarSectionHeader.background",
    "Activity bar: activityBar.background, activityBar.foreground, activityBarBadge.background",
    "Webview vars are kebab-cased — sideBar.background → --vscode-sideBar-background"
  ],
  durationMs: 318
};

export const FIND_DIRECTORY_FIXTURE = {
  query: "agent-ui",
  candidates: [
    { path: "/Users/dev/code/my-monorepo/packages/agent-ui", recency: "12 min ago", confidence: 0.96 },
    { path: "/Users/dev/code/my-monorepo/apps/agent-ui-workbench", recency: "4 min ago", confidence: 0.71 }
  ],
  durationMs: 87
};

export const ASK_USER_FIXTURE = {
  id: "ask-1",
  question:
    "I see two `agent-ui`-adjacent paths in this workspace — the shared package (`packages/agent-ui`) and the workbench app (`apps/agent-ui-workbench`). Which one should I open?",
  context: "Asked because find_directory returned multiple candidates inside the same monorepo.",
  options: [
    { id: "package", label: "packages/agent-ui — shared React components", isRecommended: true },
    { id: "workbench", label: "apps/agent-ui-workbench — design surface" },
    { id: "neither", label: "Neither — let me type the path" }
  ]
};

export const TODO_LIST_FIXTURE: Goal = {
  id: "goal-bandit-workbench",
  title: "Wire the workbench's tool palette",
  summary:
    "Make every supported tool insertable from the workbench so designers can iterate on each tool's UI in isolation.",
  createdAt: Date.now() - 1000 * 60 * 60 * 2,
  updatedAt: Date.now() - 1000 * 60 * 7,
  tasks: [
    {
      id: "t-1",
      title: "Add bandit-* markdown fences for tool render",
      description: "bandit-search, bandit-terminal, bandit-fetch, bandit-find — each renders the tool's own card.",
      status: "completed",
      files: ["apps/agent-ui-workbench/src/markdown/banditMarkdown.ts"]
    },
    {
      id: "t-2",
      title: "Build the ToolPalette trigger above the composer",
      description: "Popover lists every tool the workbench can mock; click inserts the matching fixture into the chat.",
      status: "completed",
      files: ["apps/agent-ui-workbench/src/components/ToolPalette.tsx"]
    },
    {
      id: "t-3",
      title: "Prototype an AskUserCard for the workbench",
      description: "Mirror PermissionCard styling: question + recommended option chip + freeform fallback.",
      status: "in_progress",
      files: ["apps/agent-ui-workbench/src/components/AskUserCard.tsx"]
    },
    {
      id: "t-4",
      title: "Promote AskUserCard into packages/agent-ui",
      description: "Move the workbench prototype into the shared package once the styling holds across all 12 themes.",
      status: "pending",
      files: ["packages/agent-ui/src/components/"]
    }
  ]
};

export const WRITE_FILE_FIXTURE: BanditPermissionPayload = {
  type: "bandit:permission",
  id: "perm-tool-palette-1",
  tool: "write_file",
  primary: "packages/agent-core/src/tools/ask-user.ts",
  description: "Register the ask_user tool in the agent-core registry",
  risk: "low",
  bodyPreview: `--- /dev/null
+++ b/packages/agent-core/src/tools/ask-user.ts
@@ -0,0 +1,28 @@
+import type { Tool } from "../types/tools";
+
+export interface AskUserParams {
+  question: string;
+  context?: string;
+  options?: Array<{ id: string; label: string; isRecommended?: boolean }>;
+}
+
+export const askUser: Tool<AskUserParams, string> = {
+  name: "ask_user",
+  description: "Pause the turn and ask the user to choose between options (or freeform).",
+  schema: {
+    type: "object",
+    required: ["question"],
+    properties: {
+      question: { type: "string" },
+      context: { type: "string" },
+      options: { type: "array" }
+    }
+  },
+  async execute(params, ctx) {
+    return ctx.requestUserChoice(params);
+  }
+};`,
  diffStats: { added: 28, removed: 0 }
};
