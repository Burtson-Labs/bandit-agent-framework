import type { WorkspaceIndexSnapshot } from '../internalTypes';

export interface SymbolReference {
  symbol: string;
  file: string;
  line: number;
  importPath?: string;
}

export interface WorkspaceIndexerDeps {
  getWorkspaceRoot(): string;
  loadWorkspaceIndex(force?: boolean): Promise<string[]>;
  getWorkspaceIndexSnapshot(): WorkspaceIndexSnapshot | undefined;
  readWorkspaceFile(relativePath: string): Promise<string>;
  normalizeRelativePath(value: string): string | undefined;
}

export interface WorkspaceIndexer {
  findReferences(symbol: string): Promise<SymbolReference[]>;
  warm(symbols: string[]): Promise<void>;
  clearCache(): void;
}

const MAX_REFERENCES_PER_FILE = 5;
const MAX_TOTAL_REFERENCES = 40;
const MAX_SCANNED_FILES = 250;

export function createWorkspaceIndexer(deps: WorkspaceIndexerDeps): WorkspaceIndexer {
  const referenceCache = new Map<string, SymbolReference[]>();

  async function findReferences(symbol: string): Promise<SymbolReference[]> {
    const normalizedSymbol = symbol?.trim();
    if (!normalizedSymbol) {
      return [];
    }
    const cacheKey = normalizedSymbol.toLowerCase();
    if (referenceCache.has(cacheKey)) {
      return referenceCache.get(cacheKey) ?? [];
    }
    await ensureIndex();
    const snapshot = deps.getWorkspaceIndexSnapshot();
    if (!snapshot) {
      referenceCache.set(cacheKey, []);
      return [];
    }

    const references: SymbolReference[] = [];
    const pattern = buildSymbolPattern(normalizedSymbol);
    const files = snapshot.files.slice(0, MAX_SCANNED_FILES);
    for (const file of files) {
      if (!shouldScanFile(file.path)) {
        continue;
      }
      if (file.preview && !file.preview.includes(symbol)) {
        continue;
      }
      try {
        const content = await deps.readWorkspaceFile(file.path);
        const matches = locateSymbol(content, pattern);
        matches.forEach((line) => {
          if (references.length >= MAX_TOTAL_REFERENCES) {
            return;
          }
          references.push({
            symbol: normalizedSymbol,
            file: file.path,
            line,
            importPath: inferImportAlias(content, normalizedSymbol)
          });
        });
      } catch {
        // ignore unreadable files
      }
    }

    referenceCache.set(cacheKey, references);
    return references;
  }

  async function warm(symbols: string[]): Promise<void> {
    await Promise.all(symbols.map((symbol) => findReferences(symbol).catch(() => undefined)));
  }

  function clearCache(): void {
    referenceCache.clear();
  }

  async function ensureIndex(): Promise<void> {
    if (!deps.getWorkspaceIndexSnapshot()) {
      await deps.loadWorkspaceIndex(true).catch(() => []);
    }
  }

  return { findReferences, warm, clearCache };
}

function buildSymbolPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

function shouldScanFile(relativePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(relativePath);
}

function locateSymbol(content: string, pattern: RegExp): number[] {
  const lines = content.split(/\r?\n/);
  const matches: number[] = [];
  lines.forEach((line, index) => {
    if (matches.length >= MAX_REFERENCES_PER_FILE) {
      return;
    }
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      matches.push(index + 1);
    }
  });
  return matches;
}

function inferImportAlias(content: string, symbol: string): string | undefined {
  const importRegex = new RegExp(
    `import\\s+(?:\\{[^}]*${symbol}[^}]*\\}|${symbol})\\s+from\\s+['"]([^'"]+)['"]`,
    'i'
  );
  const match = content.match(importRegex);
  return match?.[1];
}
