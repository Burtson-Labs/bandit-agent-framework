export interface ExtractionServiceDeps {
  setContextValue(key: string, value: unknown): void;
  getContextValue<T>(key: string): T | undefined;
  getSessionGoal(): string | undefined;
}

export function createExtractionService(deps: ExtractionServiceDeps) {
  function captureExtractionSection(content: string): void {
    const snippet = extractRelevantSection(content);
    deps.setContextValue('focus.extract.section', snippet);
  }

  function extractRelevantSection(content: string, patterns: string[] = []): string {
    if (typeof content !== 'string') {
      return '';
    }
    const normalized = content.trim();
    if (!normalized) {
      return '';
    }
    const loweredPatterns = patterns
      .map((pattern) => pattern.trim().toLowerCase())
      .filter((pattern) => pattern.length > 0);

    let snippet: string | undefined;
    if (loweredPatterns.length > 0) {
      const lower = normalized.toLowerCase();
      let anchorIndex = -1;
      for (const pattern of loweredPatterns) {
        const idx = lower.indexOf(pattern);
        if (idx !== -1 && (anchorIndex === -1 || idx < anchorIndex)) {
          anchorIndex = idx;
        }
      }
      if (anchorIndex !== -1) {
        snippet = expandSnippetRegion(normalized, anchorIndex);
      }
    }

    const contextual =
      snippet
      ?? extractAnnotatedSnippet(normalized)
      ?? extractGoalSpecificSnippet(normalized)
      ?? extractButtonCluster(normalized)
      ?? extractSnippetFromKeywords(normalized)
      ?? buildDefaultSnippet(normalized);

    return clampSnippetLength(contextual ?? normalized);
  }

  function buildDefaultSnippet(content: string): string {
    const normalized = content.trim();
    if (!normalized) {
      return '';
    }
    const imports = extractLeadingImports(normalized);
    const remaining = imports ? normalized.slice(imports.length).trimStart() : normalized;
    if (remaining.length <= 800) {
      return imports ? `${imports}\n\n${remaining}`.trim() : remaining;
    }
    const blockEnd = remaining.indexOf('\n\n', 600);
    const body = blockEnd === -1 ? remaining.slice(0, 800) : remaining.slice(0, blockEnd);
    return [imports, body.trim()].filter((segment) => segment && segment.length > 0).join('\n\n').trim();
  }

  function clampSnippetLength(content: string, limit = 1600): string {
    if (!content || content.length <= limit) {
      return content;
    }
    return `${content.slice(0, limit)}\n// …`;
  }

  function getPrimaryMatchKeywords(): string[] {
    const primary = deps.getContextValue<{ matches?: unknown }>('focus.primary');
    const matches = Array.isArray(primary?.matches) ? primary?.matches : [];
    const normalized = matches
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 2);
    normalized.sort((a, b) => b.length - a.length);
    return normalized.slice(0, 5);
  }

  function extractGoalSpecificSnippet(content: string): string | undefined {
    const goal = deps.getSessionGoal()?.toLowerCase().trim();
    if (!goal) {
      return undefined;
    }
    if (goal.includes('login') && goal.includes('button')) {
      const loginSnippet = extractLoginButtonSnippet(content);
      if (loginSnippet) {
        return loginSnippet;
      }
    }
    return undefined;
  }

  function extractSnippetFromKeywords(content: string): string | undefined {
    const keywords = getPrimaryMatchKeywords();
    if (!keywords.length) {
      return undefined;
    }
    const lower = content.toLowerCase();
    for (const keyword of keywords) {
      const index = lower.indexOf(keyword.toLowerCase());
      if (index !== -1) {
        return expandSnippetRegion(content, index);
      }
    }
    return undefined;
  }

  function extractButtonCluster(content: string): string | undefined {
    const buttonRegex = /<(?:Icon)?Button[\s>]/i;
    const match = buttonRegex.exec(content);
    if (!match) {
      return undefined;
    }
    const anchorIndex = match.index;
    const bounds = findClusterBounds(content, anchorIndex, match[0].length);
    if (!bounds) {
      return undefined;
    }
    return content.slice(bounds.start, bounds.end).trim();
  }

  function extractAnnotatedSnippet(content: string): string | undefined {
    const startRegex = /(?:\/\/|\/\*)\s*(?:bandit|helper|extract)[^a-z0-9]{0,4}(?:start|begin)/i;
    const endRegex = /(?:\/\/|\/\*)\s*(?:bandit|helper|extract)[^a-z0-9]{0,4}(?:end|stop)/i;
    const startMatch = startRegex.exec(content);
    if (!startMatch) {
      return undefined;
    }
    const searchStart = startMatch.index + startMatch[0].length;
    const endMatch = endRegex.exec(content.slice(searchStart));
    if (!endMatch) {
      return undefined;
    }
    return content.slice(searchStart, searchStart + endMatch.index).trim();
  }

  function extractLoginButtonSnippet(content: string): string | undefined {
    const anchors = [/sign\s+in\s+with/i, /login\s+button/i, /googleloginicon/i, /githubicon/i];
    for (const anchor of anchors) {
      const match = anchor.exec(content);
      if (!match) {
        continue;
      }
      const anchorIndex = match.index;
      const bounds = findClusterBounds(content, anchorIndex, match[0].length);
      if (!bounds) {
        continue;
      }
      const snippet = content.slice(bounds.start, bounds.end).trim();
      const buttonCount = (snippet.match(/<(?:Icon)?Button/gi) ?? []).length;
      if (buttonCount >= 2) {
        return snippet;
      }
    }
    return undefined;
  }

  function expandSnippetRegion(content: string, anchorIndex: number): string {
    const startBoundary = content.lastIndexOf('\n\n', anchorIndex);
    const start = startBoundary === -1 ? 0 : startBoundary + 2;
    let endBoundary = content.indexOf('\n\n', anchorIndex);
    if (endBoundary === -1) {
      endBoundary = content.length;
    }
    let snippet = content.slice(start, endBoundary).trim();
    if (snippet.length < 120) {
      const extended = content.indexOf('\n\n', endBoundary + 2);
      if (extended !== -1) {
        snippet = content.slice(start, extended).trim();
      }
    }
    const imports = extractLeadingImports(content);
    return imports ? `${imports}\n\n${snippet}`.trim() : snippet;
  }

  function findClusterBounds(
    content: string,
    anchorIndex: number,
    anchorLength = 0
  ): { start: number; end: number } | undefined {
    const containerAnchor = findContainerAnchor(content, anchorIndex);
    if (containerAnchor) {
      const end = findContainerEnd(content, containerAnchor);
      if (end > containerAnchor.start) {
        return { start: containerAnchor.start, end };
      }
    }
    const fallbackStart = findLegacyClusterStart(content, anchorIndex);
    const fallbackEnd = findLegacyClusterEnd(content, anchorIndex + anchorLength);
    if (fallbackStart === -1 || fallbackEnd <= fallbackStart) {
      return undefined;
    }
    return { start: fallbackStart, end: fallbackEnd };
  }

  function findContainerAnchor(
    content: string,
    anchorIndex: number
  ): { start: number; tag: string } | undefined {
    const lower = content.toLowerCase();
    const containerTags = ['stack', 'box', 'grid', 'div', 'section', 'main', 'article', 'ul', 'ol'];
    let best: { start: number; tag: string } | undefined;
    for (const tag of containerTags) {
      const search = `<${tag}`;
      const idx = lower.lastIndexOf(search, anchorIndex);
      if (idx !== -1 && (!best || idx > best.start)) {
        best = { start: idx, tag };
      }
    }
    if (!best) {
      return undefined;
    }
    const tagMatch = /^<\s*([A-Za-z0-9:_-]+)/.exec(content.slice(best.start));
    const resolvedTag = tagMatch ? tagMatch[1] : best.tag;
    return { start: best.start, tag: resolvedTag };
  }

  function findContainerEnd(content: string, anchor: { start: number; tag: string }): number {
    const tag = anchor.tag;
    const pattern = new RegExp(`<\\/?${tag}\\b`, 'gi');
    pattern.lastIndex = anchor.start;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const isClosing = content[match.index + 1] === '/';
      const closeBracket = content.indexOf('>', match.index);
      if (closeBracket === -1) {
        return content.length;
      }
      if (!isClosing) {
        const isSelfClosing = content.slice(match.index, closeBracket).includes('/>');
        if (!isSelfClosing) {
          depth += 1;
        }
      } else {
        depth -= 1;
        if (depth <= 0) {
          return closeBracket + 1;
        }
      }
    }
    return content.length;
  }

  function findLegacyClusterStart(content: string, anchorIndex: number): number {
    const tags = ['<Stack', '<Box', '<Grid', '<div'];
    let start = -1;
    for (const tag of tags) {
      const idx = content.lastIndexOf(tag, anchorIndex);
      if (idx !== -1 && idx > start) {
        start = idx;
      }
    }
    if (start !== -1) {
      return start;
    }
    const paragraphBreak = content.lastIndexOf('\n\n', anchorIndex);
    if (paragraphBreak !== -1) {
      return paragraphBreak + 2;
    }
    const lineBreak = content.lastIndexOf('\n', anchorIndex);
    return lineBreak !== -1 ? lineBreak + 1 : 0;
  }

  function findLegacyClusterEnd(content: string, anchorIndex: number): number {
    const boundary = content.indexOf('\n\n', anchorIndex);
    if (boundary !== -1) {
      return boundary;
    }
    const closingTag = content.indexOf('</', anchorIndex);
    if (closingTag !== -1) {
      const nextBreak = content.indexOf('\n\n', closingTag);
      if (nextBreak !== -1) {
        return nextBreak;
      }
      return content.length;
    }
    return content.length;
  }

  function extractLeadingImports(content: string): string {
    const lines = content.split(/\r?\n/);
    const imports: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (imports.length > 0) {
          imports.push('');
        }
        continue;
      }
      if (/^import[\s{*]/.test(trimmed) || /^import\s+.+from\s+['"].+['"];?$/i.test(trimmed)) {
        imports.push(line);
      } else {
        break;
      }
    }
    return imports.join('\n').trim();
  }

  return {
    captureExtractionSection,
    extractRelevantSection,
    clampSnippetLength
  };
}
