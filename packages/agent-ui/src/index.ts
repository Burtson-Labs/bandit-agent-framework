import type { AgentAskResult } from "@burtson-labs/agent-core";

export * from "./components";
export * from "./hooks";
export * from "./context";
export * from "./theme";
export * from "./types/ui-schema";

export interface TimelineEntry {
  label: string;
  value: string;
}

export const buildTimeline = (result: AgentAskResult): TimelineEntry[] => [
  { label: "Prompt", value: result.prompt },
  { label: "Response", value: result.response },
  { label: "Duration", value: `${result.durationMs}ms` }
];
