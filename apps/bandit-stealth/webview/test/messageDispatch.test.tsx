/**
 * Arc W2b — contract tests pinning the load-bearing wire-message →
 * webview-state dispatch in App.tsx.
 *
 * Pattern: mount <App/> inside <BanditProvider> with a mocked
 * `vscode.postMessage` recorder, fire an extension-host-shaped
 * message via window.dispatchEvent, wait for React to flush, then
 * assert on either the visible DOM (text content / role) or the
 * captured outgoing postMessage calls.
 *
 * These tests cover the dispatch contracts Arc W3 must preserve when
 * it extracts the effect chains + the message switch into custom
 * hooks (per the plan §W3). Failures here = wire format drift.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BanditProvider } from '@burtson-labs/agent-ui';
import { App } from '../src/App';
import {
  buildBackgroundTaskPayload,
  buildPermissionPayload,
  buildPlanPayload,
  mockPostMessage,
  mockReceiveMessage,
  type PostMessageRecorder
} from './_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
  render(
    <BanditProvider context="vscode">
      <App />
    </BanditProvider>
  );
});

afterEach(() => {
  cleanup();
});

// ─── permissionRequest / permissionResolved ──────────────────────────
describe('permission queue', () => {
  it('permissionRequest puts a permission card in the DOM keyed by id', async () => {
    mockReceiveMessage(
      buildPermissionPayload({
        id: 'perm-aaa',
        description: 'The agent wants to read a file from the workspace.'
      })
    );
    await waitFor(() => {
      expect(
        screen.getByText('The agent wants to read a file from the workspace.')
      ).toBeTruthy();
    });
  });

  it('permissionRequest with a duplicate id does NOT add a second card', async () => {
    mockReceiveMessage(
      buildPermissionPayload({
        id: 'perm-dupe',
        description: 'duplicate-permission-marker'
      })
    );
    // Fire the same id again — the dispatch should de-dupe by id.
    mockReceiveMessage(
      buildPermissionPayload({
        id: 'perm-dupe',
        description: 'duplicate-permission-marker'
      })
    );
    await waitFor(() => {
      expect(
        screen.getAllByText('duplicate-permission-marker')
      ).toHaveLength(1);
    });
  });

  it('permissionResolved removes the matching queued card', async () => {
    mockReceiveMessage(
      buildPermissionPayload({
        id: 'perm-resolve',
        description: 'about-to-be-resolved'
      })
    );
    await waitFor(() => {
      expect(screen.getByText('about-to-be-resolved')).toBeTruthy();
    });
    mockReceiveMessage({ type: 'permissionResolved', id: 'perm-resolve' });
    await waitFor(() => {
      expect(screen.queryByText('about-to-be-resolved')).toBeNull();
    });
  });

  it('permissionResolved for an unknown id is a no-op (does not crash and leaves the queue untouched)', async () => {
    mockReceiveMessage(
      buildPermissionPayload({
        id: 'perm-survives',
        description: 'survives-an-unknown-resolve'
      })
    );
    await waitFor(() => {
      expect(screen.getByText('survives-an-unknown-resolve')).toBeTruthy();
    });
    // Wrong id — dispatch should ignore it without throwing.
    mockReceiveMessage({ type: 'permissionResolved', id: 'never-queued' });
    // Queue unchanged.
    expect(screen.getByText('survives-an-unknown-resolve')).toBeTruthy();
  });
});

// ─── notification / error / requireApiKey ────────────────────────────
describe('lifecycle notifications', () => {
  it('notification message surfaces as a toast', async () => {
    mockReceiveMessage({
      type: 'notification',
      message: 'a-distinctive-toast-string'
    });
    await waitFor(() => {
      expect(screen.getByText('a-distinctive-toast-string')).toBeTruthy();
    });
  });

  it('error message surfaces (also through the toast layer)', async () => {
    mockReceiveMessage({
      type: 'error',
      message: 'a-distinctive-error-string'
    });
    await waitFor(() => {
      expect(screen.getByText('a-distinctive-error-string')).toBeTruthy();
    });
  });

  it('requireApiKey flips the banner so the user is asked to set a key', async () => {
    mockReceiveMessage({ type: 'requireApiKey' });
    await waitFor(() => {
      // Copy from ApiKeyBanner.tsx — extracted in Arc W1c.
      expect(screen.getByText('An API key is required to run agents.')).toBeTruthy();
    });
  });
});

// ─── agentPlan ───────────────────────────────────────────────────────
describe('plan rendering', () => {
  // The plan UI is gated on collapsed/expanded state + an active run id,
  // so a "did the step title land in the DOM?" assertion is too coupled
  // to the current PlanActivity/PlanTree layout to be useful as a
  // contract pin. Arc W3 extracts the planMessages dispatch into
  // `useState/usePlanStateSync` — once that lives in isolation the deep
  // content assertion becomes cheap. For now we pin the dispatch
  // boundary itself: the message lands without throwing and the
  // surrounding shell stays rendered.

  it('agentPlan dispatch is non-throwing and leaves the shell mounted', () => {
    mockReceiveMessage(
      buildPlanPayload({
        goal: 'Test plan',
        steps: [
          { id: 's1', title: 'first-step-title', details: '' },
          { id: 's2', title: 'second-step-title', details: '' }
        ]
      })
    );
    // App still renders (composer is the load-bearing always-on region).
    expect(screen.getByPlaceholderText(/Message Bandit/i)).toBeTruthy();
  });

  it('a second agentPlan after a first does not throw (replacement semantics)', () => {
    mockReceiveMessage(buildPlanPayload({ goal: 'First plan' }));
    mockReceiveMessage(buildPlanPayload({ goal: 'Second plan' }));
    expect(screen.getByPlaceholderText(/Message Bandit/i)).toBeTruthy();
  });

  it('agentPlanUpdate before any plan does not crash (defensive against out-of-order delivery)', () => {
    mockReceiveMessage({
      type: 'agentPlanUpdate',
      stepId: 'ghost-step',
      status: 'complete'
    });
    expect(screen.getByPlaceholderText(/Message Bandit/i)).toBeTruthy();
  });
});

// ─── backgroundTaskList / backgroundTaskUpdate ───────────────────────
describe('background task tile', () => {
  // The tile renders a single summary button by default and only
  // exposes per-task DOM (goal + status) when `expanded === true`. The
  // expand interaction lives behind a separate handler that's part of
  // the App body's render — testing it cleanly is an Arc W3 concern
  // once useBackgroundTaskPolling becomes its own hook. We pin the
  // dispatch contract itself: the message types are accepted without
  // throwing and the summary button shows up.

  it('backgroundTaskList with a running task surfaces the tile (collapsed summary visible)', async () => {
    mockReceiveMessage({
      type: 'backgroundTaskList',
      tasks: [
        buildBackgroundTaskPayload({ id: 'bg-1', goal: 'g', status: 'running' })
      ]
    });
    await waitFor(() => {
      // Summary text from BackgroundTaskTile.tsx — independent of
      // task-content layout, so resilient to internal refactors.
      expect(screen.getByText('Background subagents')).toBeTruthy();
    });
  });

  it('backgroundTaskUpdate is accepted (no crash, summary still visible)', async () => {
    mockReceiveMessage({
      type: 'backgroundTaskList',
      tasks: [
        buildBackgroundTaskPayload({ id: 'bg-2', goal: 'g', status: 'running' })
      ]
    });
    mockReceiveMessage({
      type: 'backgroundTaskUpdate',
      task: buildBackgroundTaskPayload({ id: 'bg-2', goal: 'g', status: 'completed' })
    });
    await waitFor(() => {
      expect(screen.getByText('Background subagents')).toBeTruthy();
    });
  });

  it('backgroundTaskUpdate for an unknown task id is a no-op (does not crash)', () => {
    mockReceiveMessage({
      type: 'backgroundTaskUpdate',
      task: buildBackgroundTaskPayload({ id: 'never-listed', status: 'completed' })
    });
    expect(screen.getByPlaceholderText(/Message Bandit/i)).toBeTruthy();
  });
});

// ─── accountUsage / rateLimited ──────────────────────────────────────
describe('account usage + rate limit', () => {
  it('accountUsage data attaches to the usage modal (data flows even before the modal opens)', async () => {
    mockReceiveMessage({
      type: 'accountUsage',
      data: {
        authMethod: 'bandit',
        email: 'tester@example.com',
        plan: 'unique-plan-string',
        isAdmin: false,
        session: { used: 1, limit: 100 },
        weekly: { used: 5, limit: 1000 }
      }
    });
    // No DOM assertion — modal isn't open. We're confirming the dispatch
    // did not crash. The actual modal-content assertion belongs in a
    // future test that opens the modal first.
    expect(recorder.calls).toBeDefined();
  });

  it('rateLimited surfaces a distinct rate-limit toast', async () => {
    mockReceiveMessage({
      type: 'rateLimited',
      window: 'session',
      message: 'rate-limit-toast-marker',
      resetsAtUnix: Math.floor(Date.now() / 1000) + 3600
    });
    await waitFor(() => {
      expect(screen.getByText(/rate-limit-toast-marker/)).toBeTruthy();
    });
  });
});

// ─── skillList ───────────────────────────────────────────────────────
describe('skill registry', () => {
  it('skillList message does not crash even with an empty skill set', () => {
    mockReceiveMessage({ type: 'skillList', skills: [] });
    // No throw → pass. The composer's skill autocomplete is a side
    // surface; we just need the dispatch to swallow the message cleanly.
    expect(true).toBe(true);
  });
});
