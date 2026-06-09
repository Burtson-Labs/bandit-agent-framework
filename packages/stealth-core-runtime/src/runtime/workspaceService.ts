import * as path from 'path';
import type { IFsAdapter } from '../hostTypes';

export interface WorkspaceServiceDeps {
  fs: IFsAdapter;
  getWorkspaceRoot(): string;
}

export function createWorkspaceService(deps: WorkspaceServiceDeps) {
  async function readFile(target: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return deps.fs.readText(target, encoding);
  }

  async function writeFile(target: string, content: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
    await deps.fs.writeText(target, content, encoding);
  }

  async function fileExists(target: string): Promise<boolean> {
    return deps.fs.exists(target);
  }

  async function pathExists(target: string): Promise<boolean> {
    try {
      return await fileExists(target);
    } catch {
      return false;
    }
  }

  function normalizeRelativePath(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const replaced = trimmed.replace(/\\/g, '/').replace(/[\r\n]/g, '');
    if (replaced.startsWith('~') || replaced.startsWith('/') || replaced.startsWith('.\\')) {
      return undefined;
    }
    const normalized = path.posix.normalize(replaced.replace(/^\.\/+/, ''));
    if (!normalized || normalized === '.' || normalized.startsWith('..')) {
      return undefined;
    }
    return normalized;
  }

  function isPathInside(base: string, target: string): boolean {
    const normalizedBase = path.resolve(base);
    const normalizedTarget = path.resolve(target);
    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
  }

  return {
    readFile,
    writeFile,
    fileExists,
    pathExists,
    normalizeRelativePath,
    isPathInside
  };
}
