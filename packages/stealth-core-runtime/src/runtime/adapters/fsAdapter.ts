import type { IFsAdapter } from '../../hostTypes';

const isBrowser = typeof window !== 'undefined';

type FsPromises = typeof import('fs').promises;
type PathModule = typeof import('path');

async function getNodeDeps(): Promise<{ fsp: FsPromises; path: PathModule }> {
  if (isBrowser) {
    throw new Error('Node fs adapter is unavailable in the browser host.');
  }
  const [fsMod, pathMod] = await Promise.all([import('fs'), import('path')]);
  return { fsp: fsMod.promises, path: pathMod };
}

export interface NodeFsAdapterOptions {
  encoding?: BufferEncoding;
}

export function createNodeFsAdapter(workspaceRoot: string, options: NodeFsAdapterOptions = {}): IFsAdapter {
  if (isBrowser) {
    const thrower = () => {
      throw new Error('createNodeFsAdapter is not available in the browser host');
    };
    return {
      readText: thrower,
      writeText: thrower,
      exists: async () => false,
      listRecursive: async () => [],
      ensureDir: thrower,
      readDir: async () => [],
      remove: thrower
    };
  }

  let root = workspaceRoot;
  let pathMod: PathModule | undefined;
  const defaultEncoding = options.encoding ?? 'utf8';

  function resolvePath(input: string): string {
    const path = pathMod!;
    return path.isAbsolute(input) ? input : path.join(root, input);
  }

  return {
    async readText(absPath: string, encoding?: BufferEncoding): Promise<string> {
      const { fsp, path } = await getNodeDeps();
      pathMod = path;
      root = path.resolve(workspaceRoot);
      const target = resolvePath(absPath);
      return fsp.readFile(target, encoding ?? defaultEncoding);
    },
    async writeText(absPath: string, content: string, encoding?: BufferEncoding): Promise<void> {
      const { fsp, path } = await getNodeDeps();
      pathMod = path;
      root = path.resolve(workspaceRoot);
      const target = resolvePath(absPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, encoding ?? defaultEncoding);
    },
    async exists(absPath: string): Promise<boolean> {
      try {
        const { fsp, path } = await getNodeDeps();
        pathMod = path;
        root = path.resolve(workspaceRoot);
        await fsp.access(resolvePath(absPath));
        return true;
      } catch {
        return false;
      }
    },
    async listRecursive(rootPath: string): Promise<string[]> {
      const { fsp, path } = await getNodeDeps();
      pathMod = path;
      root = path.resolve(workspaceRoot);
      const start = resolvePath(rootPath);
      const results: string[] = [];

      async function walk(current: string): Promise<void> {
        const entries = await fsp.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            await walk(entryPath);
          } else if (entry.isFile()) {
            results.push(entryPath);
          }
        }
      }

      await walk(start);
      return results;
    },
    async ensureDir(absPath: string): Promise<void> {
      const { fsp, path } = await getNodeDeps();
      pathMod = path;
      root = path.resolve(workspaceRoot);
      await fsp.mkdir(resolvePath(absPath), { recursive: true });
    },
    async readDir(absPath: string): Promise<string[]> {
      const { fsp, path } = await getNodeDeps();
      pathMod = path;
      root = path.resolve(workspaceRoot);
      return fsp.readdir(resolvePath(absPath));
    },
    async remove(absPath: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
      const { fsp, path } = await getNodeDeps();
      pathMod = path;
      root = path.resolve(workspaceRoot);
      await fsp.rm(resolvePath(absPath), options);
    }
  };
}
