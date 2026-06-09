import type { Goal, Task } from '@burtson-labs/agent-core';
export type { Goal, Task } from '@burtson-labs/agent-core';

export interface PlanStep {
  id: string;
  title: string;
  details: string;
  action: StepAction;
  command?: string;
  targetFile?: string;
  filesToEdit?: string[];
  filesToReadOnly?: string[];
  metadata?: Record<string, unknown>;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  tasks?: Task[];
  goals?: Goal[];
  metadata?: Record<string, unknown>;
}

export interface AgentTelemetryMessage {
  stepId?: string;
  durationMs?: number;
  tokens?: number;
  ok?: boolean;
  kind?: 'goal-inference' | 'task-progress';
  goal?: {
    id?: string;
    title?: string;
    intent?: string;
    files?: string[];
    rationale?: string;
  };
  progress?: {
    goalId?: string;
    completed?: number;
    total?: number;
  };
}

export interface ExecutionResult {
  stepId: string;
  ok: boolean;
  output?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface Evaluation {
  success: boolean;
  feedback: string;
  confidence: number; // 0..1
  semanticScore?: number;
  validationScore?: number;
}

export interface AgentReport {
  goal: string;
  plan: Plan;
  results: ExecutionResult[];
  evaluation: Evaluation;
  iterations: number;
  finishedAt: string;
}

export type ProviderKind = 'bandit' | 'ollama';

export type StepAction =
  | PythonScanProjectAction
  | PythonReadFileAction
  | PythonWriteFileAction
  | PythonRunCommandAction
  | InternalIdentifyHomepageAction
  | InternalLocateFilesAction
  | InternalExtractRelevantSectionAction
  | InternalRunProjectScriptsAction
  | InternalEmitMessageAction
  | InternalReviewDiffAction
  | LlmRewriteAction;

export interface PythonScanProjectAction {
  type: 'python';
  name: 'scanProject';
  params?: {
    rootRef?: string;
    maxDepth?: number;
    maxFiles?: number;
    includeExtensions?: string[];
  };
  storeKey: string;
}

export interface PythonReadFileAction {
  type: 'python';
  name: 'readFile';
  pathRef: string;
  storeKey: string;
  encoding?: BufferEncoding;
}

export interface PythonWriteFileAction {
  type: 'python';
  name: 'writeFile';
  pathRef: string;
  contentRef: string;
  encoding?: BufferEncoding;
  originalContentRef?: string;
  diffStoreKey?: string;
  additionalWritesRef?: string;
}

export interface PythonRunCommandAction {
  type: 'python';
  name: 'runCommand';
  command: string;
  cwdRef?: string;
  storeKey?: string;
  allowFailure?: boolean;
}

export interface InternalIdentifyHomepageAction {
  type: 'internal';
  name: 'identifyHomepage';
  storePath?: string;
}

export interface InternalLocateFilesAction {
  type: 'internal';
  name: 'locateFiles';
  patterns: string[];
  storePath?: string;
  maxMatches?: number;
  priorityKeywords?: string[];
  primaryPathHint?: string;
  excludePrefixes?: string[];
}

export interface InternalExtractRelevantSectionAction {
  type: 'internal';
  name: 'extractRelevantSection';
  pathRef?: string;
  contentRef?: string;
  patterns?: string[];
  storeKey?: string;
}

export interface InternalRunProjectScriptsAction {
  type: 'internal';
  name: 'runProjectScripts';
  scripts?: string[];
}

export interface InternalEmitMessageAction {
  type: 'internal';
  name: 'emitMessage';
  message: string;
  level?: 'info' | 'warn' | 'error';
}

export interface InternalReviewDiffAction {
  type: 'internal';
  name: 'reviewDiff';
  pathRef?: string;
  diffRef?: string;
  originalContentRef?: string;
  updatedContentRef?: string;
  storeKey?: string;
  touchedFilesRef?: string;
  diagnosticsRef?: string;
}

export interface LlmRewriteAction {
  type: 'llmRewrite';
  pathRef: string;
  contentRef: string;
  outputKey: string;
  instructions?: string;
}
