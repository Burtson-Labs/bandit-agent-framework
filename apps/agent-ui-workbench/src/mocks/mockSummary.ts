import type { AgentSummaryData, DiffReviewPayload } from "@burtson-labs/agent-ui";

export const mockAgentSummary: AgentSummaryData = {
  type: "agent-summary",
  success: false,
  goal: "Refresh login CTAs and align their tokens with the Bandit Stealth theme.",
  confidence: 0.93,
  iterations: 2,
  steps: [
    { id: "1", status: "complete" },
    { id: "2", status: "complete" },
    { id: "3", status: "complete" },
    { id: "4", status: "complete" },
    { id: "5", status: "complete" },
    { id: "6", status: "complete" },
    { id: "7", status: "error" }
  ],
  files: [
    {
      path: "src/pages/login.tsx",
      summary: { added: 18, removed: 6 },
      confidence: 0.91,
      diff: `@@
- <Button className="login-button">Continue</Button>
+ <Button className="login-button login-button--xl" tone="stealth">
+   Continue
+ </Button>`,
      review: "CTA now defaults to the xl spacing scale and respects the stealth accent."
    },
    {
      path: "src/components/PrimaryButton.tsx",
      summary: { added: 42, removed: 12 },
      confidence: 0.78,
      diff: `@@
-export type ButtonSize = "sm" | "md" | "lg";
+export type ButtonSize = "sm" | "md" | "lg" | "xl";
@@
-  font-size: var(--button-font-size);
+  font-size: var(--button-font-size, 0.95rem);
+}
+&[data-tone='stealth'] {
+  background: linear-gradient(90deg, #0f172a, #1e293b);
+  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.45);
}`,
      review:
        "Component exposes the stealth tone and xl size props so the webview and workbench stay aligned."
    },
    {
      path: "src/components/Sidebar.tsx",
      summary: { added: 5, removed: 0 },
      confidence: 0.35,
      diff: `@@
+import { useTelemetry } from "../hooks/useTelemetry";
+const telemetry = useTelemetry(goalId, { eager: true });
`,
      review:
        "Patch could not land because SidebarHeader still expects the legacy telemetry props. Tests failed with `SidebarHeaderProps` missing `goalStatus`."
    }
  ],
  feedback:
    "Login updates landed, but telemetry refactor blocked finishing Sidebar.tsx. Re-run once the tests accept the new prop signature.",
  context: [
    { label: "Context", value: "src/pages/login.tsx" },
    { label: "Context", value: "src/components/PrimaryButton.tsx" },
    { label: "Error", value: "SidebarHeader.test.tsx" }
  ],
  diffPreview: `diff --git a/src/pages/login.tsx b/src/pages/login.tsx
+  <footer className="login-footer">
+    <ActionLink tone="subtle">Forgot password?</ActionLink>
+  </footer>`,
  backupPath: ".bandit/backups/login.tsx"
};

export const mockDiffReview: DiffReviewPayload = {
  path: "src/components/Sidebar.tsx",
  hasBackup: true,
  message: "Patch failed to apply because Sidebar still imports the legacy telemetry hook.",
  state: "error"
};
