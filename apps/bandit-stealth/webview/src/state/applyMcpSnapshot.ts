import type { McpServerEntry } from "../components/SettingsPanel";
import type { WebviewState } from "../types/webview";

/**
 * Setter surface for the MCP-servers slice. A non-array payload is
 * treated as empty rather than left alone — the extension only emits
 * a fresh snapshot when its server pool actually changes, so a
 * missing or malformed field is a "no servers" signal, not "preserve
 * the prior list".
 */
export interface McpSnapshotDeps {
  setMcpSnapshot: (value: McpServerEntry[]) => void;
}

export function applyMcpSnapshot(state: WebviewState, deps: McpSnapshotDeps): void {
  deps.setMcpSnapshot(Array.isArray(state.mcpSnapshot) ? state.mcpSnapshot : []);
}
