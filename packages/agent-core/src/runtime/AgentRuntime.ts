import type {
  AgentContext,
  AgentEvent,
  AgentExecutionResult,
  AgentPlan,
  AgentStep,
  AgentStepStatus,
  AgentReport,
  AgentDiff
} from "../types/agent";
import type { ProviderChatOptions, ProviderClient } from "../providers/provider-client";
import { AgentEventEmitter } from "../utils/event-emitter";

export interface AgentTelemetry {
  track(event: AgentEvent): void | Promise<void>;
}

export interface AgentLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface AgentRuntimeOptions {
  provider: ProviderClient;
  context?: AgentContext;
  logger?: AgentLogger;
  telemetry?: AgentTelemetry;
  clock?: () => number;
  stepExecutor?: StepExecutor;
}

export interface PlanOptions {
  context?: Partial<AgentContext>;
  metadata?: Record<string, unknown>;
}

export interface ExecuteOptions {
  stepExecutor?: StepExecutor;
  metadata?: Record<string, unknown>;
}

export interface StepExecutorContext {
  step: AgentStep;
  plan: AgentPlan;
  context: AgentContext;
  metadata?: Record<string, unknown>;
  emitEvent: (type: string, payload?: unknown) => void;
  logger: AgentLogger;
}

export interface StepExecutorOutput {
  status?: AgentStepStatus;
  diff?: AgentDiff[];
  logs?: string[];
  metadata?: Record<string, unknown>;
}

export type StepExecutor = (context: StepExecutorContext) => Promise<StepExecutorOutput>;

const defaultLogger: AgentLogger = {
  debug: (...args: unknown[]) => {
    const env = typeof process !== "undefined" ? process.env : undefined;
    if (env?.BANDIT_AGENT_DEBUG) {
      console.debug("[agent-core]", ...args);
    }
  },
  info: (...args: unknown[]) => console.info("[agent-core]", ...args),
  warn: (...args: unknown[]) => console.warn("[agent-core]", ...args),
  error: (...args: unknown[]) => console.error("[agent-core]", ...args)
};

const defaultStepExecutor: StepExecutor = async ({ step }): Promise<StepExecutorOutput> => {
  return {
    status: step.status === "failed" ? "failed" : "completed",
    logs: [`No-op executor completed step "${step.title}".`]
  };
};

export class AgentRuntime extends AgentEventEmitter {
  private context: AgentContext;
  private activePlan: AgentPlan | null = null;
  private executionResults: AgentExecutionResult[] = [];
  private planStartedAt: number | null = null;
  private executeStartedAt: number | null = null;

  private readonly telemetry?: AgentTelemetry;
  private readonly logger: AgentLogger;
  private readonly clock: () => number;
  private readonly provider: ProviderClient;
  private readonly configuredStepExecutor?: StepExecutor;

  constructor(options: AgentRuntimeOptions) {
    super();
    this.provider = options.provider;
    this.context =
      options.context ??
      ({
        files: [],
        goals: []
      } as AgentContext);

    this.logger = options.logger ?? defaultLogger;
    this.telemetry = options.telemetry;
    this.clock = options.clock ?? (() => Date.now());
    this.configuredStepExecutor = options.stepExecutor;
  }

  getContext(): AgentContext {
    return this.context;
  }

  setContext(context: AgentContext): void {
    this.context = context;
    this.emitAgentEvent("context:updated", { context });
  }

  updateContext(patch: Partial<AgentContext>): void {
    this.context = { ...this.context, ...patch };
    this.emitAgentEvent("context:updated", { context: this.context });
  }

  getPlan(): AgentPlan | null {
    return this.activePlan;
  }

  getExecutionResults(): AgentExecutionResult[] {
    return this.executionResults.slice();
  }

  async plan(goal: string, options: PlanOptions = {}): Promise<AgentPlan> {
    this.logger.info("Starting plan for goal:", goal);
    this.planStartedAt = this.clock();
    this.executionResults = [];
    const mergedContext = {
      ...this.context,
      ...options.context,
      goals: Array.from(new Set([...(this.context.goals ?? []), goal]))
    };

    this.context = mergedContext;

    this.emitAgentEvent("plan:start", { goal, context: mergedContext });

    const modelTier = options.metadata?.modelTier as string | undefined;
    const prompt = buildPlanPrompt(goal, mergedContext, modelTier);
    const providerOptions: ProviderChatOptions = {
      mode: "plan",
      metadata: options.metadata,
      context: mergedContext
    };

    const stream = this.provider.chat(prompt, providerOptions);
    let aggregated = "";

    for await (const chunk of stream) {
      aggregated += chunk;
      this.emitAgentEvent("plan:chunk", { chunk });
    }

    let plan = tryParsePlan(aggregated, goal, this.clock);

    // If plan parsing failed (version "0.1.0" = fallback), retry once with schema reminder
    if (plan.version === "0.1.0") {
      this.logger.warn("Plan parse failed on first attempt — retrying with schema reminder.");
      this.emitAgentEvent("plan:parse_retry", { goal, rawResponse: aggregated });
      const retryPrompt = buildPlanPromptWithReminder(goal, mergedContext, aggregated, modelTier);
      const retryStream = this.provider.chat(retryPrompt, providerOptions);
      let retryAggregated = "";
      for await (const chunk of retryStream) {
        retryAggregated += chunk;
        this.emitAgentEvent("plan:chunk", { chunk });
      }
      const retryPlan = tryParsePlan(retryAggregated, goal, this.clock);
      if (retryPlan.version !== "0.1.0") {
        plan = retryPlan;
      } else {
        this.logger.error("Plan parse failed after retry. Using heuristic fallback.");
        this.emitAgentEvent("plan:parse_failed", {
          goal,
          rawResponse: retryAggregated,
          error: "Model did not return valid JSON plan after 2 attempts."
        });
      }
    }

    this.activePlan = plan;

    this.emitAgentEvent("plan:complete", { plan });
    await this.trackTelemetry("plan:complete", { goal, provider: this.provider.name });
    return plan;
  }

  async execute(options: ExecuteOptions = {}): Promise<AgentExecutionResult[]> {
    if (!this.activePlan) {
      throw new Error("Cannot execute without an existing plan. Call plan() first.");
    }

    this.executeStartedAt = this.clock();
    this.executionResults = [];
    const executor = options.stepExecutor ?? this.configuredStepExecutor ?? defaultStepExecutor;

    const results: AgentExecutionResult[] = [];
    for (const step of this.activePlan.steps) {
      const start = this.clock();
      this.emitAgentEvent("step:start", { step });
      this.logger.info(`Executing step ${step.id}: ${step.title}`);
      let output: StepExecutorOutput;

      try {
        output = await executor({
          step,
          plan: this.activePlan,
          context: this.context,
          metadata: options.metadata,
          emitEvent: (type, payload) => this.emitAgentEvent(type, payload),
          logger: this.logger
        });
      } catch (error) {
        this.logger.error(`Step ${step.id} failed`, error);
        output = {
          status: "failed",
          logs: [String(error instanceof Error ? error.message : error)]
        };
      }

      const status: AgentStepStatus = output.status ?? "completed";

      const executionResult: AgentExecutionResult = {
        stepId: step.id,
        status,
        diff: output.diff,
        logs: output.logs,
        metadata: {
          ...(output.metadata ?? {}),
          durationMs: this.clock() - start
        }
      };

      results.push(executionResult);
      this.executionResults.push(executionResult);

      if (executionResult.diff?.length) {
        this.emitAgentEvent("diff:apply", { step, diff: executionResult.diff });
      }

      this.emitAgentEvent("step:complete", { step, result: executionResult });
    }

    await this.trackTelemetry("execute:complete", {
      planId: this.activePlan.id,
      provider: this.provider.name,
      results
    });

    return results;
  }

  async report(metadata: Record<string, unknown> = {}): Promise<AgentReport> {
    if (!this.activePlan) {
      throw new Error("Cannot report without a plan. Call plan() before report().");
    }

    const startedAt = this.planStartedAt ?? this.clock();
    const completedAt = this.clock();

    const providerStream = this.provider.chat(
      buildReportPrompt(this.activePlan, this.executionResults),
      {
        mode: "report",
        metadata,
        context: this.context
      }
    );

    let summary = "";
    for await (const chunk of providerStream) {
      summary += chunk;
      this.emitAgentEvent("report:chunk", { chunk });
    }

    if (!summary.trim()) {
      summary = `Report for goal "${this.activePlan.goal}" generated without provider output.`;
    }

    const report: AgentReport = {
      goal: this.activePlan.goal,
      summary,
      steps: this.executionResults,
      startedAt,
      completedAt,
      metadata: {
        ...metadata,
        provider: this.provider.name
      }
    };

    this.emitAgentEvent("report:complete", { report });
    await this.trackTelemetry("report:complete", { goal: this.activePlan.goal });
    return report;
  }

  private emitAgentEvent(type: string, payload?: unknown): void {
    const event: AgentEvent = {
      type,
      payload,
      timestamp: this.clock()
    };

    this.emit(type, event);
  }

  private async trackTelemetry(type: string, payload?: unknown): Promise<void> {
    const event: AgentEvent = {
      type,
      payload,
      timestamp: this.clock()
    };
    try {
      await this.telemetry?.track(event);
    } catch (error) {
      this.logger.warn("Telemetry dispatch failed", error);
    }
  }
}

function buildPlanPrompt(goal: string, context: AgentContext, modelTier?: string): string {
  if (modelTier === "small") {
    // Small / 4B models: minimal prompt — every token is precious and brevity
    // reduces the chance of the model producing prose instead of JSON.
    return [
      "Respond with JSON only. Start with { and end with }. No other text.",
      "",
      'Schema: {"goal":string,"summary":string,"steps":[{"id":string,"title":string}]}',
      "",
      'Example: {"goal":"Fix login","summary":"Patch auth handler","steps":[{"id":"step-1","title":"Edit auth.ts"}]}',
      "",
      `Goal: ${goal}`,
    ].join("\n");
  }

  // Medium / large models: fuller prompt with description field and file context.
  const fileLimit = modelTier === "large" ? 8 : 5;
  const files = context.files?.slice(0, fileLimit).join(", ") || "none";
  return [
    "You are Bandit Agent Runtime planner. Respond with JSON only — no markdown, no explanation.",
    "",
    "Return a JSON object exactly matching this schema:",
    '{ "goal": string, "summary": string, "steps": [ { "id": string, "title": string, "description": string } ] }',
    "",
    "Example:",
    '{ "goal": "Add TypeScript support", "summary": "Install TS and create tsconfig", "steps": [',
    '  { "id": "step-1", "title": "Install TypeScript", "description": "Run npm install -D typescript" },',
    '  { "id": "step-2", "title": "Create tsconfig.json", "description": "Write default tsconfig" }',
    "]}",
    "",
    `Goal: ${goal}`,
    `Relevant files: ${files}`,
  ].join("\n");
}

function buildPlanPromptWithReminder(goal: string, context: AgentContext, previousResponse: string, modelTier?: string): string {
  const snippet = previousResponse.slice(0, 200).replace(/\n/g, " ");

  if (modelTier === "small") {
    return [
      "JSON only. No explanation. Your last response was not valid JSON.",
      `Bad response: ${snippet}`,
      "",
      'Schema: {"goal":string,"summary":string,"steps":[{"id":string,"title":string}]}',
      "",
      `Goal: ${goal}`,
      "Start with { and end with }",
    ].join("\n");
  }

  const fileLimit = modelTier === "large" ? 8 : 5;
  const files = context.files?.slice(0, fileLimit).join(", ") || "none";
  return [
    "You are Bandit Agent Runtime planner. Your previous response was not valid JSON.",
    `Previous response (first 200 chars): ${snippet}`,
    "",
    "You MUST respond with ONLY a JSON object. No markdown code fences. No explanation. No other text.",
    "Required schema:",
    '{ "goal": string, "summary": string, "steps": [ { "id": string, "title": string, "description": string } ] }',
    "",
    `Goal: ${goal}`,
    `Relevant files: ${files}`,
    "",
    "JSON only. Start your response with { and end with }",
  ].join("\n");
}

function buildReportPrompt(plan: AgentPlan, results: AgentExecutionResult[]): string {
  return [
    "You are Bandit Agent Runtime reporter.",
    "Generate a concise execution summary as markdown.",
    "Focus on what changed and next steps.",
    "Plan:",
    JSON.stringify(plan, null, 2),
    "Results:",
    JSON.stringify(results, null, 2)
  ].join("\n");
}

/**
 * Attempt to extract and parse a JSON plan from a raw LLM response.
 * Handles: clean JSON, JSON wrapped in markdown code fences, JSON with leading/trailing text.
 * Returns null on failure instead of silently falling back.
 */
function extractJsonFromResponse(raw: string): unknown | null {
  const trimmed = raw.trim();

  // Direct JSON parse
  try { return JSON.parse(trimmed); } catch { /* continue */ }

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  // Find first { ... } block in the response
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try { return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)); } catch { /* continue */ }
  }

  return null;
}

function tryParsePlan(raw: string, goal: string, clock: () => number): AgentPlan {
  const now = clock();
  const parsed = extractJsonFromResponse(raw);

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).steps)) {
    return buildFallbackPlan(goal, now);
  }

  const data = parsed as Record<string, unknown>;
  const steps: AgentStep[] = (data.steps as Partial<AgentStep>[]).map((step, index) => ({
    id: step.id ?? `step-${index + 1}`,
    title: step.title ?? `Step ${index + 1}`,
    description: step.description ?? "",
    status: step.status ?? "pending",
    metadata: step.metadata
  }));

  return {
    id: typeof data.id === "string" ? data.id : `plan-${now}`,
    goal: typeof data.goal === "string" ? data.goal : goal,
    summary: typeof data.summary === "string" ? data.summary : `Plan for goal: ${goal}`,
    steps,
    createdAt: now,
    version: "1.0.0"
  };
}

function buildFallbackPlan(goal: string, timestamp: number): AgentPlan {
  const steps = heuristicallyBreakGoal(goal).map((description, index) => ({
    id: `step-${index + 1}`,
    title: titleCase(description),
    description,
    status: "pending" as AgentStepStatus
  }));

  return {
    id: `plan-${timestamp}`,
    goal,
    summary: `Fallback plan generated for goal: ${goal}`,
    steps,
    createdAt: timestamp,
    version: "0.1.0"
  };
}

function heuristicallyBreakGoal(goal: string): string[] {
  const delimiters = [/ and /i, / then /i, /, /, / -> /];
  for (const delimiter of delimiters) {
    if (delimiter.test(goal)) {
      return goal.split(delimiter).map((part) => part.trim()).filter(Boolean);
    }
  }

  return [goal];
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
