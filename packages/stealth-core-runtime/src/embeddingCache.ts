const isBrowser = typeof window !== 'undefined';

type FsModule = typeof import('fs').promises;
type PathModule = typeof import('path');
async function getNodeDeps(): Promise<{ fs: FsModule; path: PathModule }> {
  if (isBrowser) {
    throw new Error('EmbeddingCache is unavailable in browser hosts.');
  }
  const [fsMod, pathMod] = await Promise.all([import('fs'), import('path')]);
  return { fs: fsMod.promises, path: pathMod };
}

export interface EmbeddingRecord {
  readonly vector: number[];
  readonly mtimeMs: number;
  readonly size: number;
  readonly lastUsed: number;
}

interface EmbeddingCacheFile {
  version: number;
  entries: Record<string, EmbeddingRecord>;
}

const CACHE_VERSION = 1;
const MAX_VECTOR_LENGTH = 32;

const hashString = (value: string): number[] => {
  let hash = 0x811c9dc5;
  const vector: number[] = [];
  for (let i = 0; i < value.length && vector.length < MAX_VECTOR_LENGTH; i += 2) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    const normalized = (hash >>> 0) / 0xffffffff;
    vector.push(normalized);
  }
  while (vector.length < MAX_VECTOR_LENGTH) {
    hash ^= 0x9e3779b9;
    const normalized = (hash >>> 0) / 0xffffffff;
    vector.push(normalized);
  }
  return vector.slice(0, MAX_VECTOR_LENGTH);
};

const computeVector = (content: string, seed: string): number[] => hashString(`${seed}:${content}`);

export class EmbeddingCache {
  private cachePath: string | undefined;
  private entries = new Map<string, EmbeddingRecord>();
  private dirty = false;

  private artifactRoot: string | undefined;
  private workspaceRoot: string | undefined;

  public async prepare(workspaceRoot: string, artifactRoot: string): Promise<void> {
    if (isBrowser) {
      this.workspaceRoot = workspaceRoot;
      this.artifactRoot = artifactRoot;
      this.entries.clear();
      this.dirty = false;
      this.cachePath = undefined;
      return;
    }
    const { fs, path } = await getNodeDeps();
    this.workspaceRoot = workspaceRoot;
    this.artifactRoot = artifactRoot;
    await fs.mkdir(artifactRoot, { recursive: true }).catch(() => undefined);
    this.cachePath = path.join(artifactRoot, 'embeddings.json');
    this.entries.clear();
    this.dirty = false;
    await this.load();
  }

  public async flush(): Promise<void> {
    if (!this.cachePath || !this.dirty) {
      return;
    }
    if (isBrowser) {
      this.dirty = false;
      return;
    }
    const { fs } = await getNodeDeps();
    const payload: EmbeddingCacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries)
    };
    await fs.writeFile(this.cachePath, JSON.stringify(payload, null, 2), 'utf8');
    this.dirty = false;
  }

  public async indexFiles(workspaceRoot: string, relativePaths: string[]): Promise<{ reused: number; computed: number }> {
    if (isBrowser) {
      return { reused: 0, computed: 0 };
    }
    if (!this.cachePath || !this.workspaceRoot || !this.artifactRoot || this.workspaceRoot !== workspaceRoot) {
      const { path } = await getNodeDeps();
      const root = this.artifactRoot ?? path.join(workspaceRoot, '.bandit');
      await this.prepare(workspaceRoot, root);
    }
    const { fs, path } = await getNodeDeps();
    const results = { reused: 0, computed: 0 };
    const now = Date.now();
    for (const relativePath of relativePaths) {
      try {
        const absolute = path.join(workspaceRoot, relativePath);
        const stats = await fs.stat(absolute);
        const key = relativePath;
        const existing = this.entries.get(key);
        if (existing && Math.abs(existing.mtimeMs - stats.mtimeMs) < 1 && existing.size === stats.size) {
          this.entries.set(key, { ...existing, lastUsed: now });
          results.reused += 1;
          continue;
        }
        const chunk = await this.readSample(absolute);
        const vector = computeVector(chunk, relativePath);
        this.entries.set(key, {
          vector,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          lastUsed: now
        });
        this.dirty = true;
        results.computed += 1;
      } catch {
        // Ignore indexing failures for non-existent or unreadable files.
      }
    }
    return results;
  }

  public getEmbedding(relativePath: string): EmbeddingRecord | undefined {
    const record = this.entries.get(relativePath);
    if (record) {
      this.entries.set(relativePath, { ...record, lastUsed: Date.now() });
    }
    return record;
  }

  private async load(): Promise<void> {
    if (!this.cachePath) {
      return;
    }
    if (isBrowser) {
      return;
    }
    const { fs } = await getNodeDeps();
    try {
      const text = await fs.readFile(this.cachePath, 'utf8');
      const payload = JSON.parse(text) as EmbeddingCacheFile;
      if (payload.version !== CACHE_VERSION || typeof payload.entries !== 'object' || !payload.entries) {
        return;
      }
      for (const [key, record] of Object.entries(payload.entries)) {
        if (Array.isArray(record.vector) && record.vector.length > 0) {
          this.entries.set(key, record);
        }
      }
    } catch {
      // ignore load errors
    }
  }

  private async readSample(filePath: string): Promise<string> {
    if (isBrowser) {
      return '';
    }
    const { fs } = await getNodeDeps();
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return '';
    }
  }
}
