/**
 * CLI telemetry glue — a process-wide singleton over the shared
 * `TelemetryExporter` in @burtson-labs/agent-core. The CLI runs one turn at a
 * time, so a single exporter reused across turns is correct; the emitEvent
 * funnel and the REPL turn loop call these no-op-if-disabled helpers rather than
 * threading an instance through both closures.
 *
 * The exporter implementation (OTLP payloads, redaction, flush) is shared with
 * the IDE host — see agent-core/src/telemetry/otlpExporter.ts.
 */
import { TelemetryExporter, resolveTelemetryConfig, type TelemetryConfig } from '@burtson-labs/agent-core';

export { resolveTelemetryConfig, type TelemetryConfig };

let active: TelemetryExporter | null = null;

/** Initialize (or tear down) the session exporter. `null` config = disabled. */
export function initTelemetry(cfg: TelemetryConfig | null, opts?: { now?: () => number; sink?: (path: string, body: unknown) => Promise<void> }): boolean {
  active = cfg ? new TelemetryExporter(cfg, opts) : null;
  return active !== null;
}
export function telemetryStartTurn(goal: string, model: string): void { active?.startTurn(goal, model); }
export function telemetryEvent(type: string, payload: unknown): void { active?.onEvent(type, payload); }
export function telemetryEndTurn(outcome?: { error?: string }): void { void active?.endTurn(outcome); }
/** Awaitable end-of-turn flush. Use in one-shot mode (`bandit "prompt"`), where
 *  the process exits right after the turn and a fire-and-forget POST would be
 *  aborted mid-flight. endTurn awaits its own POSTs and never rejects. */
export async function telemetryEndTurnAwait(outcome?: { error?: string }): Promise<void> { await active?.endTurn(outcome); }
