import type { AgentAskResult } from "@burtson-labs/agent-core";

export * from "./components/index.js";
export * from "./hooks/index.js";
export * from "./context/index.js";
export * from "./theme/index.js";
export * from "./types/ui-schema.js";

export interface TimelineEntry {
  label: string;
  value: string;
}

export const buildTimeline = (result: AgentAskResult): TimelineEntry[] => [
  { label: "Prompt", value: result.prompt },
  { label: "Response", value: result.response },
  { label: "Duration", value: `${result.durationMs}ms` }
];
