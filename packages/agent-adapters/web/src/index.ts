import type {
  AgentRuntime,
  AgentPlan,
  AgentReport,
  AgentExecutionResult,
  PlanOptions,
  ExecuteOptions,
  AgentEvent,
  CreateAgentRuntimeOptions
} from "@burtson-labs/agent-core";
import {
  createAgentRuntime
} from "@burtson-labs/agent-core";

export interface WebAdapter {
  runtime: AgentRuntime;
  plan(goal: string, options?: PlanOptions): Promise<AgentPlan>;
  execute(options?: ExecuteOptions): Promise<AgentExecutionResult[]>;
  report(metadata?: Record<string, unknown>): Promise<AgentReport>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface MinimalEventTarget {
  dispatchEvent(event: unknown): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface WebAdapterOptions extends CreateAgentRuntimeOptions {
  target?: MinimalEventTarget;
  eventName?: string;
}

interface MinimalCustomEvent<T = unknown> {
  detail: T;
}

interface MinimalCustomEventConstructor {
  new (type: string, eventInitDict?: { detail?: unknown }): MinimalCustomEvent;
}

const resolveCustomEvent = (): MinimalCustomEventConstructor | undefined => {
  if (typeof globalThis === "undefined") {
    return undefined;
  }

  const ctor = (globalThis as { CustomEvent?: MinimalCustomEventConstructor }).CustomEvent;
  return typeof ctor === "function" ? ctor : undefined;
};

export const createWebAdapter = (options: WebAdapterOptions = {}): WebAdapter => {
  const { target, eventName = "bandit-agent-event", ...runtimeOptions } = options;
  const runtime = createAgentRuntime(runtimeOptions);
  const CustomEventCtor = resolveCustomEvent();

  const dispatch = (event: AgentEvent) => {
    if (target && CustomEventCtor) {
      target.dispatchEvent(new CustomEventCtor(eventName, { detail: event }));
    }
  };

  const forwarder = (event: AgentEvent) => dispatch(event);
  const observedEvents = ["plan:start", "plan:complete", "step:complete", "diff:apply", "report:complete"];

  observedEvents.forEach((name) => runtime.on(name, forwarder));

  return {
    runtime,
    plan: (goal: string, planOptions?: PlanOptions) => runtime.plan(goal, planOptions),
    execute: (executeOptions?: ExecuteOptions) => runtime.execute(executeOptions),
    report: (metadata?: Record<string, unknown>) => runtime.report(metadata),
    subscribe: (listener: (event: AgentEvent) => void) => {
      observedEvents.forEach((name) => runtime.on(name, listener));
      return () => observedEvents.forEach((name) => runtime.off(name, listener));
    }
  };
};
