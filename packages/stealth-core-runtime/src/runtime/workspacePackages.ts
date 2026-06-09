import type { WorkspaceIndexSnapshot } from '../internalTypes';
import type { ValidationOutcome } from '../internalTypes';

const isBrowser = typeof window !== 'undefined';

type PathModule = typeof import('path');

const hashString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(16, '0');
};

async function getPath(): Promise<PathModule> {
  if (isBrowser) {
    throw new Error('Workspace package manager not available in browser host');
  }
  const mod = await import('path');
  return mod;
}

export interface WorkspacePackage {
  name: string;
  root: string;
  scripts: Record<string, string>;
}

export interface WorkspacePackageManagerDeps {
  readWorkspaceFile(path: string): Promise<string>;
  normalizeRelativePath(value: string): string | undefined;
  spawnValidationProcess(command: string, args: string[], cwd: string): Promise<ValidationOutcome>;
  getCommandName(base: string): string;
}

export interface WorkspacePackageManager {
  updateFromSnapshot(snapshot: WorkspaceIndexSnapshot): Promise<void>;
  runLintValidation(
    touchedFiles: string[],
    options: { previewOnly: boolean; workspaceRoot: string }
  ): Promise<ValidationOutcome>;
}

export function createWorkspacePackageManager(deps: WorkspacePackageManagerDeps): WorkspacePackageManager {
  if (isBrowser) {
    return {
      async updateFromSnapshot() {
        return;
      },
      async runLintValidation() {
        return { ok: true, note: 'Package lint skipped in browser host.' } as ValidationOutcome;
      }
    };
  }

  let pathMod: PathModule | undefined;

  let packages: WorkspacePackage[] = [];
  const lintBaseline = new Map<string, string>();
  const validationTimestamps = new Map<string, number>();

  async function updateFromSnapshot(snapshot: WorkspaceIndexSnapshot): Promise<void> {
    if (!pathMod) {
      pathMod = await getPath();
    }
    const discovered: WorkspacePackage[] = [];
    for (const file of snapshot.files) {
      if (!file.path.toLowerCase().endsWith('package.json')) {
        continue;
      }
      const absolute = pathMod.join(snapshot.root, file.path);
      try {
        const text = await deps.readWorkspaceFile(absolute);
        const json = JSON.parse(text) as { name?: string; scripts?: Record<string, string> };
        const dirSegments = file.path.split('/');
        dirSegments.pop();
        const root = dirSegments.join('/') || '.';
        const name =
          typeof json.name === 'string' && json.name.trim().length > 0
            ? json.name.trim()
            : pathMod.basename(root === '.' ? snapshot.root : root);
        discovered.push({
          name,
          root,
          scripts: json.scripts ?? {}
        });
      } catch {
        continue;
      }
    }
    packages = discovered;
  }

  function resolve(relativePath: string): WorkspacePackage | undefined {
    if (!packages.length) {
      return undefined;
    }
    const normalized = deps.normalizeRelativePath(relativePath) ?? relativePath;
    if (!normalized) {
      return undefined;
    }
    let candidate: WorkspacePackage | undefined;
    let bestLength = -1;
    for (const pkg of packages) {
      const root = pkg.root === '.' ? '' : pkg.root;
      if (root && normalized !== root && !normalized.startsWith(`${root}/`)) {
        continue;
      }
      const length = root.length;
      if (length >= bestLength) {
        candidate = pkg;
        bestLength = length;
      }
    }
    return candidate;
  }

  function isThrottled(name: string): boolean {
    const last = validationTimestamps.get(name) ?? 0;
    return Date.now() - last < 60000;
  }

  function markValidation(name: string): void {
    validationTimestamps.set(name, Date.now());
  }

  async function runPackageScript(pkg: WorkspacePackage, workspaceRoot: string): Promise<ValidationOutcome> {
    const command = deps.getCommandName('pnpm');
    const args = ['--filter', pkg.name, 'lint'];
    return deps.spawnValidationProcess(command, args, workspaceRoot);
  }

  async function runLintValidation(
    touchedFiles: string[],
    options: { previewOnly: boolean; workspaceRoot: string }
  ): Promise<ValidationOutcome> {
    if (!touchedFiles.length || options.previewOnly) {
      return { ok: true };
    }
    const packagesByName = new Map<string, WorkspacePackage>();
    touchedFiles.forEach((file) => {
      const pkg = resolve(file);
      if (!pkg || !pkg.scripts || typeof pkg.scripts.lint !== 'string') {
        return;
      }
      packagesByName.set(pkg.name, pkg);
    });
    if (packagesByName.size === 0) {
      return { ok: true };
    }
    for (const pkg of packagesByName.values()) {
      const baselineKnown = lintBaseline.has(pkg.name);
      const result = await runPackageScript(pkg, options.workspaceRoot);
      const normalizedOutput = (result.output ?? result.error ?? '').trim();
      if (!baselineKnown) {
        lintBaseline.set(pkg.name, !result.ok && normalizedOutput ? normalizedOutput : '');
        continue;
      }
      if (isThrottled(pkg.name)) {
        continue;
      }
      markValidation(pkg.name);
      if (!result.ok) {
        const baseline = lintBaseline.get(pkg.name);
        if (baseline && normalizedOutput && normalizedOutput === baseline) {
          continue;
        }
        if (!baseline && normalizedOutput) {
          lintBaseline.set(pkg.name, normalizedOutput);
          continue;
        }
        return {
          ok: false,
          error: `Package lint failed for ${pkg.name}.`,
          output: normalizedOutput || result.output,
          kind: 'package',
          touchedFiles,
          diagnostics: normalizedOutput
            ? [
                {
                  file: pkg.root === '.' ? 'package.json' : `${pkg.root}/package.json`,
                  line: 1,
                  column: 1,
                  code: 'LINT',
                  message: normalizedOutput.split('\n')[0],
                  fingerprint: hashString(`${pkg.name}:${normalizedOutput}`)
                }
              ]
            : undefined
      };
    }
    }
    return { ok: true };
  }

  return {
    updateFromSnapshot,
    runLintValidation
  };
}
