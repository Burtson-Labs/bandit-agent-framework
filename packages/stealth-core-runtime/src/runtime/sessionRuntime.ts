import { inferGoal } from '../goalInference';
import type { InferredGoal } from '../internalTypes';
import type { AgentReport, Plan } from '../internalTypes';
import type { AgentGoalOptions, AgentSession, AgentConfiguration } from '../internalTypes';
import type { PlanPreparer, PlanPreparationRunOptions } from './planPreparation';
import { setSessionValue, getSessionValue, cloneSessionData as cloneData } from './sessionData';

interface GoalRunnerLike {
  executePlan(input: {
    plan: Plan;
    goal: string;
    runOptions: AgentGoalOptions;
    agentConfig: AgentConfiguration;
  }): Promise<AgentReport>;
}

export interface SessionRuntimeDeps {
  getWorkspaceRoot(): string;
  getPlanPreparer(): PlanPreparer | undefined;
  getGoalRunner(): GoalRunnerLike | undefined;
  getAgentConfiguration(): AgentConfiguration;
}

export interface SessionRuntime {
  getSessionGoal(): string | undefined;
  getSessionWorkspaceRoot(): string | undefined;
  getLastWorkspaceRoot(): string | undefined;
  getLastPlan(): Plan | undefined;
  getLastGoal(): string | undefined;
  getCurrentGoalInsight(): InferredGoal | undefined;
  getRunOptions(): AgentGoalOptions;
  isPreviewOnly(): boolean;
  runGoalInference(prompt: string, workspaceIndex: string[]): Promise<InferredGoal | undefined>;
  preparePlan(goal: string, options?: AgentGoalOptions): Promise<Plan>;
  executePlan(plan: Plan, goal: string, options?: AgentGoalOptions): Promise<AgentReport>;
  startGoal(goal: string, options?: AgentGoalOptions): Promise<AgentReport>;
  cancel(): void;
  resetCancellation(): void;
  isCancelled(): boolean;
  ensureSession(): AgentSession;
  setContextValue(key: string, value: unknown): void;
  getContextValue<T>(key: string): T | undefined;
  cloneSessionData(): Record<string, unknown> | undefined;
  cloneActiveSessionData(): Record<string, unknown> | undefined;
  getLastSessionSnapshot(goal: string): Record<string, unknown>;
  setLastSessionData(data: Record<string, unknown> | undefined): void;
  initializeSession(goal: string, workspaceRoot: string, data: Record<string, unknown>): void;
  clearSession(): void;
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
  const state: {
    session?: AgentSession;
    lastPlan?: Plan;
    lastGoal?: string;
    lastWorkspaceRoot?: string;
    lastSessionData?: Record<string, unknown>;
    runOptions: AgentGoalOptions;
    currentGoalInsight?: InferredGoal;
    cancelled: boolean;
  } = {
    runOptions: {},
    cancelled: false
  };

  function ensurePlanPreparer(): PlanPreparer {
    const planPreparer = deps.getPlanPreparer();
    if (!planPreparer) {
      throw new Error('Plan preparer not initialised.');
    }
    return planPreparer;
  }

  function ensureGoalRunner(): GoalRunnerLike {
    const goalRunner = deps.getGoalRunner();
    if (!goalRunner) {
      throw new Error('Goal runner not initialised.');
    }
    return goalRunner;
  }

  function ensureSession(): AgentSession {
    if (!state.session) {
      throw new Error('Agent session not initialised.');
    }
    return state.session;
  }

  async function runGoalInference(prompt: string, workspaceIndex: string[]): Promise<InferredGoal | undefined> {
    const normalized = prompt.trim();
    if (!normalized) {
      return undefined;
    }
    try {
      return await inferGoal({ prompt: normalized, workspaceIndex });
    } catch (error) {
      console.warn('Goal inference failed', error);
      return undefined;
    }
  }

  async function preparePlan(goal: string, options?: AgentGoalOptions): Promise<Plan> {
    state.cancelled = false;
    const workspaceRoot = deps.getWorkspaceRoot();
    const runOptions: PlanPreparationRunOptions = {
      lightweight: options?.lightweight === true,
      previewOnly: options?.previewOnly === true,
      modelTier: options?.modelTier
    };
    state.runOptions = { ...runOptions };
    state.session = { goal, workspaceRoot, data: { goal, workspace: { root: workspaceRoot } } };
    state.lastWorkspaceRoot = workspaceRoot;
    if (options?.contextBlock) {
      setSessionValue(state.session.data, 'semantic.context', options.contextBlock);
    }
    const planPreparer = ensurePlanPreparer();
    const { plan, insight } = await planPreparer.run({ goal, workspaceRoot, runOptions });
    state.currentGoalInsight = insight;
    state.lastPlan = plan;
    state.lastGoal = goal;
    return plan;
  }

  async function executePlan(plan: Plan, goal: string, options?: AgentGoalOptions): Promise<AgentReport> {
    const runOptions: AgentGoalOptions = {
      ...state.runOptions,
      ...options
    };
    state.runOptions = runOptions;
    const goalRunner = ensureGoalRunner();
    try {
      return await goalRunner.executePlan({
        plan,
        goal,
        runOptions,
        agentConfig: deps.getAgentConfiguration()
      });
    } finally {
      state.runOptions = {};
    }
  }

  return {
    getSessionGoal: () => state.session?.goal,
    getSessionWorkspaceRoot: () => state.session?.workspaceRoot,
    getLastWorkspaceRoot: () => state.lastWorkspaceRoot,
    getLastPlan: () => state.lastPlan,
    getLastGoal: () => state.lastGoal,
    getCurrentGoalInsight: () => state.currentGoalInsight,
    getRunOptions: () => ({ ...state.runOptions }),
    isPreviewOnly: () => state.runOptions.previewOnly === true,
    runGoalInference,
    preparePlan,
    executePlan,
    startGoal: async (goal, options) => {
      const plan = await preparePlan(goal, options);
      return executePlan(plan, goal, options);
    },
    cancel: () => {
      state.cancelled = true;
    },
    resetCancellation: () => {
      state.cancelled = false;
    },
    isCancelled: () => state.cancelled,
    ensureSession,
    setContextValue: (key, value) => {
      const session = ensureSession();
      setSessionValue(session.data, key, value);
    },
    getContextValue: (key) => getSessionValue(state.session?.data, key),
    cloneSessionData: () => cloneData(state.session?.data),
    cloneActiveSessionData: () => cloneData(state.session?.data),
    getLastSessionSnapshot: (goal) =>
      state.lastSessionData ? JSON.parse(JSON.stringify(state.lastSessionData)) : { goal },
    setLastSessionData: (data) => {
      state.lastSessionData = data;
    },
    initializeSession: (goal, workspaceRoot, data) => {
      state.session = { goal, workspaceRoot, data };
      state.lastWorkspaceRoot = workspaceRoot;
    },
    clearSession: () => {
      state.session = undefined;
    }
  };
}
