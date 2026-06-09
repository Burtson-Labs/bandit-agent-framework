import type { IFsAdapter, ITelemetry, StealthHostBindings } from '../hostTypes';

export interface WorkspaceAssertionIssue {
  code: string;
  message: string;
  detail?: string;
}

export interface WorkspaceAssertionContext {
  workspaceId?: string;
  repoRoot?: string;
  planRunDir?: string;
  modelId?: string;
}

export interface WorkspaceAssertionDeps {
  env: StealthHostBindings['env'];
  workspace: StealthHostBindings['workspace'];
  config: StealthHostBindings['config'];
  fs: IFsAdapter;
  telemetry: ITelemetry;
}

const WRITE_CHECK_CONTENT = 'bandit-runtime-check';

export async function assertWritableWorkspace(
  deps: WorkspaceAssertionDeps
): Promise<WorkspaceAssertionContext> {
  const issues: WorkspaceAssertionIssue[] = [];
  const context: WorkspaceAssertionContext = {};

  const repoRoot = resolveWorkspaceRoot(deps, issues);
  if (repoRoot) {
    context.repoRoot = repoRoot;
  }

  const runContext = deps.env.getRunContext?.();
  const workspaceId = resolveWorkspaceId(runContext, issues);
  if (workspaceId) {
    context.workspaceId = workspaceId;
  }

  const planRunDir = resolvePlanRunDir(deps, repoRoot, issues);
  if (planRunDir) {
    context.planRunDir = planRunDir;
  }

  const modelId = resolveModelId(deps.config);
  if (!modelId) {
    issues.push({
      code: 'MODEL_UNRESOLVED',
      message: 'modelId not resolved.'
    });
  } else {
    context.modelId = modelId;
  }

  if (issues.length > 0) {
    await reportAssertionFailure(deps.telemetry, issues);
    throw new Error(formatIssues(issues));
  }

  if (repoRoot) {
    await verifyFsAccess(deps.fs, repoRoot, issues);
  }

  if (issues.length > 0) {
    await reportAssertionFailure(deps.telemetry, issues);
    throw new Error(formatIssues(issues));
  }

  return context;
}

function resolveWorkspaceRoot(
  deps: WorkspaceAssertionDeps,
  issues: WorkspaceAssertionIssue[]
): string | undefined {
  try {
    const root = normalizeString(deps.workspace.getInitialWorkspaceRoot());
    if (!root) {
      issues.push({ code: 'NO_WORKSPACE', message: 'Workspace root not resolved.' });
      return undefined;
    }
    return root;
  } catch (error) {
    issues.push({
      code: 'NO_WORKSPACE',
      message: 'Workspace root not resolved.',
      detail: toErrorMessage(error)
    });
    return undefined;
  }
}

function resolveWorkspaceId(
  runContext: unknown,
  issues: WorkspaceAssertionIssue[]
): string | undefined {
  if (!runContext || typeof runContext !== 'object') {
    return undefined;
  }
  if (!('workspaceId' in runContext)) {
    return undefined;
  }
  const candidate = normalizeString((runContext as { workspaceId?: unknown }).workspaceId);
  if (!candidate) {
    issues.push({ code: 'NO_WORKSPACE', message: 'workspaceId missing from run context.' });
    return undefined;
  }
  return candidate;
}

function resolvePlanRunDir(
  deps: WorkspaceAssertionDeps,
  repoRoot: string | undefined,
  issues: WorkspaceAssertionIssue[]
): string | undefined {
  if (!repoRoot) {
    return undefined;
  }
  try {
    const planRunDir = normalizeString(deps.env.resolvePlanRunDirectory(repoRoot));
    if (!planRunDir) {
      issues.push({ code: 'NO_WORKSPACE', message: 'planRunDir not resolved.' });
      return undefined;
    }
    return planRunDir;
  } catch (error) {
    issues.push({
      code: 'NO_WORKSPACE',
      message: 'planRunDir not resolved.',
      detail: toErrorMessage(error)
    });
    return undefined;
  }
}

function resolveModelId(config: StealthHostBindings['config']): string | undefined {
  const modelId = normalizeString(config.get<string>('modelId'));
  if (modelId) {
    return modelId;
  }
  const model = normalizeString(config.get<string>('model', 'bandit-core-1'));
  if (model) {
    return model;
  }
  return normalizeString(config.get<string>('ollamaModel', 'bandit-core:12b-it-qat'));
}

async function verifyFsAccess(
  fs: IFsAdapter,
  repoRoot: string,
  issues: WorkspaceAssertionIssue[]
): Promise<void> {
  const markerName = `.bandit_runtime_check_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const testPath = joinPath(repoRoot, markerName);
  let wrote = false;

  try {
    await fs.writeText(testPath, WRITE_CHECK_CONTENT, 'utf8');
    wrote = true;
  } catch (error) {
    issues.push({
      code: 'FS_DENIED',
      message: 'Filesystem write failed.',
      detail: toErrorMessage(error)
    });
  }

  if (wrote) {
    try {
      await fs.readText(testPath, 'utf8');
    } catch (error) {
      issues.push({
        code: 'FS_DENIED',
        message: 'Filesystem read failed.',
        detail: toErrorMessage(error)
      });
    } finally {
      try {
        await fs.remove(testPath, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

async function reportAssertionFailure(
  telemetry: ITelemetry,
  issues: WorkspaceAssertionIssue[]
): Promise<void> {
  try {
    await telemetry.status({
      text: 'Workspace not ready for agent run.',
      phase: 'error',
      icon: 'warn',
      detail: formatIssues(issues)
    });
  } catch {
    // Telemetry should not block the workspace gate.
  }
}

function formatIssues(issues: WorkspaceAssertionIssue[]): string {
  return issues
    .map((issue) => {
      const detail = issue.detail ? ` (${issue.detail})` : '';
      return `${issue.code}: ${issue.message}${detail}`;
    })
    .join(' | ');
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function joinPath(base: string, suffix: string): string {
  const separator = base.includes('\\') ? '\\' : '/';
  const trimmedBase = base.replace(/[\\/]+$/, '');
  return `${trimmedBase}${separator}${suffix}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}
