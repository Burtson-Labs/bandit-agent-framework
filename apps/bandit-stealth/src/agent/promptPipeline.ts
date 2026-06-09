import type { AgentReport, Plan } from '@burtson-labs/stealth-core-runtime';
import type { StealthAgentRuntime } from './agentRuntime';

export type PromptMode = 'ask' | 'agent';

export interface PromptPipelineOptions {
  previewOnly?: boolean;
  lightweight?: boolean;
}

const normalizePrompt = (prompt: string): string => prompt.trim();

const defaultOptionsForMode = (mode: PromptMode): PromptPipelineOptions => ({
  previewOnly: mode === 'ask',
  lightweight: mode === 'ask'
});

export class PromptPipeline {
  constructor(private readonly runtime: StealthAgentRuntime) {}

  public async prepare(prompt: string, mode: PromptMode, options?: PromptPipelineOptions): Promise<Plan> {
    const goal = normalizePrompt(prompt);
    const merged = { ...defaultOptionsForMode(mode), ...options };
    return this.runtime.preparePlan(goal, merged);
  }

  public async execute(prompt: string, mode: PromptMode, options?: PromptPipelineOptions): Promise<AgentReport> {
    const goal = normalizePrompt(prompt);
    const merged = { ...defaultOptionsForMode(mode), ...options };
    const plan = await this.runtime.preparePlan(goal, merged);
    return this.runtime.executePlan(plan, goal, merged);
  }

  public async preview(prompt: string): Promise<AgentReport> {
    return this.execute(prompt, 'ask', { previewOnly: true, lightweight: true });
  }
}
