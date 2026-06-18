export type { StealthHostBindings } from './hostTypes';
export type { StealthRuntime } from './runtime/stealthRuntimeTypes';
export * from './types';
export * from './statusTypes';
export * from './goalInference';
export type { EmbeddingRecord } from './embeddingCache';
export { EmbeddingCache } from './embeddingCache';
export type { EmbeddingDocument, EmbeddingSearchHit, StealthEmbeddingClientOptions } from './embeddingClient';
export { StealthEmbeddingClient } from './embeddingClient';
export {
  createProvider,
  buildOllamaErrorHint,
  type ChatProvider,
  type ProviderKind,
  type ProviderSettings
} from './banditEngineProvider';
export * from './types/bandit';
export * from './runtime/types';
export * from './runtime';
export * from './executorAgent';
export { createPlanContext } from './runtime/planContext';
export type { PlanContext } from './runtime/planContext';
export { createNodeFsAdapter } from './runtime/adapters/fsAdapter';
export { createTelemetry, type TelemetryDeps } from './runtime/telemetry';
export { createEventBus } from './runtime/eventBus';
export { createTaskQueue, type TaskQueue, type TaskQueueTask, type TaskQueueOptions } from './runtime/taskQueue';
export { WorkspaceIndex } from './workspaceIndex';
export type { WorkspaceIndexSnapshot, WorkspaceFileRecord } from './workspaceIndex';

export { createStealthRuntime } from './runtime/createStealthRuntime';

// Context & embeddings
export { GatewaySearchAdapter, GatewaySearchError } from './gatewaySearchAdapter';
export type { GatewaySearchChunk, GatewayFileSummary, GatewaySearchResult, GatewaySearchOptions } from './gatewaySearchAdapter';
export { OllamaEmbeddingClient } from './ollamaEmbeddingClient';
export type { OllamaEmbeddingClientOptions, OllamaEmbeddingHit } from './ollamaEmbeddingClient';
export { getModelCapabilities, getContextFileLimit, getContextTokenBudget, getOutputTokenBudget, registerModelCapabilities, queryOllamaModelCapabilities, resolveOllamaRuntimeOptions, resolvePreferredToolProtocol, checkOllamaLoadedContext, resolveDefaultMaxIterations } from './runtime/modelCapabilities';
export { MODEL_BEHAVIOR_CONFIG_SCHEMA_VERSION, getModelBehaviorProfile, getBuiltInModelBehaviorProfiles, registerModelBehaviorOverride, registerModelBehaviorConfig, parseModelBehaviorConfig, clearModelBehaviorOverrides } from './runtime/modelBehavior';
export { queryModelsDevCapabilities, queryOpenAICompatibleModelInfo } from './runtime/modelsDevCatalog';
export type { ModelCapabilities, ModelTier, OllamaRuntimeOptions, OllamaContextCheck } from './runtime/modelCapabilities';
export type { ModelBehaviorProfile, ModelBehaviorOverride, ModelBehaviorConfigEntry, ModelBehaviorConfigParseResult, ToolProtocol, ToolEnvelope, PromptTemplateId, CompactionMode, ThinkingDefault } from './runtime/modelBehavior';
export { ContextBuilder, buildSlimContext } from './runtime/contextBuilder';
export {
  buildExtensionSystemPrompt,
  type BuildExtensionSystemPromptInput,
  SYSTEM_PROMPT_BUDGETS,
  getSystemPromptBudget
} from './extensionSystemPrompt';
export {
  SHARED_GIT_AUTHORSHIP_HEADING,
  SHARED_GIT_AUTHORSHIP_ENABLED_BODY,
  SHARED_GIT_AUTHORSHIP_DISABLED_BODY,
  buildGitAuthorshipBlock,
  buildGitAuthorshipBullet
} from './sharedPromptSections';
export type { BuildContextOptions, BuiltContext, ContextFile, SlimContextOptions } from './runtime/contextBuilder';
