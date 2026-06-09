import type { PlanStep } from '../internalTypes';
import type { ITelemetry, IDiffManager, IShellAdapter } from '../internalTypes';
import type { TypeScriptValidator } from '../internalTypes';
import type { WorkspacePackageManager } from '../internalTypes';
import type { IPythonEnv } from '../internalTypes';
import type { AutoHealer } from './autoHealer';
import type { EventBus } from '../internalTypes';
import { createValidationUtils } from './validationUtils';
import { createValidationController } from './validationController';
import { createDiagnosticsEngine } from './diagnostics';

export interface DiagnosticsServicesDeps {
  telemetry: ITelemetry;
  diffManager: IDiffManager;
  typescriptValidator: TypeScriptValidator;
  workspacePackageManager: WorkspacePackageManager;
  autoHealer: AutoHealer;
  eventBus: EventBus;
  pythonEnv: IPythonEnv;
  shellAdapter: IShellAdapter;
  pathExists(target: string): Promise<boolean>;
  getWorkspaceRoot(): string;
  isDryRunEnabled(): boolean;
  getRunOptions(): { previewOnly?: boolean };
  getWriteTargetPath(step: PlanStep): string | undefined;
  normalizeRelativePath(value: string): string | undefined;
  getWorkspaceFileIndex(): string[];
  loadWorkspaceFileIndex(force?: boolean): Promise<string[]>;
  isDevelopmentMode(): boolean;
  shouldSkipValidationInDev(): boolean;
  validationUtils?: ReturnType<typeof createValidationUtils>;
  validationController?: ReturnType<typeof createValidationController>;
}

export function createDiagnosticsServices(deps: DiagnosticsServicesDeps) {
  const validationUtils =
    deps.validationUtils ??
    createValidationUtils({
      shellAdapter: deps.shellAdapter,
      pathExists: (target) => deps.pathExists(target),
      getWorkspaceRoot: () => deps.getWorkspaceRoot()
    });

  const validationController =
    deps.validationController ??
    createValidationController({
      isDevelopmentMode: () => deps.isDevelopmentMode(),
      getSkipValidationSetting: () => deps.shouldSkipValidationInDev(),
      throttleMs: 4000
    });

  const diagnostics = createDiagnosticsEngine({
    telemetry: deps.telemetry,
    typescriptValidator: deps.typescriptValidator,
    workspacePackageManager: deps.workspacePackageManager,
    autoHealer: deps.autoHealer,
    eventBus: deps.eventBus,
    pythonEnv: deps.pythonEnv,
    diffManager: deps.diffManager,
    isDryRun: () => deps.isDryRunEnabled(),
    shouldSkipValidations: () => validationController.shouldSkipValidations(),
    getWorkspaceRoot: () => deps.getWorkspaceRoot(),
    getRunOptions: () => deps.getRunOptions(),
    getWriteTargetPath: (step) => deps.getWriteTargetPath(step),
    normalizeRelativePath: (value) => deps.normalizeRelativePath(value),
    pathExists: (target) => deps.pathExists(target),
    getWorkspaceFileIndex: () => deps.getWorkspaceFileIndex(),
    loadWorkspaceFileIndex: (force) => deps.loadWorkspaceFileIndex(force),
    spawnValidationProcess: (command, args, cwd) => validationUtils.spawnValidationProcess(command, args, cwd),
    getCommandName: (base) => validationUtils.getCommandName(base)
  });

  return {
    validationUtils,
    validationController,
    diagnostics
  };
}
