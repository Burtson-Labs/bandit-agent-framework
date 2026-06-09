import { createTelemetry } from '../telemetry';
import { createTelemetryHub } from '../telemetryHub';
import { createPlanContext } from '../planContext';
import { createNodeFsAdapter } from '../adapters/fsAdapter';
import { createWorkspaceService } from '../workspaceService';
import { createExtractionService } from '../extractionService';
import { createPersistenceManager } from '../persistence';
import { createShellAdapter } from '../adapters/shellAdapter';
import type { ITelemetry, IFsAdapter, IPythonEnv, IShellAdapter } from '../types';

interface PythonHostDeps {
  ensure(): Promise<{ info?: { command: string; version: string }; error?: string; ok?: boolean; command?: string; version?: string }>;
  clearCache(): Promise<void> | void;
}

export interface BaseServicesDeps {
  environment: { postMessage(message: unknown): Promise<void> | void };
  getWorkspaceRoot(): string;
  setContextValue(key: string, value: unknown): void;
  getContextValue<T>(key: string): T | undefined;
  getSessionGoal(): string | undefined;
  python: PythonHostDeps;
  fsAdapter?: IFsAdapter;
  shellAdapter?: IShellAdapter;
  onPythonDetected?(info: { command: string; version: string }): void;
  onPythonError?(message: string): void;
}

export interface BaseServices {
  telemetry: ITelemetry;
  telemetryHub: ReturnType<typeof createTelemetryHub>;
  planContext: ReturnType<typeof createPlanContext>;
  fsAdapter: IFsAdapter;
  workspace: ReturnType<typeof createWorkspaceService>;
  extraction: ReturnType<typeof createExtractionService>;
  persistence: ReturnType<typeof createPersistenceManager>;
  shellAdapter: ReturnType<typeof createShellAdapter>;
  pythonEnv: IPythonEnv;
}

export function createBaseServices(deps: BaseServicesDeps): BaseServices {
  const workspaceRoot = deps.getWorkspaceRoot();
  const post = (message: unknown) => deps.environment.postMessage(message);
  const telemetry = createTelemetry({ post });
  const telemetryHub = createTelemetryHub({
    telemetry,
    postMessage: post
  });
  const planContext = createPlanContext({
    telemetry,
    postPlanUpdate: (payload) => telemetryHub.postPlanUpdate(payload),
    emitTaskProgress: (progress) => telemetryHub.emitTaskProgress(progress)
  });
  const fsAdapter = deps.fsAdapter ?? createNodeFsAdapter(workspaceRoot);
  const workspace = createWorkspaceService({
    fs: fsAdapter,
    getWorkspaceRoot: () => deps.getWorkspaceRoot()
  });
  const extraction = createExtractionService({
    setContextValue: (key, value) => deps.setContextValue(key, value),
    getContextValue: (key) => deps.getContextValue(key),
    getSessionGoal: () => deps.getSessionGoal()
  });
  const persistence = createPersistenceManager({
    fs: fsAdapter
  });
  const shellAdapter = deps.shellAdapter ?? createShellAdapter();
  const pythonEnv: IPythonEnv = {
    ensure: async () => {
      const result = await deps.python.ensure();
      const info = result.info ?? (result.ok && result.command
        ? { command: result.command, version: result.version ?? 'unknown' }
        : undefined);
      if (info) {
        deps.onPythonDetected?.(info);
        return {
          ok: true,
          version: info.version,
          command: info.command
        };
      }
      const error = result.error ?? (typeof result === 'string' ? result : 'Python runtime not detected.');
      deps.onPythonError?.(error);
      return { ok: false, error };
    },
    clearCache: async () => {
      await deps.python.clearCache();
    }
  };

  return {
    telemetry,
    telemetryHub,
    planContext,
    fsAdapter,
    workspace,
    extraction,
    persistence,
    shellAdapter,
    pythonEnv
  };
}
