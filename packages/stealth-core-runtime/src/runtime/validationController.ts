export interface ValidationControllerDeps {
  isDevelopmentMode(): boolean;
  getSkipValidationSetting(): boolean;
  throttleMs?: number;
}

export function createValidationController(deps: ValidationControllerDeps) {
  const timestamps: Record<string, number> = {};
  const throttleMs = typeof deps.throttleMs === 'number' ? deps.throttleMs : 4000;

  function shouldSkipValidations(): boolean {
    if (!deps.isDevelopmentMode()) {
      return false;
    }
    return deps.getSkipValidationSetting();
  }

  function isThrottled(kind: string): boolean {
    const last = timestamps[kind];
    if (!last) {
      return false;
    }
    return Date.now() - last < throttleMs;
  }

  function markRun(kind: string): void {
    timestamps[kind] = Date.now();
  }

  return {
    shouldSkipValidations,
    isThrottled,
    markRun
  };
}
