export type TerminalLevel = "info" | "warning" | "error";

export interface TerminalLine {
  timestamp: string;
  level: TerminalLevel;
  source: string;
  message: string;
}

/**
 * Hand-curated set of log lines that look like a real VS Code Output
 * channel — interleaved info/warn/error so the level coloring is
 * visible at a glance and the timestamps progress monotonically.
 */
export const mockTerminalLines: TerminalLine[] = [
  {
    timestamp: "2026-06-05 09:46:44.274",
    level: "info",
    source: "Window",
    message: "[WorktreeCleanupCron] Running scheduled worktree cleanup (interval: 6h)"
  },
  {
    timestamp: "2026-06-05 09:46:49.728",
    level: "info",
    source: "Window",
    message:
      "Auto updating outdated extensions. anthropic.claude-code, anysphere.remote-containers, burtsonlabs.bandit-stealth"
  },
  {
    timestamp: "2026-06-05 09:46:49.980",
    level: "warning",
    source: "Window",
    message:
      "[WorktreeManager] Timed out after 5000ms waiting for local agent scan; orphan classification disabled this pass"
  },
  {
    timestamp: "2026-06-05 09:46:49.980",
    level: "info",
    source: "Window",
    message: "[WorktreeManager] Cleanup complete: scanned=0, removed=0, bytesFreed=0, errors=0"
  },
  {
    timestamp: "2026-06-05 09:46:50.985",
    level: "info",
    source: "Window",
    message: "Auto update disabled for extension burtsonlabs.bandit-stealth"
  },
  {
    timestamp: "2026-06-05 09:46:50.986",
    level: "info",
    source: "Window",
    message: "Auto updating extension anthropic.claude-code"
  },
  {
    timestamp: "2026-06-05 09:46:50.987",
    level: "info",
    source: "Window",
    message: "Auto updating extension anysphere.remote-containers"
  },
  {
    timestamp: "2026-06-05 15:33:14.665",
    level: "error",
    source: "Window",
    message:
      "lock() request could not be registered.: InvalidStateError: lock() request could not be registered. lock() request could not be registered."
  }
];
