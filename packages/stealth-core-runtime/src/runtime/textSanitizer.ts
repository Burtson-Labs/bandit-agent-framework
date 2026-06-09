export const CONVERSATION_MARKER_REGEXES = [
  /<\|?\s*\/?\s*start_of_turn\s*\|?>/gi,
  /<\|?\s*\/?\s*end_of_turn\s*\|?>/gi
];

export function stripCodeFences(content: string): string {
  let sanitized = content;
  const fencePattern = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/;
  const match = sanitized.match(fencePattern);
  if (match) {
    sanitized = match[1];
  } else {
    sanitized = sanitized.replace(/^```[a-zA-Z0-9_-]*\n?/, '');
    if (sanitized.endsWith('```')) {
      sanitized = sanitized.slice(0, -3);
    }
  }
  return sanitized.trim();
}

export function sanitizeGeneratedSource(content: string): string {
  if (!content) {
    return '';
  }
  let sanitized = content.replace(/\r\n/g, '\n');
  sanitized = sanitized.replace(/```[a-zA-Z0-9_-]*\n?/gi, '');
  sanitized = sanitized.replace(/```/g, '');
  for (const regex of CONVERSATION_MARKER_REGEXES) {
    sanitized = sanitized.replace(regex, '');
  }
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
  sanitized = stripLeakedFileHeaders(sanitized);
  return sanitized.trim();
}

function stripLeakedFileHeaders(content: string): string {
  const lines = content.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? '';
    if (!line) {
      index += 1;
      continue;
    }
    if (looksLikeLeakedFileHeader(line)) {
      index += 1;
      continue;
    }
    break;
  }
  if (index === 0) {
    return content;
  }
  const remainder = lines.slice(index).join('\n');
  return remainder.replace(/^\s+/, '');
}

function looksLikeLeakedFileHeader(line: string): boolean {
  if (!line) {
    return false;
  }
  if (/^```files?/i.test(line)) {
    return true;
  }
  if (/^(?:files?|file)\s*:/i.test(line)) {
    return true;
  }
  if (line.startsWith('//') || line.startsWith('/*')) {
    return false;
  }
  const normalized = line.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    return false;
  }
  if (!normalized.includes('/')) {
    return false;
  }
  const ext = normalized.split('.').pop();
  if (!ext || ext.length > 6) {
    return false;
  }
  return true;
}
