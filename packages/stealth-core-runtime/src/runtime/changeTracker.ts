import * as path from 'path';
import type { FileChangeSnapshot, IDiffManager, IFsAdapter } from '../internalTypes';

export interface ChangeTrackerDeps {
  diffManager: IDiffManager;
  fs: IFsAdapter;
  notifySnapshotCount(count: number): void;
}

export function createChangeTracker(deps: ChangeTrackerDeps) {
  function recordSnapshot(snapshot: FileChangeSnapshot): void {
    deps.diffManager.recordSnapshot(snapshot);
    deps.notifySnapshotCount(deps.diffManager.getSnapshotCount());
  }

  function hasSnapshots(): boolean {
    return deps.diffManager.hasSnapshots();
  }

  function getSnapshotCount(): number {
    return deps.diffManager.getSnapshotCount();
  }

  async function undoLastChange(): Promise<FileChangeSnapshot | null> {
    const snapshot = deps.diffManager.popSnapshot();
    if (!snapshot) {
      return null;
    }
    try {
      if (snapshot.existedBefore) {
        await deps.fs.writeText(snapshot.absolutePath, snapshot.before, snapshot.encoding);
      } else {
        try {
          await deps.fs.remove(snapshot.absolutePath, { force: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== 'ENOENT') {
            throw error;
          }
        }
      }
      deps.notifySnapshotCount(deps.diffManager.getSnapshotCount());
      return snapshot;
    } catch (error) {
      deps.diffManager.recordSnapshot(snapshot);
      deps.notifySnapshotCount(deps.diffManager.getSnapshotCount());
      throw error;
    }
  }

  async function capturePreWriteState(
    workspaceRoot: string,
    relativePath: string,
    encoding: BufferEncoding,
    fallback?: string
  ): Promise<{ absolutePath: string; before: string; existedBefore: boolean }> {
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    try {
      const before = await deps.fs.readText(absolutePath, encoding);
      return { absolutePath, before, existedBefore: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return {
          absolutePath,
          before: typeof fallback === 'string' ? fallback : '',
          existedBefore: false
        };
      }
      console.warn(`Unable to capture snapshot for ${relativePath}`, error);
      return {
        absolutePath,
        before: typeof fallback === 'string' ? fallback : '',
        existedBefore: true
      };
    }
  }

  async function createBackup(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const workspaceBackupsRoot = path.join(workspaceRoot, '.bandit', 'backups');
    const sanitizedPath = relativePath.replace(/\\/g, '/').replace(/^((\.\.)?\/)+/, '').replace(/^\/+/, '');
    const backupPath = path.join(workspaceBackupsRoot, timestamp, `${sanitizedPath}.bak`);
    await deps.fs.writeText(backupPath, content);
    await ensureGitIgnoreEntry(workspaceRoot, '.bandit/');
    return path.relative(workspaceRoot, backupPath).replace(/\\/g, '/');
  }

  async function ensureGitIgnoreEntry(workspaceRoot: string, entry: string): Promise<void> {
    const gitIgnorePath = path.join(workspaceRoot, '.gitignore');
    let contents = '';
    try {
      contents = await deps.fs.readText(gitIgnorePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && code !== 'ENOENT') {
        return;
      }
    }
    const normalized = entry.endsWith('/') ? entry : `${entry}/`;
    const normalizedTrimmed = normalized.replace(/\/$/, '');
    const lines = contents.split(/\r?\n/).map((line) => line.trim());
    if (lines.some((line) => line === normalizedTrimmed || line === normalized || line === `${normalizedTrimmed}/`)) {
      return;
    }
    const prefix = contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
    const snippet = `# Bandit Stealth\n${normalized}\n`;
    try {
      await deps.fs.writeText(gitIgnorePath, `${contents}${prefix}${snippet}`);
    } catch {
      // ignore failures for read-only workspaces
    }
  }

  return {
    recordSnapshot,
    hasSnapshots,
    getSnapshotCount,
    undoLastChange,
    capturePreWriteState,
    createBackup,
    ensureGitIgnoreEntry
  };
}
