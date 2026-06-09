import type { AgentReport, Plan } from '../types';
import type { AgentGoalOptions } from './types';
import type { IUndoManager } from '../internalTypes';

export interface StealthRuntime {
  preparePlan(goal: string, options?: AgentGoalOptions): Promise<Plan>;
  executePlan(plan: Plan, goal: string, options?: AgentGoalOptions): Promise<AgentReport>;
  startGoal(goal: string, options?: AgentGoalOptions): Promise<AgentReport>;
  replayStep(stepId: string, mode?: 'replay' | 'refine'): Promise<void>;
  cancel(): void;
  getUndoManager(): IUndoManager;
}
