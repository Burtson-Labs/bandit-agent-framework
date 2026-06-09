import type { AgentRuntimeOptions } from "./runtime/AgentRuntime";
import { AgentRuntime } from "./runtime/AgentRuntime";
import { DeterministicProviderClient } from "./providers/deterministic-provider";
import type { ProviderClient } from "./providers/provider-client";

export * from "./types/agent";
export * from "./types/tasks";
export { validateAgentPlan } from "./types/agent";

export {
  ProviderClient,
  ProviderChatOptions,
  collectFromStream
} from "./providers/provider-client";

export {
  DeterministicProviderClient,
  DeterministicProviderConfig
} from "./providers/deterministic-provider";

export {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentTelemetry,
  AgentLogger,
  PlanOptions,
  ExecuteOptions,
  StepExecutor,
  StepExecutorContext,
  StepExecutorOutput
} from "./runtime/AgentRuntime";

export interface CreateAgentRuntimeOptions extends Partial<Omit<AgentRuntimeOptions, "provider">> {
  provider?: ProviderClient;
}

export const createAgentRuntime = (options: CreateAgentRuntimeOptions = {}): AgentRuntime => {
  const { provider: providerOverride, ...rest } = options;
  const provider = providerOverride ?? new DeterministicProviderClient();
  return new AgentRuntime({
    provider,
    ...(rest as Omit<AgentRuntimeOptions, "provider">)
  });
};

// Tool system
export * from './tools';

// MCP — Model Context Protocol client (Phase 1: groundwork). See
// docs/integration-playlist/mcp-roadmap.md. Off by default — hosts
// that don't construct an McpClientPool get zero behavior change.
export * from './mcp';

// Secret-leak protection. Redacts API keys, tokens, and
// private keys from tool output before they hit the model context,
// the terminal, or the on-disk session log.
export {
  redactSecrets,
  redactSecretsString,
  BUILTIN_SECRET_PATTERNS,
  type SecretPattern,
  type RedactionResult
} from './security/secretPatterns';

// Opt-in OTLP telemetry exporter — shared by the CLI and IDE host. Host-agnostic
// (Web Crypto + global fetch), so the same implementation serves every consumer.
export {
  TelemetryExporter,
  resolveTelemetryConfig,
  TTFT_BUCKETS,
  DURATION_BUCKETS,
  type TelemetryConfig
} from './telemetry/otlpExporter';
