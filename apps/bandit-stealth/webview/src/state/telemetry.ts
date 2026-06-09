import type { AgentTelemetryPayload } from "../types/webview";

export const buildTelemetryMetadata = (
  telemetry: AgentTelemetryPayload
): Record<string, unknown> | undefined => {
  const metadata: Record<string, unknown> = {};
  if (telemetry.kind) {
    metadata.kind = telemetry.kind;
  }
  if (telemetry.goal) {
    metadata.goal = telemetry.goal;
  }
  if (telemetry.progress) {
    metadata.progress = telemetry.progress;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};
