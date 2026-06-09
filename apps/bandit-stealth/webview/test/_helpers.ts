/**
 * Shared test helpers for the embedded webview.
 *
 * Built minimal on purpose — every test wires its own tiny mocked-vscode
 * environment, fires the messages it cares about, and asserts on either
 * the captured outgoing `postMessage` calls or the visible DOM. No
 * cross-test fixtures, so a failure points at one cause not five.
 *
 * Mirrors the shape of `packages/agent-core/test/_helpers.ts`.
 */

/** Captures every `vscode.postMessage` call so tests can assert on what the webview sent back to the extension host. */
export interface PostMessageRecorder {
  calls: unknown[];
  reset: () => void;
}

/**
 * Install a global mocked `vscode.postMessage`. Returns a recorder that
 * tests inspect after firing the inbound message. Idempotent — calling
 * twice replaces the previous mock.
 */
export function mockPostMessage(): PostMessageRecorder {
  const calls: unknown[] = [];
  const recorder: PostMessageRecorder = {
    calls,
    reset: () => {
      calls.length = 0;
    }
  };
  // The webview reads `vscode` as a module-level global. Replace it so
  // outbound traffic lands in our array rather than throwing.
  (globalThis as unknown as { vscode: { postMessage: (m: unknown) => void } }).vscode = {
    postMessage: (m: unknown) => {
      calls.push(m);
    }
  };
  return recorder;
}

/**
 * Fire a `message` event on `window` carrying the given payload — the
 * way the extension host delivers state updates to the embedded webview.
 * React's render scheduler is synchronous in test mode, so subsequent
 * assertions can run without waiting for a tick.
 *
 * Wrapped in `@testing-library/react`'s `act` so React batches the state
 * updates the dispatch triggers — including the deferred ones (setTimeout
 * for the toast dismiss schedule, etc.) — without spilling the "update
 * was not wrapped in act(...)" warning into the test log.
 */
export function mockReceiveMessage(message: unknown): void {
  // Lazy-require so the helper file stays importable from non-DOM tests
  // (the state-helper suite) that never set up @testing-library.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { act } = require('@testing-library/react') as typeof import('@testing-library/react');
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

// ─── Fixture builders ──────────────────────────────────────────────────
// Each builder returns a fresh object — never share references across
// tests, so an in-test mutation can't bleed into the next case.

export function buildPermissionPayload(overrides: {
  id?: string;
  tool?: string;
  primary?: string;
  description?: string;
} = {}): {
  type: 'permissionRequest';
  id: string;
  tool: string;
  primary: string;
  description: string;
} {
  return {
    type: 'permissionRequest',
    id: overrides.id ?? 'perm-1',
    tool: overrides.tool ?? 'read_file',
    primary: overrides.primary ?? 'Read packages/agent-core/src/index.ts',
    description: overrides.description ?? 'The agent wants to read a file from the workspace.'
  };
}

export function buildPlanPayload(overrides: {
  goal?: string;
  steps?: Array<{ id: string; title: string; details?: string }>;
} = {}): {
  type: 'agentPlan';
  plan: { goal: string; steps: Array<{ id: string; title: string; details?: string }> };
} {
  return {
    type: 'agentPlan',
    plan: {
      goal: overrides.goal ?? 'Demo plan',
      steps: overrides.steps ?? [
        { id: 'step-1', title: 'First step', details: 'Read the source.' },
        { id: 'step-2', title: 'Second step', details: 'Edit the source.' }
      ]
    }
  };
}

export function buildDiffStreamPayload(overrides: {
  path?: string;
  kind?: 'start' | 'progress' | 'complete';
  content?: string;
} = {}): {
  type: 'agent:diffStream';
  path: string;
  kind: 'start' | 'progress' | 'complete';
  content?: string;
} {
  return {
    type: 'agent:diffStream',
    path: overrides.path ?? 'src/foo.ts',
    kind: overrides.kind ?? 'start',
    content: overrides.content
  };
}

export function buildDiffSnapshotPayload(overrides: {
  path?: string;
  diff?: string;
  added?: number;
  removed?: number;
} = {}): {
  type: 'agent:diffSnapshot';
  path: string;
  diff: string;
  summary: { added: number; removed: number };
} {
  return {
    type: 'agent:diffSnapshot',
    path: overrides.path ?? 'src/foo.ts',
    diff: overrides.diff ?? '@@ -1 +1 @@\n-old\n+new\n',
    summary: {
      added: overrides.added ?? 1,
      removed: overrides.removed ?? 1
    }
  };
}

export function buildBackgroundTaskPayload(overrides: {
  id?: string;
  goal?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  consumed?: boolean;
} = {}): {
  id: string;
  goal: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  iterations: number;
  toolCalls: number;
  consumed: boolean;
} {
  return {
    id: overrides.id ?? 'task-1',
    goal: overrides.goal ?? 'Investigate flaky test',
    status: overrides.status ?? 'running',
    startedAt: Date.now() - 5_000,
    iterations: 2,
    toolCalls: 4,
    consumed: overrides.consumed ?? false
  };
}

export function buildAgentEventPayload(overrides: {
  type?: string;
  stepId?: string;
  runId?: string;
  timestamp?: number;
} = {}): {
  type: string;
  timestamp: number;
  payload: { step?: { id: string; title: string; description: string }; runId?: string };
} {
  return {
    type: overrides.type ?? 'step:start',
    timestamp: overrides.timestamp ?? Date.now(),
    payload: {
      step: overrides.stepId
        ? { id: overrides.stepId, title: `Step ${overrides.stepId}`, description: '' }
        : undefined,
      runId: overrides.runId
    }
  };
}
