import type {
  AgentRuntime,
  AgentPlan,
  AgentReport,
  AgentExecutionResult,
  PlanOptions,
  ExecuteOptions,
  CreateAgentRuntimeOptions
} from "@burtson-labs/agent-core";
import {
  createAgentRuntime
} from "@burtson-labs/agent-core";

export interface GithubAdapterOptions extends CreateAgentRuntimeOptions {
  repository?: string;
  headSha?: string;
  workflowName?: string;
}

export interface GithubCheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

export interface GithubCheckRunPayload {
  name: string;
  head_sha?: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "neutral" | "failure";
  output: GithubCheckRunOutput;
  external_id?: string;
  details_url?: string;
}

export interface GithubAdapter {
  runtime: AgentRuntime;
  plan(goal: string, options?: PlanOptions): Promise<AgentPlan>;
  execute(options?: ExecuteOptions): Promise<AgentExecutionResult[]>;
  report(metadata?: Record<string, unknown>): Promise<AgentReport>;
  toCheckRun(report: AgentReport): GithubCheckRunPayload;
}

export const createGithubAdapter = (options: GithubAdapterOptions = {}): GithubAdapter => {
  const runtime = createAgentRuntime(options);

  const toCheckRun = (report: AgentReport): GithubCheckRunPayload => {
    const hasFailures = report.steps.some((step) => step.status === "failed");
    const summaryLines = report.steps.map((step) => `- ${step.stepId}: ${step.status}`);

    const output: GithubCheckRunOutput = {
      title: options.workflowName ?? "Bandit Agent Report",
      summary: report.summary,
      text: summaryLines.join("\n")
    };

    return {
      name: options.workflowName ?? "bandit-agent",
      head_sha: options.headSha,
      status: "completed",
      conclusion: hasFailures ? "failure" : "success",
      output
    };
  };

  return {
    runtime,
    plan: (goal: string, planOptions?: PlanOptions) => runtime.plan(goal, planOptions),
    execute: (executeOptions?: ExecuteOptions) => runtime.execute(executeOptions),
    report: (metadata?: Record<string, unknown>) => runtime.report(metadata),
    toCheckRun
  };
};
