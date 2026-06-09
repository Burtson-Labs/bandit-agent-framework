export function clampDiffPreview(diff: string, maxLines = 200): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) {
    return diff;
  }
  const head = lines.slice(0, maxLines);
  head.push('... diff truncated ...');
  return head.join('\n');
}

export function summarizeDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return { added, removed };
}

export function buildContentSample(content: string, maxLines = 12, maxLength = 800): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return '';
  }
  const selected = lines.slice(0, maxLines);
  let snippet = selected.join('\n');
  if (lines.length > maxLines) {
    snippet += '\n…';
  }
  if (snippet.length > maxLength) {
    snippet = `${snippet.slice(0, maxLength - 1)}…`;
  }
  return snippet;
}

export function truncateText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}
