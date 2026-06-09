import { useMemo } from "react";
import type { AgentEvent } from "@burtson-labs/agent-core";
import type {
  AgentTelemetryPayload,
  GoalInsightTelemetry,
  StepCompletePayload,
  TelemetrySnapshot,
  TaskProgressTelemetry,
  TokenUsage
} from "../types/ui-schema";

const DEFAULT_TOKEN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  total: 0
};

const coerceNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const readNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const numberValue = coerceNumber(value);
    if (numberValue !== 0 || value === 0 || value === "0") {
      return numberValue;
    }
  }
  return undefined;
};

const readString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
};

interface TokenSample {
  input?: number;
  output?: number;
  total?: number;
  cache?: number;
}

const extractTokenSample = (payload: Record<string, unknown>): TokenSample | undefined => {
  const rawTokens = payload.tokens;
  const tokens = asRecord(rawTokens);
  const metadata = asRecord(payload.metadata);
  const metadataTokens = asRecord(metadata?.tokens);
  const directTokenTotal = readNumber(rawTokens, metadata?.tokenTotal, metadata?.tokensTotal);

  const input = readNumber(
    tokens?.input,
    tokens?.inputTokens,
    payload.input,
    payload.inputTokens,
    metadata?.input,
    metadata?.inputTokens,
    metadataTokens?.input,
    metadataTokens?.inputTokens
  );
  const output = readNumber(
    tokens?.output,
    tokens?.outputTokens,
    payload.output,
    payload.outputTokens,
    metadata?.output,
    metadata?.outputTokens,
    metadataTokens?.output,
    metadataTokens?.outputTokens
  );
  const total = readNumber(
    directTokenTotal,
    tokens?.total,
    tokens?.totalTokens,
    payload.total,
    payload.totalTokens,
    metadata?.total,
    metadata?.totalTokens,
    metadataTokens?.total,
    metadataTokens?.totalTokens
  );
  const cache = readNumber(tokens?.cache, payload.cache, metadata?.cache, metadataTokens?.cache);

  if (input === undefined && output === undefined && total === undefined && cache === undefined) {
    return undefined;
  }

  return { input, output, total, cache };
};

const extractPlanStepCount = (event: AgentEvent): number | undefined => {
  if (event.type !== "plan:start" && event.type !== "plan:complete") {
    return undefined;
  }
  const payload = asRecord(event.payload);
  const payloadPlan = asRecord(payload?.plan);
  const steps = Array.isArray(payloadPlan?.steps)
    ? payloadPlan.steps
    : Array.isArray(payload?.steps)
      ? payload.steps
      : undefined;
  return Array.isArray(steps) ? steps.length : undefined;
};

export const useTelemetry = (events: AgentEvent[] = []): TelemetrySnapshot => {
  return useMemo<TelemetrySnapshot>(() => {
    const telemetryEvents = events.filter((event) => event.type === "telemetry");
    let goalInsight: GoalInsightTelemetry | undefined;
    let taskProgress: TaskProgressTelemetry | undefined;
    let resolvedProvider: string | undefined;
    let resolvedModel: string | undefined;
    const tokens = telemetryEvents.reduce<TokenUsage>(
      (acc, event) => {
        const payload = asRecord(event.payload);
        if (!payload) {
          return acc;
        }

        const tokenSample = extractTokenSample(payload);
        if (tokenSample) {
          if (tokenSample.input !== undefined) {
            acc.input += tokenSample.input;
          }
          if (tokenSample.output !== undefined) {
            acc.output += tokenSample.output;
          }
          if (tokenSample.total !== undefined) {
            acc.total += tokenSample.total;
          } else if (tokenSample.input !== undefined || tokenSample.output !== undefined) {
            acc.total += (tokenSample.input ?? 0) + (tokenSample.output ?? 0);
          }
          if (tokenSample.cache !== undefined) {
            acc.cache = (acc.cache ?? 0) + tokenSample.cache;
          }
        }

        const metadata = asRecord(payload.metadata);
        resolvedProvider = readString(
          payload.provider,
          payload.providerName,
          metadata?.provider,
          metadata?.providerName,
          metadata?.providerLabel,
          metadata?.providerKind
        ) ?? resolvedProvider;
        resolvedModel = readString(
          payload.model,
          payload.modelName,
          metadata?.model,
          metadata?.modelName,
          metadata?.modelId
        ) ?? resolvedModel;

        const kind = readString(payload.kind, metadata?.kind);
        if (kind === "goal-inference" || (!kind && (metadata?.goal || payload.goal))) {
          const goalData = asRecord(metadata?.goal ?? payload.goal);
          if (goalData) {
            const files = Array.isArray(goalData.files)
              ? goalData.files.filter((file): file is string => typeof file === "string")
              : undefined;
            goalInsight = {
              id: typeof goalData.id === "string" ? goalData.id : undefined,
              title: typeof goalData.title === "string" ? goalData.title : undefined,
              intent: typeof goalData.intent === "string" ? goalData.intent : undefined,
              rationale: typeof goalData.rationale === "string" ? goalData.rationale : undefined,
              files
            };
          }
        }
        if (kind === "task-progress" || (!kind && (metadata?.progress || payload.progress))) {
          const progressData = asRecord(metadata?.progress ?? payload.progress);
          if (progressData) {
            const completed = coerceNumber(progressData.completed);
            const total = coerceNumber(progressData.total);
            taskProgress = {
              goalId: typeof progressData.goalId === "string" ? progressData.goalId : undefined,
              completed,
              total
            };
          }
        }
        return acc;
      },
      { ...DEFAULT_TOKEN_USAGE }
    );

    const lastTelemetryPayload =
      [...telemetryEvents]
        .reverse()
        .map((event) => asRecord(event.payload))
        .find((payload): payload is Record<string, unknown> => Boolean(payload)) as
        | AgentTelemetryPayload
        | undefined;
    const summaryDurationMs = [...events]
      .reverse()
      .find((event) => event.type === "summary")
      ?.payload as { durationMs?: unknown } | undefined;

    const startedAt =
      events.find((event) => event.type === "plan:start")?.timestamp ??
      events.at(0)?.timestamp;
    const lastEventAt = events.at(-1)?.timestamp;

    const stepDurations: number[] = [];
    let completedSteps = 0;
    let failedSteps = 0;
    let planStepCount = 0;

    for (const event of events) {
      const maybePlanStepCount = extractPlanStepCount(event);
      if (typeof maybePlanStepCount === "number" && Number.isFinite(maybePlanStepCount)) {
        planStepCount = Math.max(planStepCount, maybePlanStepCount);
      }
      if (event.type !== "step:complete") {
        continue;
      }
      const payload = event.payload as StepCompletePayload | undefined;
      const status = payload?.result?.status;
      if (status === "failed") {
        failedSteps += 1;
      } else {
        completedSteps += 1;
      }
      const duration = payload?.result?.metadata?.durationMs;
      if (typeof duration === "number" && Number.isFinite(duration)) {
        stepDurations.push(duration);
      }
    }

    const averageStepDurationMs =
      stepDurations.length > 0
        ? stepDurations.reduce((sum, value) => sum + value, 0) / stepDurations.length
        : undefined;

    completedSteps = Math.max(completedSteps, coerceNumber(taskProgress?.completed));
    const totalSteps = Math.max(
      completedSteps + failedSteps,
      coerceNumber(taskProgress?.total),
      planStepCount
    );

    return {
      totalEvents: events.length,
      tokens,
      latencyMs:
        lastTelemetryPayload?.latencyMs ??
        (typeof (lastTelemetryPayload as { durationMs?: unknown } | undefined)?.durationMs === "number"
          ? ((lastTelemetryPayload as { durationMs?: number }).durationMs ?? undefined)
          : undefined) ??
        (typeof summaryDurationMs?.durationMs === "number" ? summaryDurationMs.durationMs : undefined) ??
        (startedAt && lastEventAt ? lastEventAt - startedAt : undefined),
      model: resolvedModel ?? lastTelemetryPayload?.model,
      provider: resolvedProvider ?? lastTelemetryPayload?.provider,
      startedAt,
      lastEventAt,
      completedSteps,
      failedSteps,
      totalSteps,
      averageStepDurationMs,
      goalInsight,
      taskProgress
    };
  }, [events]);
};
