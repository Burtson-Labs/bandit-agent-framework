import * as path from 'path';
import type { WorkspaceFileRecord } from '../internalTypes';
import type { HydratedRewriteFile, RewriteHydrationContext } from '../internalTypes';

export interface RewriteHydrationDeps {
  normalizeRelativePath(value: string): string | undefined;
  getWorkspaceFileRecord(relativePath: string): WorkspaceFileRecord | undefined;
  getWorkspaceRoot(): string;
  readWorkspaceFile(path: string): Promise<string>;
}

export interface RewriteHydrationConfig {
  maxEditable: number;
  maxReadonly: number;
  maxSecondaryContext: number;
}

export function createRewriteHydrationManager(
  deps: RewriteHydrationDeps,
  config: RewriteHydrationConfig
) {
  const normalizePath = (value: string): string | undefined => {
    if (!value) {
      return undefined;
    }
    const normalized = deps.normalizeRelativePath(value);
    if (normalized) {
      return normalized;
    }
    const sanitized = value.replace(/\\+/g, '/').replace(/^\.\/+/, '');
    return sanitized || undefined;
  };

  async function loadFiles(paths: string[]): Promise<HydratedRewriteFile[]> {
    if (!paths.length) {
      return [];
    }
    const workspaceRoot = deps.getWorkspaceRoot();
    const results: HydratedRewriteFile[] = [];
    for (const rawPath of paths) {
      const normalized = normalizePath(rawPath) ?? rawPath;
      if (!normalized) {
        continue;
      }
      const record = deps.getWorkspaceFileRecord(normalized);
      const canonical = record?.path ?? normalized;
      const absolute = path.join(workspaceRoot, canonical);
      let content: string;
      try {
        content = await deps.readWorkspaceFile(absolute);
      } catch {
        continue;
      }
      results.push({
        path: canonical,
        content,
        size: record?.size,
        hash: record?.hash
      });
    }
    return results;
  }

  async function buildContext(
    step:
      | { filesToEdit?: string[]; filesToReadOnly?: string[]; metadata?: Record<string, unknown> }
      | undefined,
    relativePath?: string
  ): Promise<RewriteHydrationContext | undefined> {
    if (!step) {
      return undefined;
    }
    const metadata = step.metadata ?? {};
    const editTargets = new Map<string, string>();
    const readOnlyTargets = new Map<string, string>();

    const register = (value: string | undefined, target: Map<string, string>) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return;
      }
      const normalized = normalizePath(value);
      if (!normalized) {
        return;
      }
      const key = normalized.toLowerCase();
      if (!target.has(key)) {
        target.set(key, normalized);
      }
    };

    const registerMany = (value: unknown, target: Map<string, string>) => {
      if (!Array.isArray(value)) {
        return;
      }
      value.forEach((entry) => {
        if (typeof entry === 'string') {
          register(entry, target);
        }
      });
    };

    if (relativePath) {
      register(relativePath, editTargets);
    }
    registerMany(step.filesToEdit, editTargets);
    registerMany(metadata['filesToEdit'], editTargets);

    registerMany(step.filesToReadOnly, readOnlyTargets);
    registerMany(metadata['filesToReadOnly'], readOnlyTargets);
    registerMany(metadata['helperPaths'], readOnlyTargets);

    const filteredReadOnly = Array.from(readOnlyTargets.entries()).filter(
      ([key]) => !editTargets.has(key)
    );
    const editablePaths = Array.from(editTargets.values()).slice(0, config.maxEditable);
    const readOnlyPaths = filteredReadOnly.map(([, value]) => value).slice(0, config.maxReadonly);

    if (editablePaths.length === 0 && readOnlyPaths.length === 0) {
      return undefined;
    }

    const editable = await loadFiles(editablePaths);
    const readonly = await loadFiles(readOnlyPaths);

    if (!editable.length && !readonly.length) {
      return undefined;
    }

    return { editable, readonly };
  }

  function buildBlocks(
    hydration: RewriteHydrationContext | undefined,
    primaryPath: string | undefined
  ): string[] {
    if (!hydration) {
      return [];
    }
    const blocks: string[] = [];
    const normalizedPrimary = primaryPath
      ? (normalizePath(primaryPath) ?? primaryPath).toLowerCase()
      : undefined;

    const formatHeader = (label: string, file: HydratedRewriteFile): string => {
      const details: string[] = [];
      if (typeof file.size === 'number' && Number.isFinite(file.size)) {
        details.push(`${file.size} bytes`);
      }
      if (file.hash) {
        details.push(`sha1 ${file.hash.slice(0, 8)}`);
      }
      return details.length > 0 ? `${label} (${details.join(', ')})` : label;
    };

    const describeImports = (file: HydratedRewriteFile): string | undefined => {
      const specifiers = extractImportSpecifiers(file.content);
      if (!specifiers.length) {
        return undefined;
      }
      const lines = specifiers.slice(0, 12).map((specifier) => {
        const resolved = resolveSpecifier(file.path, specifier);
        return resolved ? `- ${specifier} → ${resolved}` : `- ${specifier}`;
      });
      if (specifiers.length > 12) {
        lines.push(`- …${specifiers.length - 12} more`);
      }
      return ['Imports & references:', ...lines].join('\n');
    };

    const resolveSpecifier = (sourcePath: string, specifier: string): string | undefined => {
      if (!specifier || !specifier.startsWith('.')) {
        return undefined;
      }
      const normalizedSource = normalizePath(sourcePath) ?? sourcePath.replace(/\\/g, '/');
      if (!normalizedSource) {
        return undefined;
      }
      const dir = normalizedSource.includes('/')
        ? normalizedSource.slice(0, normalizedSource.lastIndexOf('/'))
        : '.';
      const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, specifier));
      const candidates = expandImportResolutionCandidates(joined);
      for (const candidate of candidates) {
        const record = deps.getWorkspaceFileRecord(candidate);
        if (record) {
          return record.path;
        }
      }
      return undefined;
    };

    const pushBlock = (label: string, file: HydratedRewriteFile): void => {
      const normalized = normalizePath(file.path) ?? file.path;
      if (!normalized) {
        return;
      }
      blocks.push(`${label} — ${formatHeader(normalized, file)}:`);
      const imports = describeImports(file);
      if (imports) {
        blocks.push(imports);
      }
      blocks.push('```');
      blocks.push(clampContext(file.content, config.maxSecondaryContext));
      blocks.push('```');
    };

    hydration.editable.forEach((file) => {
      const normalized = normalizePath(file.path) ?? file.path;
      if (!normalized) {
        return;
      }
      if (normalizedPrimary && normalized.toLowerCase() === normalizedPrimary) {
        return;
      }
      pushBlock('Editable context', file);
    });

    hydration.readonly.forEach((file) => {
      pushBlock('Reference context', file);
    });

    return blocks;
  }

  return {
    buildContext,
    buildBlocks
  };
}

function clampContext(content: string, limit: number): string {
  if (!content || content.length <= limit) {
    return content;
  }
  return `${content.slice(0, limit)}\n/* trimmed to ${limit} characters */`;
}

function extractImportSpecifiers(content: string): string[] {
  if (!content) {
    return [];
  }
  const matches = new Set<string>();
  const importRegex = /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const exportRegex = /export\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/g;
  const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicImportRegex = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;
  const collect = (regex: RegExp) => {
    regex.lastIndex = 0;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        matches.add(match[1]);
      }
    }
  };
  collect(importRegex);
  collect(exportRegex);
  collect(requireRegex);
  collect(dynamicImportRegex);
  return Array.from(matches);
}

function expandImportResolutionCandidates(base: string): string[] {
  if (!base) {
    return [];
  }
  const sanitized = base.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  const candidates = new Set<string>();
  candidates.add(sanitized);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
  const hasExtension = path.posix.extname(sanitized) !== '';
  if (!hasExtension) {
    extensions.forEach((ext) => candidates.add(`${sanitized}${ext}`));
    ['index.ts', 'index.tsx', 'index.js', 'index.jsx'].forEach((indexFile) => {
      candidates.add(`${sanitized}/${indexFile}`);
    });
  }
  return Array.from(candidates);
}
