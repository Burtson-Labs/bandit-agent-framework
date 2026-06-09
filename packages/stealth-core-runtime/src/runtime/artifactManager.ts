const isBrowser = typeof window !== 'undefined';

type PathModule = typeof import('path');
type OsModule = typeof import('os');

async function getNodeDeps(): Promise<{ path: PathModule; os: OsModule }> {
  if (isBrowser) {
    throw new Error('Artifact manager Node deps unavailable in browser host');
  }
  const [pathMod, osMod] = await Promise.all([import('path'), import('os')]);
  return { path: pathMod, os: osMod };
}

const hashString = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(16, '0');
};
import type { Plan, ExecutionResult, Evaluation } from '../internalTypes';
import type { IFsAdapter } from '../internalTypes';

const WORKSPACE_ARTIFACT_NAMES = new Set(['agent-report.json', 'plans', 'backups', 'embeddings.json']);

export interface ArtifactManagerDeps {
  fs: IFsAdapter;
  resolvePlanRunDirectory(workspaceRoot: string): string;
  getRunContext(): { conversationId?: string | null; runId?: string | null } | undefined;
  writeWorkspaceFile(path: string, content: string): Promise<void>;
  readWorkspaceFile(path: string): Promise<string>;
}

export interface ArtifactSetupOptions {
  workspaceRoot: string;
  emitArtifacts: boolean;
  storagePath?: string;
  globalStoragePath?: string;
}

export interface ExportPlanOptions {
  workspaceRoot: string;
  goal: string;
  plan: Plan;
  results: ExecutionResult[];
  evaluation: Evaluation;
}

export function createArtifactManager(deps: ArtifactManagerDeps) {
  let artifactRoot: string | undefined;

  async function setup(options: ArtifactSetupOptions): Promise<void> {
    if (options.emitArtifacts) {
      const { path } = await getNodeDeps();
      const root = path.join(options.workspaceRoot, '.bandit');
      await deps.fs.ensureDir(root).catch(() => undefined);
      artifactRoot = root;
      await ensureGitIgnoreEntry(options.workspaceRoot);
      return;
    }

    const { path, os } = await getNodeDeps();
    const storageBase =
      options.storagePath ?? options.globalStoragePath ?? path.join(os.tmpdir(), 'bandit-stealth');
    await cleanupWorkspaceArtifacts(path.join(options.workspaceRoot, '.bandit'));
    const workspaceKey = hashString(options.workspaceRoot);
    const root = path.join(storageBase, 'artifacts', workspaceKey);
    await deps.fs.ensureDir(root).catch(() => undefined);
    artifactRoot = root;
  }

  function getArtifactRoot(): string {
    if (!artifactRoot) {
      throw new Error('Agent artifact storage not initialized.');
    }
    return artifactRoot;
  }

  function getArtifactRootOrDefault(workspaceRoot: string): string {
    if (artifactRoot) {return artifactRoot;}
    if (isBrowser) {
      return `${workspaceRoot.replace(/\/+$/, '')}/.bandit`;
    }
    return `${workspaceRoot.replace(/\/+$/, '')}/.bandit`;
  }

  async function exportPlan(options: ExportPlanOptions): Promise<void> {
    const { path } = await getNodeDeps();
    const folder = deps.resolvePlanRunDirectory(options.workspaceRoot);
    await deps.fs.ensureDir(folder);
    const context = deps.getRunContext();
    const file = path.join(folder, 'plan.json');
    const payload = {
      conversationId: context?.conversationId ?? null,
      runId: context?.runId ?? null,
      goal: options.goal,
      plan: options.plan,
      results: options.results,
      evaluation: options.evaluation,
      exportedAt: new Date().toISOString()
    };
    await deps.writeWorkspaceFile(file, JSON.stringify(payload, null, 2));
  }

  async function ensureGitIgnoreEntry(workspaceRoot: string): Promise<void> {
    const { path } = await getNodeDeps();
    const gitIgnorePath = path.join(workspaceRoot, '.gitignore');
    let contents = '';
    try {
      contents = await deps.readWorkspaceFile(gitIgnorePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return;
      }
    }

    const entry = '.bandit/';
    const normalizedEntry = entry.endsWith('/') ? `${entry}\n` : `${entry}/\n`;
    const lines = contents.split(/\r?\n/).map((line) => line.trim());
    if (lines.some((line) => line === entry.replace(/\/$/, '') || line === entry || line === '.bandit' || line === '.bandit/')) {
      return;
    }

    const suffix = contents.endsWith('\n') || contents.length === 0 ? '' : '\n';
    const banner = '# Bandit Stealth\n';
    const next = `${contents}${suffix}${banner}${normalizedEntry}`;
    try {
      await deps.writeWorkspaceFile(gitIgnorePath, next);
    } catch {
      // Ignore failures to modify .gitignore (e.g. read-only workspaces).
    }
  }

  async function cleanupWorkspaceArtifacts(folder: string): Promise<void> {
    try {
      const entries = await deps.fs.readDir(folder);
      const allowed = entries.every((entry) => WORKSPACE_ARTIFACT_NAMES.has(entry));
      if (!allowed) {
        return;
      }
      await deps.fs.remove(folder, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
    }
  }

  return {
    setup,
    getArtifactRoot,
    getArtifactRootOrDefault,
    exportPlan
  };
}
