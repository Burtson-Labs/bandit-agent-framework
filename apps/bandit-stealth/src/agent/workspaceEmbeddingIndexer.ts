import * as path from 'path';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import type { WorkspaceIndexSnapshot } from '@burtson-labs/stealth-core-runtime';
import type { StealthEmbeddingClient } from '@burtson-labs/stealth-core-runtime';

interface EmbeddingManifestEntry {
  fileHash: string;
  chunkHashes: string[];
}

interface EmbeddingManifest {
  version: number;
  files: Record<string, EmbeddingManifestEntry>;
}

export interface WorkspaceEmbeddingIndexerOptions {
  artifactRoot: string;
  maxFileBytes?: number;
  chunkLineCount?: number;
}

export interface EmbeddingSyncStats {
  processed: number;
  upserts: number;
  skipped: number;
  errors: number;
}

const MANIFEST_VERSION = 1;
const MANIFEST_FILENAME = 'embedding-manifest-v1.json';
const DEFAULT_CHUNK_LINE_COUNT = 256;
const DEFAULT_MAX_FILE_BYTES = 750_000;
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.svelte',
  '.vue',
  '.cs'
]);

export class WorkspaceEmbeddingIndexer {
  private readonly artifactRoot: string;
  private readonly manifestPath: string;
  private readonly maxFileBytes: number;
  private readonly chunkLineCount: number;
  private manifest: EmbeddingManifest | undefined;

  constructor(options: WorkspaceEmbeddingIndexerOptions) {
    this.artifactRoot = options.artifactRoot;
    this.manifestPath = path.join(this.artifactRoot, MANIFEST_FILENAME);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.chunkLineCount = Math.max(32, options.chunkLineCount ?? DEFAULT_CHUNK_LINE_COUNT);
  }

  public async synchronize(snapshot: WorkspaceIndexSnapshot, client: StealthEmbeddingClient): Promise<EmbeddingSyncStats> {
    await fs.mkdir(this.artifactRoot, { recursive: true }).catch(() => undefined);
    await this.loadManifest();
    const stats: EmbeddingSyncStats = { processed: 0, upserts: 0, skipped: 0, errors: 0 };

    for (const file of snapshot.files) {
      if (!this.shouldEmbedFile(file)) {
        continue;
      }
      stats.processed += 1;
      try {
        const upserted = await this.syncFile(snapshot.root, file, client);
        if (upserted > 0) {
          stats.upserts += upserted;
        } else {
          stats.skipped += 1;
        }
      } catch (error) {
        stats.errors += 1;
        console.warn('Failed to sync embedding for', file.path, error);
      }
    }

    await this.writeManifest().catch(() => undefined);
    return stats;
  }

  private shouldEmbedFile(record: { path: string; size: number }): boolean {
    if (!record.path) {
      return false;
    }
    if (record.size <= 0 || record.size > this.maxFileBytes) {
      return false;
    }
    const ext = path.extname(record.path).toLowerCase();
    if (!ext) {
      return true; // include extension-less files if small enough
    }
    return TEXT_EXTENSIONS.has(ext);
  }

  private async syncFile(root: string, record: { path: string; hash: string }, client: StealthEmbeddingClient): Promise<number> {
    const absolute = path.join(root, record.path);
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf8');
    } catch {
      return 0;
    }
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const chunks: { text: string; startLine: number; endLine: number; index: number }[] = [];
    for (let index = 0; index < lines.length; index += this.chunkLineCount) {
      const slice = lines.slice(index, index + this.chunkLineCount);
      const text = slice.join('\n').trim();
      if (!text) {
        continue;
      }
      chunks.push({
        text,
        startLine: index + 1,
        endLine: index + slice.length,
        index: chunks.length
      });
    }

    if (!chunks.length) {
      return 0;
    }

    const manifestEntry = this.ensureManifestEntry(record.path, record.hash, chunks.length);
    let upserts = 0;

    for (const chunk of chunks) {
      const chunkHash = createHash('sha1').update(record.hash).update(String(chunk.index)).update(chunk.text).digest('hex');
      if (manifestEntry.fileHash === record.hash && manifestEntry.chunkHashes[chunk.index] === chunkHash) {
        continue;
      }
      await client.upsertDocument({
        path: `${record.path}#${chunk.startLine}-${chunk.endLine}`,
        content: chunk.text,
        metadata: {
          path: record.path,
          fileHash: record.hash,
          chunkIndex: chunk.index,
          chunkCount: chunks.length,
          startLine: chunk.startLine,
          endLine: chunk.endLine
        }
      });
      manifestEntry.chunkHashes[chunk.index] = chunkHash;
      manifestEntry.fileHash = record.hash;
      upserts += 1;
    }

    // Trim unused manifest entries if chunk count shrank.
    if (manifestEntry.chunkHashes.length > chunks.length) {
      manifestEntry.chunkHashes.length = chunks.length;
    }

    return upserts;
  }

  private ensureManifestEntry(pathValue: string, fileHash: string, chunkCount: number): EmbeddingManifestEntry {
    if (!this.manifest) {
      this.manifest = { version: MANIFEST_VERSION, files: {} };
    }
    const existing = this.manifest.files[pathValue];
    if (existing) {
      if (existing.chunkHashes.length < chunkCount) {
        existing.chunkHashes.length = chunkCount;
      }
      return existing;
    }
    const entry: EmbeddingManifestEntry = {
      fileHash,
      chunkHashes: Array(chunkCount).fill('')
    };
    this.manifest.files[pathValue] = entry;
    return entry;
  }

  private async loadManifest(): Promise<void> {
    try {
      const contents = await fs.readFile(this.manifestPath, 'utf8');
      const payload = JSON.parse(contents) as EmbeddingManifest;
      if (payload.version === MANIFEST_VERSION && payload.files) {
        this.manifest = payload;
        return;
      }
    } catch {
      // ignore
    }
    this.manifest = { version: MANIFEST_VERSION, files: {} };
  }

  private async writeManifest(): Promise<void> {
    if (!this.manifest) {
      return;
    }
    await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
  }
}
