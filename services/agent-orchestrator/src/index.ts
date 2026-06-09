import type {
  AgentPlan,
  AgentReport,
  AgentExecutionResult,
  PlanOptions
} from "@burtson-labs/agent-core";
import { createNodeAdapter } from "@burtson-labs/agent-adapters-node";

export interface OrchestratorJob {
  id: string;
  goal: string;
  planOptions?: PlanOptions;
}

export interface OrchestratorResult {
  plan: AgentPlan;
  results: AgentExecutionResult[];
  report: AgentReport;
}

export class AgentOrchestrator {
  async run(job: OrchestratorJob): Promise<OrchestratorResult> {
    const adapter = createNodeAdapter();
    const plan = await adapter.plan(job.goal, job.planOptions);
    const results = await adapter.execute();
    const report = await adapter.report({ jobId: job.id });

    return {
      plan,
      results,
      report
    };
  }
}
