/**
 * The gateway ↔ runner contract. This file is the load-bearing artifact of
 * ADR "runtime unification, Option A": the commercial gateway (C#) keeps
 * auth, credits, tasks and GitHub; this service runs agent turns. The
 * seam stays small, versioned, and one-directional — a task comes in, a
 * stream of events goes out, and NOTHING else crosses.
 *
 * Rules, so the seam never rots into the reason someone reaches for a
 * rewrite:
 *
 *  - Version every envelope. A consumer that sees a newer protocol than it
 *    speaks must fail loudly, not guess.
 *  - The runner never learns about credits, orgs, billing, or GitHub App
 *    installations. If a field like that shows up here, it is a design
 *    bug, not a convenience.
 *  - The gateway never learns about the runtime's internals. It gets
 *    events it can persist and forward; that is all.
 *  - Additive changes only within a major version. Renaming or removing a
 *    field is a new protocol version, no exceptions.
 */

export const PROTOCOL_VERSION = 1 as const;

/** POST /v1/turns request body. */
export interface TurnRequest {
  protocol: typeof PROTOCOL_VERSION;
  /** Gateway's task id — echoed on every event so streams are attributable
   *  even when multiplexed into logs. The runner treats it as opaque. */
  taskId: string;
  /** Absolute path of an ALREADY-PREPARED workspace. Cloning and branch
   *  handling stay gateway-side for now — the runner edits, it does not
   *  provision. */
  workspacePath: string;
  /** The user's goal for this turn. */
  prompt: string;
  /** Provider selection. 'deterministic' exists so the seam can be proven
   *  and load-tested with no model attached. */
  provider: TurnProvider;
  /** Optional hard cap on tool-loop iterations. */
  maxIterations?: number;
}

export type TurnProvider =
  | { kind: 'deterministic'; script?: string[] }
  | { kind: 'ollama'; baseUrl: string; model: string }
  | {
      kind: 'openai-compat';
      /** Base URL to which /chat/completions is appended — include /v1
       *  where the upstream uses it (api.openai.com/v1, api.groq.com/openai/v1). */
      baseUrl: string;
      apiKey: string;
      model: string;
    };

/**
 * NDJSON stream, one event per line. `turn.completed` or `turn.error` is
 * always the final line — a stream that ends without one means the runner
 * died and the gateway must treat the turn as failed, never as completed.
 */
export type RunnerEvent =
  | { type: 'turn.started'; taskId: string; protocol: number; runnerVersion: string }
  | { type: 'assistant.delta'; taskId: string; text: string }
  | { type: 'tool.call'; taskId: string; tool: string; params: Record<string, string> }
  | { type: 'tool.result'; taskId: string; tool: string; ok: boolean; summary: string }
  | { type: 'artifact.changed'; taskId: string; path: string; kind: 'created' | 'modified' | 'deleted' }
  | {
      type: 'turn.completed';
      taskId: string;
      /** Terminal honesty, per the taxonomy work: completing with zero
       *  artifacts REQUIRES a reason the gateway can show a human. */
      artifacts: number;
      noChangeReason?: string;
      assistantText: string;
    }
  | { type: 'turn.error'; taskId: string; code: string; message: string };

export function parseTurnRequest(body: unknown): TurnRequest {
  const b = body as Partial<TurnRequest>;
  if (b?.protocol !== PROTOCOL_VERSION) {
    throw new ContractError(
      'PROTOCOL_MISMATCH',
      `runner speaks protocol ${PROTOCOL_VERSION}, request said ${String(b?.protocol)}`,
    );
  }
  if (!b.taskId || typeof b.taskId !== 'string') throw new ContractError('BAD_REQUEST', 'taskId required');
  if (!b.workspacePath || typeof b.workspacePath !== 'string')
    throw new ContractError('BAD_REQUEST', 'workspacePath required');
  if (!b.prompt || typeof b.prompt !== 'string') throw new ContractError('BAD_REQUEST', 'prompt required');
  if (!b.provider || typeof b.provider !== 'object')
    throw new ContractError('BAD_REQUEST', 'provider required');
  return b as TurnRequest;
}

export class ContractError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
