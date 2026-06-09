/**
 * Contract tests for `dispatchAgentEnvironmentMessage` — the bridge
 * that routes `agent:*` runtime events into ConversationService
 * mutations + webview broadcasts.
 *
 * What we pin (each test maps to a load-bearing behavior the prompt
 * called out before the extraction):
 *
 *  1. `agent:plan` with a non-empty plan starts a run, sets
 *     `environmentService.setRunContext` with the new run id, and
 *     emits BOTH `agentPlan` and `agentPlanHistory` to the webview.
 *  2. `agent:plan` with a null/empty plan clears the active plan,
 *     fires `setRunContext` with `runId: undefined`, and still emits
 *     both webview messages — the webview's plan card relies on this
 *     to clear its UI.
 *  3. `agent:planUpdate` merges step state and emits `agentPlanUpdate`
 *     + `agentPlanHistory`.
 *  4. `agent:telemetry` without a `stepId` skips the step merge but
 *     STILL emits `agentTelemetry` — fire-and-forget overlay support.
 *  5. `agent:final` writes evaluation + completedAt onto the active
 *     run when one exists; with no active run, the bridge no-ops on
 *     the conversation side but doesn't throw.
 *  6. Non-`agent:` prefixed messages are ignored silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '../../src/provider/context';
import type { Plan } from '../../src/services/conversationTypes';
import type { OutgoingMessage } from '../../src/messages';
import type { ConversationService } from '../../src/services/conversationService';

vi.mock('vscode', () => ({}));

const envMock = vi.hoisted(() => ({
  setRunContextCalls: [] as Array<{ conversationId: string; conversationName: string; runId: string | undefined }>
}));

vi.mock('../../src/agent/environmentService', () => ({
  environmentService: {
    setRunContext: (context: { conversationId: string; conversationName: string; runId?: string }) => {
      envMock.setRunContextCalls.push({
        conversationId: context.conversationId,
        conversationName: context.conversationName,
        runId: context.runId
      });
    }
  }
}));

import { dispatchAgentEnvironmentMessage } from '../../src/agent/agentEnvironmentBridge';
import { ConversationService as RealConversationService } from '../../src/services/conversationService';

function makePlan(goal: string, stepCount = 2): Plan {
  return {
    goal,
    steps: Array.from({ length: stepCount }, (_, i) => ({ id: `step-${i + 1}`, title: `Step ${i + 1}` }))
  } as Plan;
}

function makeCtx(): { ctx: ProviderContext; conversations: ConversationService; posted: OutgoingMessage[] } {
  const store = new Map<string, unknown>();
  const conversations = new RealConversationService({
    storage: {
      get<T>(key: string, defaultValue: T): T {
        return (store.has(key) ? store.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown) {
        store.set(key, value);
        return Promise.resolve();
      }
    },
    historyStorageKey: 'history',
    legacyStorageKey: 'legacy'
  });
  conversations.ensureActive();

  const posted: OutgoingMessage[] = [];
  const ctx = {
    conversations,
    postMessage: (message: OutgoingMessage) => { posted.push(message); }
  } as unknown as ProviderContext;
  return { ctx, conversations, posted };
}

const enabledArtifactsDeps = { arePlanArtifactsEnabled: () => true };
const disabledArtifactsDeps = { arePlanArtifactsEnabled: () => false };

beforeEach(() => {
  envMock.setRunContextCalls.length = 0;
});

describe('dispatchAgentEnvironmentMessage', () => {
  it('agent:plan with a non-empty plan starts a run, fires setRunContext with the run id, and emits both webview messages', async () => {
    const { ctx, conversations, posted } = makeCtx();
    const plan = makePlan('build feature');

    await dispatchAgentEnvironmentMessage(ctx, enabledArtifactsDeps, { type: 'agent:plan', plan });

    const conversation = conversations.getCurrent()!;
    expect(conversation.planRuns).toHaveLength(1);
    const run = conversation.planRuns[0];
    expect(run.goal).toBe('build feature');
    expect(run.artifactsPath).toBeTruthy();
    expect(conversations.activePlanRunId).toBe(run.id);

    expect(envMock.setRunContextCalls).toHaveLength(1);
    expect(envMock.setRunContextCalls[0].runId).toBe(run.id);
    expect(envMock.setRunContextCalls[0].conversationId).toBe(conversation.id);

    const types = posted.map((m) => m.type);
    expect(types).toEqual(['agentPlan', 'agentPlanHistory']);
    const agentPlan = posted[0] as Extract<OutgoingMessage, { type: 'agentPlan' }>;
    expect(agentPlan.activeRunId).toBe(run.id);
    expect(agentPlan.history).toHaveLength(1);
  });

  it('agent:plan with a null plan clears the active pointer, fires setRunContext with runId undefined, and still emits both messages', async () => {
    const { ctx, conversations, posted } = makeCtx();
    // Seed an active run so we can confirm clearActivePlan ran.
    conversations.startPlanRun({ plan: makePlan('seed'), artifactsEnabled: false });
    expect(conversations.activePlanRunId).toBeTruthy();

    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, { type: 'agent:plan', plan: null });

    expect(conversations.activePlanRunId).toBeUndefined();
    expect(envMock.setRunContextCalls).toHaveLength(1);
    expect(envMock.setRunContextCalls[0].runId).toBeUndefined();

    const types = posted.map((m) => m.type);
    expect(types).toEqual(['agentPlan', 'agentPlanHistory']);
  });

  it('agent:planUpdate merges step state and emits agentPlanUpdate + agentPlanHistory', async () => {
    const { ctx, conversations, posted } = makeCtx();
    conversations.startPlanRun({ plan: makePlan('update'), artifactsEnabled: false });
    posted.length = 0;

    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, {
      type: 'agent:planUpdate',
      stepId: 'step-1',
      state: 'running',
      meta: { summary: 'kickoff', durationMs: 12, tokens: 5 }
    });

    const merged = conversations.planStates.get('step-1');
    expect(merged?.state).toBe('running');
    expect(merged?.summary).toBe('kickoff');
    expect(merged?.tokens).toBe(5);

    const types = posted.map((m) => m.type);
    expect(types).toEqual(['agentPlanUpdate', 'agentPlanHistory']);
    const update = posted[0] as Extract<OutgoingMessage, { type: 'agentPlanUpdate' }>;
    expect(update.stepId).toBe('step-1');
    expect(update.status).toBe('running');
    expect(update.meta?.tokens).toBe(5);
  });

  it('agent:telemetry without a stepId skips the step merge but still emits agentTelemetry', async () => {
    const { ctx, conversations, posted } = makeCtx();
    conversations.startPlanRun({ plan: makePlan('telemetry'), artifactsEnabled: false });
    posted.length = 0;

    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, {
      type: 'agent:telemetry',
      telemetry: 'tokens',
      durationMs: 99,
      tokens: 17
      // no stepId
    });

    expect(conversations.planStates.size).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('agentTelemetry');
  });

  it('agent:final writes evaluation onto the active run and emits agentPlanHistory; no-active-run is a graceful no-op', async () => {
    const { ctx, conversations, posted } = makeCtx();
    const run = conversations.startPlanRun({ plan: makePlan('finalize'), artifactsEnabled: false })!;
    posted.length = 0;

    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, {
      type: 'agent:final',
      report: { evaluation: { success: true, confidence: 0.9, feedback: 'looks good' } }
    });

    expect(run.evaluation).toEqual({ success: true, confidence: 0.9, feedback: 'looks good' });
    expect(typeof run.completedAt).toBe('number');
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('agentPlanHistory');

    // No-active-run path: clear the pointer and confirm the bridge
    // doesn't post (or throw) when there's nothing to write to.
    conversations.clearActivePlan();
    posted.length = 0;
    // Start over with a brand-new conversation that has no planRuns.
    const noPlanCtx = makeCtx();
    await dispatchAgentEnvironmentMessage(noPlanCtx.ctx, disabledArtifactsDeps, {
      type: 'agent:final',
      report: { evaluation: { success: false, confidence: 0.1, feedback: 'nope' } }
    });
    expect(noPlanCtx.posted).toHaveLength(0);
  });

  it('non-agent message types are ignored silently', async () => {
    const { ctx, posted } = makeCtx();
    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, { type: 'somethingElse' });
    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, null);
    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, undefined);
    await dispatchAgentEnvironmentMessage(ctx, disabledArtifactsDeps, 'string-payload');
    expect(posted).toHaveLength(0);
    expect(envMock.setRunContextCalls).toHaveLength(0);
  });
});
