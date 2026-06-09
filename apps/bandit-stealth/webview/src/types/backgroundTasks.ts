// Mirror of @burtson-labs/host-kit's BackgroundTaskRecord. Re-declared
// here rather than imported because host-kit pulls node:events which
// can't be tree-shaken cleanly out of the Vite browser bundle. Keep in
// sync with packages/host-kit/src/backgroundTasks.ts if either evolves.

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTaskRecord {
  id: string;
  goal: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt?: number;
  iterations: number;
  toolCalls: number;
  lastTool?: string;
  synopsis?: string;
  error?: string;
  consumed: boolean;
}
