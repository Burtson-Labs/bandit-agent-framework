import {
  createAgentRuntime,
  type AgentPlan,
  type PlanOptions,
  type AgentRuntime as FrameworkAgentRuntime,
  type ProviderChatOptions,
  type ProviderClient
} from '@burtson-labs/agent-core';
import { plannerService } from './plannerService';
import type { Plan } from '@burtson-labs/stealth-core-runtime';

class StealthPlanProvider implements ProviderClient {
  public readonly name = 'stealth-plan-provider';

  constructor(private readonly planner = plannerService) {}

  public async *chat(prompt: string, options?: ProviderChatOptions): AsyncIterable<string> {
    const goal = this.extractGoal(prompt);
    const contextFiles = extractContextFiles(prompt);
    const baseMetadata = options?.metadata ?? {};
    const mergedContextFiles = mergeContextFiles(baseMetadata, contextFiles);
    const metadata = mergedContextFiles
      ? { ...baseMetadata, contextFiles: mergedContextFiles }
      : baseMetadata;
    const plan = await this.planner.generatePlan(goal, { metadata });
    const payload = this.toAgentPlan(plan);
    yield JSON.stringify(payload);
  }

  private extractGoal(prompt: string): string {
    const match = prompt.match(/Goal:\s*([\s\S]*?)(?:\nContext:|$)/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    return prompt.trim();
  }


  private toAgentPlan(plan: Plan): AgentPlan {
    const timestamp = Date.now();
    return {
      id: plan.goal ? `stealth-plan-${timestamp}` : `stealth-plan-${timestamp}`,
      goal: plan.goal,
      summary: `Bandit Stealth plan for "${plan.goal}"`,
      steps: plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        description: step.details,
        metadata: {
          command: step.command,
          targetFile: step.targetFile,
          action: step.action,
          stepMetadata: step.metadata,
          stealth: step
        }
      })),
      createdAt: timestamp,
      version: 'stealth-1.0.0'
    };
  }
}

export class StealthPlannerAgent {
  private readonly runtime: FrameworkAgentRuntime;

  constructor(provider = plannerService) {
    this.runtime = createAgentRuntime({
      provider: new StealthPlanProvider(provider)
    });
  }

  public async createPlan(goal: string, options: PlanOptions): Promise<AgentPlan> {
    return this.runtime.plan(goal, options);
  }

  public getRuntime(): FrameworkAgentRuntime {
    return this.runtime;
  }
}

const CONTEXT_FILE_PATTERN = /\[File:\s*([^\]\n]+)\]/gi;
const normalizeContextPath = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/\\+/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('..')) {
    return undefined;
  }
  return normalized;
};

const extractContextFiles = (prompt: string): string[] => {
  if (!prompt) {
    return [];
  }
  const matches: string[] = [];
  let result: RegExpExecArray | null;
  while ((result = CONTEXT_FILE_PATTERN.exec(prompt)) !== null) {
    if (result[1]) {
      matches.push(result[1]);
    }
  }
  const normalized = matches
    .map((entry) => normalizeContextPath(entry))
    .filter((entry): entry is string => Boolean(entry));
  const unique = normalized.filter((entry, index) => normalized.indexOf(entry) === index);
  return unique;
};

const mergeContextFiles = (metadata: Record<string, unknown>, contextFiles: string[]): string[] | undefined => {
  const baseValue = metadata['contextFiles'];
  const base = Array.isArray(baseValue)
    ? baseValue.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const combined = [...base, ...contextFiles];
  const normalized = combined
    .map((entry) => normalizeContextPath(entry))
    .filter((entry): entry is string => Boolean(entry));
  const unique = normalized.filter((entry, index) => normalized.indexOf(entry) === index);
  return unique.length > 0 ? unique : undefined;
};
