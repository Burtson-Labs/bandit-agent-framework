/**
 * Local-runner ↔ gateway contract for REMOTE CONTROL.
 *
 * This is the seam that lets Bandit Stealth Web (or any cloud client) drive the
 * agent running on the user's OWN machine — the local filesystem, the local
 * uncommitted changes — instead of a cloud GitHub clone. It mirrors the
 * cloud-runner seam in `services/agent-runner` (task in → event stream out) but
 * INVERTS the transport: a local process can't be reached by an inbound HTTP
 * POST (it's behind NAT), so the runner reaches OUT to the gateway — subscribes
 * to an inbox of tasks assigned to this device, and pushes events back.
 *
 * Design rules (same spirit as the cloud contract):
 *  - The runner treats `taskId` as opaque and echoes it on every event.
 *  - The runner never learns about accounts, credits, or billing. It receives
 *    a prompt + a mode and returns events. That's all.
 *  - Additive-only within a protocol version.
 *
 * SAFETY: unlike the cloud runner (where every change is reviewed as a PR
 * before it touches anything real), a local runner is editing the user's actual
 * working tree with nobody at the keyboard. So a remote task defaults to
 * `plan` mode — read-only — and produces a plan, not silent edits. See
 * planModeGate.ts; the boundary is host-kit's `decidePermission`.
 */

export const RUNNER_PROTOCOL_VERSION = 1 as const;

/** The permission mode a remote task runs under. Defaults to `plan` (read-only)
 *  for safety — the gateway may request a looser mode only with explicit,
 *  per-device authorization (a later phase). */
export type RemoteRunMode = 'plan' | 'ask' | 'auto';

/** A task handed to the local runner over the inbox. */
export interface RemoteTask {
  protocol: typeof RUNNER_PROTOCOL_VERSION;
  /** Gateway task id — opaque, echoed on every event. */
  taskId: string;
  /** The user's goal for this task. */
  prompt: string;
  /** Permission mode for this task. Absent ⇒ `plan` (the safe default). */
  mode?: RemoteRunMode;
  /** Optional hard cap on tool-loop iterations. */
  maxIterations?: number;
  /** When set, this is a turn in a LIVE session (remote control): the host
   *  runs it in that session's ongoing conversation and mirrors to the session
   *  id, rather than as an isolated one-shot task. */
  sessionId?: string;
}

/**
 * Events the runner streams back to the gateway for a task. Intentionally the
 * SAME vocabulary as the cloud runner (`services/agent-runner` RunnerEvent) so
 * the gateway's existing StealthEventBus / SSE / web task UI relays them with
 * no new event handling — a local task looks like any other task to the web.
 *
 * `blocked` is the one addition remote control needs: in plan mode a mutating
 * tool is refused, and the web user should see WHAT the agent wanted to do
 * (that's the "proposed change" a later phase turns into an apply-gate).
 */
export type RunnerEvent =
  | { type: 'turn.started'; taskId: string; protocol: number; runnerVersion: string; mode: RemoteRunMode }
  | { type: 'assistant.delta'; taskId: string; text: string }
  | { type: 'tool.call'; taskId: string; tool: string; params: Record<string, string> }
  | { type: 'tool.result'; taskId: string; tool: string; ok: boolean; summary: string }
  | { type: 'tool.blocked'; taskId: string; tool: string; reason: string }
  | { type: 'artifact.changed'; taskId: string; path: string; kind: 'created' | 'modified' | 'deleted' }
  | { type: 'turn.completed'; taskId: string; artifacts: number; noChangeReason?: string; assistantText: string }
  | { type: 'turn.error'; taskId: string; code: string; message: string };

/**
 * The transport the engine talks to. Injected so the engine is pure and
 * testable with an in-memory fake — the HTTP implementation (inbox SSE + event
 * POST) is one concrete `RunnerGateway`, a fake in tests is another.
 */
export interface RunnerGateway {
  /**
   * Stream of tasks assigned to this device. Yields until `signal` aborts or
   * the connection ends. Implementations reconnect internally; a return means
   * "stop the runner" (shutdown), not "transient blip".
   */
  inbox(signal: AbortSignal): AsyncIterable<RemoteTask>;
  /** Push one event for a task back to the gateway. Best-effort ordered. */
  publish(taskId: string, event: RunnerEvent): Promise<void>;
}
