const isBrowser = typeof window !== 'undefined';

type PathModule = typeof import('path');
type FsModule = typeof import('fs');
type CryptoModule = typeof import('crypto');

async function getNodeDeps(): Promise<{
  path: PathModule;
  fs: FsModule['promises'];
  createReadStream: FsModule['createReadStream'];
  createHash: CryptoModule['createHash'];
}> {
  if (isBrowser) {
    throw new Error('WorkspaceIndex is unavailable in browser hosts.');
  }
  const [pathMod, fsMod, cryptoMod] = await Promise.all([import('path'), import('fs'), import('crypto')]);
  return { path: pathMod, fs: fsMod.promises, createReadStream: fsMod.createReadStream, createHash: cryptoMod.createHash };
}

export interface WorkspaceFileRecord {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
  preview?: string;
}

export interface WorkspaceIndexSnapshot {
  version: number;
  generatedAt: number;
  root: string;
  files: WorkspaceFileRecord[];
  totalBytes: number;
}

export interface WorkspaceIndexOptions {
  workspaceRoot: string;
  artifactRoot: string;
  excludeDirectories?: string[];
  previewBytes?: number;
}

const INDEX_VERSION = 1;
const DEFAULT_EXCLUDE_DIRECTORIES = [
  'node_modules', '.git', 'dist', 'build', 'out', '.bandit',
  '.vsce', '.turbo', '__pycache__', 'vendor', '.next', '.cache', '.vscode', '.idea'
];
const DEFAULT_PREVIEW_BYTES = 2048;
const INDEX_FILENAME = 'workspace-index-v1.json';

export class WorkspaceIndex {
  private readonly workspaceRoot: string;
  private readonly artifactRoot: string;
  private readonly excludeDirectories: Set<string>;
  private readonly previewBytes: number;
  private readonly indexPath: string;

  private snapshot: WorkspaceIndexSnapshot | undefined;

  constructor(options: WorkspaceIndexOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.artifactRoot = options.artifactRoot;
    this.excludeDirectories = new Set(
      (options.excludeDirectories ?? DEFAULT_EXCLUDE_DIRECTORIES).map((dir) => dir.toLowerCase())
    );
    this.previewBytes = Math.max(512, options.previewBytes ?? DEFAULT_PREVIEW_BYTES);
    this.indexPath = `${this.artifactRoot.replace(/\/+$/, '')}/${INDEX_FILENAME}`;
  }

  public getSnapshot(): WorkspaceIndexSnapshot | undefined {
    return this.snapshot;
  }

  public async load(force = false): Promise<WorkspaceIndexSnapshot> {
    if (isBrowser) {
      const snapshot = {
        version: INDEX_VERSION,
        generatedAt: Date.now(),
        root: this.workspaceRoot,
        files: [],
        totalBytes: 0
      };
      this.snapshot = snapshot;
      return snapshot;
    }

    const { fs } = await getNodeDeps();
    if (!force && this.snapshot) {
      return this.snapshot;
    }

    await fs.mkdir(this.artifactRoot, { recursive: true }).catch(() => undefined);

    if (!force) {
      const diskSnapshot = await this.readFromDisk();
      if (diskSnapshot) {
        this.snapshot = diskSnapshot;
        return diskSnapshot;
      }
    }

    const refreshed = await this.scanWorkspace();
    await this.writeToDisk(refreshed).catch(() => undefined);
    this.snapshot = refreshed;
    return refreshed;
  }

  public async refresh(): Promise<WorkspaceIndexSnapshot> {
    if (isBrowser) {
      const snapshot = {
        version: INDEX_VERSION,
        generatedAt: Date.now(),
        root: this.workspaceRoot,
        files: [],
        totalBytes: 0
      };
      this.snapshot = snapshot;
      return snapshot;
    }
    const snapshot = await this.scanWorkspace();
    await this.writeToDisk(snapshot).catch(() => undefined);
    this.snapshot = snapshot;
    return snapshot;
  }

  public list(): WorkspaceFileRecord[] {
    return this.snapshot?.files ?? [];
  }

  public findByBasename(basename: string): WorkspaceFileRecord[] {
    const normalized = basename.toLowerCase();
    return this.list().filter((file) => file.path.toLowerCase().endsWith(`/${normalized}`) || file.path.toLowerCase() === normalized);
  }

  public hasFile(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    return this.list().some((file) => file.path.toLowerCase() === normalized);
  }

  public getRoot(): string {
    return this.workspaceRoot;
  }

  private async readFromDisk(): Promise<WorkspaceIndexSnapshot | undefined> {
    if (isBrowser) {return undefined;}
    const { fs } = await getNodeDeps();
    try {
      const contents = await fs.readFile(this.indexPath, 'utf8');
      const payload = JSON.parse(contents) as WorkspaceIndexSnapshot;
      if (payload.version === INDEX_VERSION && Array.isArray(payload.files)) {
        return payload;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private async writeToDisk(snapshot: WorkspaceIndexSnapshot): Promise<void> {
    if (isBrowser) {return;}
    const { fs } = await getNodeDeps();
    await fs.writeFile(this.indexPath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  private async scanWorkspace(): Promise<WorkspaceIndexSnapshot> {
    if (isBrowser) {
      return {
        version: INDEX_VERSION,
        generatedAt: Date.now(),
        root: this.workspaceRoot,
        files: [],
        totalBytes: 0
      };
    }
    const files: WorkspaceFileRecord[] = [];
    await this.walkDirectory(this.workspaceRoot, '', files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
      version: INDEX_VERSION,
      generatedAt: Date.now(),
      root: this.workspaceRoot,
      files,
      totalBytes
    };
  }

  private async walkDirectory(currentAbsolute: string, relative: string, files: WorkspaceFileRecord[]): Promise<void> {
    const { fs, path } = await getNodeDeps();
    try {
      const entries: Array<import('fs').Dirent<string>> = await fs.readdir(currentAbsolute, {
        withFileTypes: true,
        encoding: 'utf8' as BufferEncoding
      });

      for (const entry of entries) {
        const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const normalizedRelative = entryRelative.replace(/\\/g, '/');
        if (this.shouldSkip(normalizedRelative, entry.isDirectory())) {
          continue;
        }
        const entryAbsolute = path.join(currentAbsolute, entry.name);
        if (entry.isDirectory()) {
          await this.walkDirectory(entryAbsolute, normalizedRelative, files);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        try {
          const stats = await fs.stat(entryAbsolute);
          const hash = await this.computeHash(entryAbsolute);
          const preview = await this.readPreview(entryAbsolute);
          files.push({
            path: normalizedRelative,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            hash,
            preview
          });
        } catch {
          // ignore files we cannot read
        }
      }
    } catch {
      return;
    }
  }

  private shouldSkip(relativePath: string, isDirectory: boolean): boolean {
    if (!relativePath) {
      return false;
    }
    const fragments = relativePath.split('/');
    if (fragments.some((fragment) => this.excludeDirectories.has(fragment.toLowerCase()))) {
      return true;
    }
    if (!isDirectory) {
      return false;
    }
    return false;
  }

  private async computeHash(filePath: string): Promise<string> {
    if (isBrowser) {return '';}
    const { createHash, createReadStream } = await getNodeDeps();
    return await new Promise<string>((resolve) => {
      const hash = createHash('sha1');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(''));
    });
  }

  private async readPreview(filePath: string): Promise<string | undefined> {
    if (isBrowser) {return undefined;}
    const { fs } = await getNodeDeps();
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(this.previewBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 0) {
          return undefined;
        }
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}
