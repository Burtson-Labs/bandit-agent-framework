import type { AdditionalWrite } from '../internalTypes';

export interface RewritePayloadOptions {
  primaryPath?: string;
  normalizePath(value: string): string | undefined;
  fileOpsStart: string;
  fileOpsEnd: string;
}

export function extractRewritePayload(text: string, options: RewritePayloadOptions): {
  content: string;
  additionalWrites: AdditionalWrite[];
} {
  const structuredEntries = parseStructuredFileOutputs(text);
  if (structuredEntries.length > 0) {
    const normalizedPrimary =
      typeof options.primaryPath === 'string'
        ? options.normalizePath(options.primaryPath) ?? options.primaryPath
        : undefined;
    const normalizedEntries = structuredEntries
      .map((entry) => {
        const normalizedPath = options.normalizePath(entry.path) ?? entry.path;
        if (!normalizedPath) {
          return undefined;
        }
        return { path: normalizedPath, content: entry.content };
      })
      .filter((entry): entry is { path: string; content: string } => Boolean(entry));

    if (normalizedEntries.length > 0) {
      let primaryEntry = normalizedPrimary
        ? normalizedEntries.find((entry) => entry.path === normalizedPrimary)
        : undefined;
      if (!primaryEntry) {
        primaryEntry = normalizedEntries[0];
      }
      const additionalWrites = normalizedEntries
        .filter((entry) => entry !== primaryEntry)
        .map((entry) => ({ path: entry.path, content: entry.content }));
      return {
        content: primaryEntry?.content ?? '',
        additionalWrites
      };
    }
  }

  const startIndex = text.indexOf(options.fileOpsStart);
  if (startIndex === -1) {
    return { content: text.trim(), additionalWrites: [] };
  }
  const endIndex = text.indexOf(options.fileOpsEnd, startIndex + options.fileOpsStart.length);
  if (endIndex === -1) {
    return { content: text.trim(), additionalWrites: [] };
  }
  const manifest = text.slice(startIndex + options.fileOpsStart.length, endIndex).trim();
  const before = text.slice(0, startIndex).trim();
  const after = text.slice(endIndex + options.fileOpsEnd.length).trim();
  const primary = [before, after].filter((segment) => segment.length > 0).join('\n\n');
  return {
    content: primary,
    additionalWrites: parseAdditionalWritesManifest(manifest, options.normalizePath)
  };
}

export function parseStructuredFileOutputs(text: string): Array<{ path: string; content: string }> {
  if (!text || !text.includes('FILE:')) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const blockMatch = normalized.match(/```files?\s*\n([\s\S]*?)\n```/i);
  const source = blockMatch ? blockMatch[1] : normalized;
  const lines = source.split('\n');
  const entries: Array<{ path: string; content: string }> = [];
  let currentPath: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (!currentPath) {
      buffer = [];
      return;
    }
    let content = buffer.join('\n');
    if (content.startsWith('\n')) {
      content = content.slice(1);
    }
    entries.push({ path: currentPath, content });
    currentPath = null;
    buffer = [];
  };

  for (const line of lines) {
    const headerMatch = line.match(/^\s*FILE:\s*(.+)$/i);
    if (headerMatch) {
      flush();
      const nextPath = normalizeStructuredFilePath(headerMatch[1] ?? '');
      currentPath = nextPath && nextPath.length > 0 ? nextPath : null;
      buffer = [];
      continue;
    }
    if (currentPath) {
      buffer.push(line);
    }
  }

  flush();
  return entries.filter((entry) => Boolean(entry.path));
}

function normalizeStructuredFilePath(rawPath: string): string | undefined {
  let value = rawPath.trim();
  if (!value) {
    return undefined;
  }
  value = value.replace(/^[*-]\s+/, '');
  const markdownLinkMatch = value.match(/^\[[^\]]+\]\((.+)\)$/);
  if (markdownLinkMatch?.[1]) {
    value = markdownLinkMatch[1].trim();
  }
  let previous = '';
  while (value && value !== previous) {
    previous = value;
    value = value.replace(/[;,]+$/g, '').trim();
    value = value.replace(/^`{1,3}(.+?)`{1,3}$/s, '$1').trim();
    value = value.replace(/^["'](.+)["']$/s, '$1').trim();
    value = value.replace(/^\((.+)\)$/s, '$1').trim();
  }
  value = value.replace(/[;,]+$/g, '').trim();
  if (!value) {
    return undefined;
  }
  return value;
}

export function parseAdditionalWritesManifest(
  manifest: string,
  normalizePath: (value: string) => string | undefined
): AdditionalWrite[] {
  if (!manifest) {
    return [];
  }
  try {
    const parsed = JSON.parse(manifest);
    const candidates = Array.isArray(parsed?.files)
      ? parsed.files
      : Array.isArray(parsed)
        ? parsed
        : [];
    return filterAdditionalWrites(candidates, normalizePath);
  } catch (error) {
    console.warn('Invalid additional file manifest encountered', error);
    return [];
  }
}

export function filterAdditionalWrites(
  raw: unknown,
  normalizePath: (value: string) => string | undefined
): AdditionalWrite[] {
  if (!raw) {
    return [];
  }
  const entries = Array.isArray(raw) ? raw : [];
  const normalized: AdditionalWrite[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const pathValue = (entry as { path?: unknown }).path;
    const contentValue = (entry as { content?: unknown }).content;
    if (typeof pathValue !== 'string' || typeof contentValue !== 'string') {
      continue;
    }
    const normalizedPath = normalizePath(pathValue);
    if (!normalizedPath) {
      continue;
    }
    const intentRaw = (entry as { intent?: unknown }).intent;
    const intent = intentRaw === 'create' || intentRaw === 'modify' ? intentRaw : undefined;
    normalized.push({
      path: normalizedPath,
      content: contentValue,
      intent
    });
  }
  return normalized;
}
