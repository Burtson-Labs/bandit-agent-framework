import type { ProviderChatOptions, ProviderClient } from '@burtson-labs/agent-core';
import type { Plan, PlanStep, ExecutionResult, Evaluation } from '../types';
export type { ExecutionResult } from '../types';
import type { InferredGoal } from '../goalInference';
import type { StatusPayload, LogPayload } from '../statusTypes';
export type { StatusPayload, LogPayload } from '../statusTypes';

export interface StepOutcome {
  ok: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface AgentSession {
  goal: string;
  workspaceRoot: string;
  data: Record<string, unknown>;
}

export interface AgentGoalOptions {
  lightweight?: boolean;
  previewOnly?: boolean;
  /** Model tier for plan prompt tuning. Small models get a shorter, stricter schema prompt. */
  modelTier?: 'small' | 'medium' | 'large';
  /** Semantic context block from Qdrant/embeddings search. Injected into rewrite prompts. */
  contextBlock?: string;
}

export interface AgentConfiguration {
  maxIterations: number;
  confidenceTarget: number;
}

export interface ExecutorAgentConfiguration {
  maxIterations: number;
  confidenceTarget: number;
}

export interface ExecutorHooks {
  previewOnly(): boolean;
  isCancelled(): boolean;
  postStatus(payload: StatusPayload): Promise<void>;
  postLog(payload: LogPayload): Promise<void>;
  postPlanUpdate(
    stepId: string,
    state: string,
    meta?: { summary?: string; durationMs?: number; tokens?: number }
  ): void;
  postTelemetry(stepId: string, result: ExecutionResult): Promise<void>;
  getStatusIcon(step: PlanStep): StatusPayload['icon'];
  getResultStatusIcon(ok: boolean): StatusPayload['icon'];
  estimateTokensFromResult(result: ExecutionResult): number;
  prepareStep?(step: PlanStep, goal: string): Promise<void>;
  executeStep(step: PlanStep, goal: string): Promise<ExecutionResult>;
  finalizeStep?(step: PlanStep, result: ExecutionResult): Promise<void>;
  autoRevise(
    goal: string,
    plan: Plan,
    results: ExecutionResult[],
    config: ExecutorAgentConfiguration
  ): Promise<{ results: ExecutionResult[]; iterations: number; retryStepId?: string }>;
  flushPlanUpdates(): void;
}

export interface ExecutorResult {
  results: ExecutionResult[];
  autoIterations: number;
}

export interface Disposable {
  dispose(): void;
}

export interface TypeScriptDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  fingerprint: string;
}

export interface ValidationOutcome {
  ok: boolean;
  error?: string;
  output?: string;
  diagnostics?: TypeScriptDiagnostic[];
  ignoredDiagnostics?: TypeScriptDiagnostic[];
  repairedFiles?: string[];
  repairAttempts?: number;
  repairKind?: string;
  existingDiagnostics?: TypeScriptDiagnostic[];
  touchedFiles?: string[];
  helperStep?: boolean;
  kind?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  finalStatus?: 'complete' | 'best-effort';
  finalNotes?: string[];
}

export interface IStepExecutor {
  execute(step: PlanStep, goal: string): Promise<ExecutionResult>;
}

export interface IGoalEngine {
  enrich(plan: Plan, prompt: string, options: { insight?: InferredGoal }): Promise<Plan>;
}

export type HelperStepRole = 'rewrite' | 'write' | 'review';
export type RelatedStepRole = 'read' | 'rewrite' | 'write' | 'review';

export interface HelperStepMetadata {
  chainKind: 'helper';
  role?: HelperStepRole;
  helperId?: string;
  helperPath?: string;
  snippetRef?: string;
  pathRef?: string;
  outputRef?: string;
  diffRef?: string;
  reviewRef?: string;
}

export interface CallerStepMetadata {
  chainKind: 'caller';
  role?: HelperStepRole;
  helperIds?: string[];
  helperPaths?: string[];
  snippetRef?: string;
}

export interface RelatedStepMetadata {
  chainKind: 'related';
  role?: RelatedStepRole;
  targetPath?: string;
  pathRef?: string;
  diffRef?: string;
  reviewRef?: string;
}

export interface PendingDiff {
  original: string;
  updated: string;
  diff?: string;
  summary?: { added: number; removed: number };
  confidence?: number;
  changed?: boolean;
}

export interface DiffTransaction {
  id: string;
  pending: Map<string, PendingDiff>;
}

export interface FileChangeSnapshot {
  path: string;
  absolutePath: string;
  before: string;
  after: string;
  encoding: BufferEncoding;
  timestamp: number;
  existedBefore: boolean;
}

export interface FilePreWriteState {
  absolutePath: string;
  before: string;
  existedBefore: boolean;
}

export interface DiffStreamUpdate {
  path: string;
  kind: 'start' | 'progress' | 'complete';
  content?: string;
}

export type PlanUpdateState = 'start' | 'complete' | 'error' | 'needs-revision' | 'approved';

export interface TypeScriptDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  fingerprint: string;
}

export interface ValidationOutcome {
  ok: boolean;
  error?: string;
  output?: string;
  diagnostics?: TypeScriptDiagnostic[];
  ignoredDiagnostics?: TypeScriptDiagnostic[];
  repairedFiles?: string[];
  repairAttempts?: number;
  repairKind?: string;
  existingDiagnostics?: TypeScriptDiagnostic[];
  touchedFiles?: string[];
  helperStep?: boolean;
  kind?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  finalStatus?: 'complete' | 'best-effort';
  finalNotes?: string[];
}

export interface TypeScriptValidationContext {
  touchedFiles: string[];
  helperStep: boolean;
}

export interface IHelperManager {
  validate(meta: HelperStepMetadata): Promise<StepOutcome>;
  buildHelperGuidance(helperPath: string): Promise<string | undefined>;
  buildCallerGuidance(meta: CallerStepMetadata, callerPath: string): Promise<string | undefined>;
  applyImportHints(meta: HelperStepMetadata | undefined, content: string): string;
  ensureChainReady(meta: CallerStepMetadata): Promise<StepOutcome>;
}

export interface IDiffManager {
  clear(): void;
  getPendingDiff(path: string): PendingDiff | undefined;
  registerPendingDiff(
    path: string,
    original: string | undefined,
    updated: string | undefined,
    confidence?: number
  ): Promise<PendingDiff>;
  beginTransaction(): DiffTransaction;
  applyInTransaction(tx: DiffTransaction, path: string, diff: PendingDiff): void;
  commitTransaction(tx: DiffTransaction): Promise<void>;
  rollbackTransaction(tx: DiffTransaction): void;
  recordSnapshot(snapshot: FileChangeSnapshot): void;
  popSnapshot(): FileChangeSnapshot | undefined;
  hasSnapshots(): boolean;
  getSnapshotCount(): number;
  enableReviewMode(enabled: boolean): void;
  isReviewModeEnabled(): boolean;
  postDiffStream(update: DiffStreamUpdate): Promise<void>;
}

export interface IUndoManager {
  recordSnapshot(snapshot: FileChangeSnapshot): void;
  capturePreWriteState(
    workspaceRoot: string,
    relativePath: string,
    encoding: BufferEncoding,
    fallback?: string
  ): Promise<FilePreWriteState>;
  createBackup(workspaceRoot: string, relativePath: string, content: string): Promise<string>;
  hasSnapshots(): boolean;
  getSnapshotCount(): number;
  undoLastChange(): Promise<FileChangeSnapshot | null>;
  onDidUpdateSnapshots(listener: (count: number) => void): Disposable;
}

export interface IPythonEnv {
  ensure(): Promise<{ ok: boolean; version?: string; command?: string; error?: string }>;
  clearCache(): Promise<void>;
}

export interface PythonResponse {
  status?: string;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
  details?: unknown;
  code?: number;
}

export interface ITelemetry {
  status(payload: StatusPayload): Promise<void>;
  log(payload: LogPayload): Promise<void>;
  event(kind: string, data?: Record<string, unknown>): Promise<void>;
}

export interface IFsAdapter {
  readText(absPath: string, encoding?: BufferEncoding): Promise<string>;
  writeText(absPath: string, content: string, encoding?: BufferEncoding): Promise<void>;
  exists(absPath: string): Promise<boolean>;
  listRecursive(root: string): Promise<string[]>;
  ensureDir(absPath: string): Promise<void>;
  readDir(absPath: string): Promise<string[]>;
  remove(absPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface IShellAdapter {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; input?: string | Buffer }
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ILlmAdapter {
  stream(prompt: string, options?: ProviderChatOptions): AsyncIterable<string>;
  provider: ProviderClient;
}

export interface TypeScriptValidator {
  captureBaseline(): Promise<void>;
  runValidation(context: TypeScriptValidationContext): Promise<ValidationOutcome>;
  indexDiagnosticsByFile(diagnostics: TypeScriptDiagnostic[]): Map<string, TypeScriptDiagnostic[]>;
  getRewriteHint(relativePath: string): string | undefined;
  getBaselineDiagnostics(): TypeScriptDiagnostic[];
}

export interface HydratedRewriteFile {
  path: string;
  content: string;
  size?: number;
  hash?: string;
}

export interface AdditionalWrite {
  path: string;
  content: string;
  intent?: 'create' | 'modify';
}

export interface RewriteHydrationContext {
  editable: HydratedRewriteFile[];
  readonly: HydratedRewriteFile[];
}

export interface IConnectorBus {
  call<T = unknown>(connector: string, action: string, payload: unknown): Promise<T>;
}

export interface RuntimeRunOptions {
  insight?: InferredGoal;
  continueOnError?: boolean;
  metadata?: Record<string, unknown>;
  executor: ExecutorAgentConfiguration;
  skipEnrich?: boolean;
  previewOnly?: boolean;
}

export interface CoreRuntimeResult extends ExecutorResult {
  plan: Plan;
  evaluation: Evaluation;
}

export interface CoreRuntime {
  run(plan: Plan, goal: string, options: RuntimeRunOptions): Promise<CoreRuntimeResult>;
  dispose(): Promise<void>;
}

export interface CoreRuntimeDeps {
  fs: IFsAdapter;
  shell: IShellAdapter;
  goal: IGoalEngine;
  steps: IStepExecutor;
  helpers: IHelperManager;
  diff: IDiffManager;
  py: IPythonEnv;
  telemetry: ITelemetry;
  bus: IConnectorBus;
  evaluate(args: { plan: Plan; results: ExecutionResult[]; goal: string; config: ExecutorAgentConfiguration }): Promise<Evaluation>;
  awaitingGuidancePrefix: string;
}
