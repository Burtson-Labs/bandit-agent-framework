import * as path from 'path';
import type { IFsAdapter } from '../internalTypes';

export interface PersistenceSnapshot {
  planId?: string;
  goal?: string;
  currentStep?: number;
  pendingDiffs?: string[];
  diagnostics?: unknown;
  retryCount?: number;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
}

export interface PersistenceManager {
  save(workspaceRoot: string, snapshot: PersistenceSnapshot): Promise<void>;
  load(workspaceRoot: string): Promise<PersistenceSnapshot | undefined>;
  clear(workspaceRoot: string): Promise<void>;
}

export interface PersistenceDeps {
  fs: Pick<IFsAdapter, 'ensureDir' | 'writeText' | 'readText' | 'remove' | 'exists'>;
}

export function createPersistenceManager(deps: PersistenceDeps): PersistenceManager {
  async function save(workspaceRoot: string, snapshot: PersistenceSnapshot): Promise<void> {
    const target = resolveSessionFile(workspaceRoot);
    const directory = path.dirname(target);
    await deps.fs.ensureDir(directory);
    const payload = {
      ...snapshot,
      updatedAt: new Date().toISOString()
    };
    await deps.fs.writeText(target, JSON.stringify(payload, null, 2));
  }

  async function load(workspaceRoot: string): Promise<PersistenceSnapshot | undefined> {
    const target = resolveSessionFile(workspaceRoot);
    if (!(await deps.fs.exists(target))) {
      return undefined;
    }
    try {
      const content = await deps.fs.readText(target);
      return JSON.parse(content) as PersistenceSnapshot;
    } catch {
      return undefined;
    }
  }

  async function clear(workspaceRoot: string): Promise<void> {
    const target = resolveSessionFile(workspaceRoot);
    if (await deps.fs.exists(target)) {
      await deps.fs.remove(target, { force: true });
    }
  }

  return { save, load, clear };
}

function resolveSessionFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.bandit', 'sessions', 'current.json');
}
