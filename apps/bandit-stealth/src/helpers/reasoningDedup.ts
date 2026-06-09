const REASONING_FENCE_RE = /```bandit-reasoning\b[^\n]*\n([\s\S]*?)```/gi;

function reasoningFingerprint(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function normalizeSpacing(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function dedupeBanditReasoningFences(text: string): string {
  const seen = new Set<string>();
  const cleaned = text.replace(REASONING_FENCE_RE, (full, body: string) => {
    const key = reasoningFingerprint(body);
    if (!key) {return full;}
    if (seen.has(key)) {return '';}
    seen.add(key);
    return full;
  });
  return normalizeSpacing(cleaned);
}

export function stripReasoningAlreadyInTranscript(finalResponse: string, transcript: string): string {
  const seen = new Set<string>();
  for (const match of transcript.matchAll(REASONING_FENCE_RE)) {
    const key = reasoningFingerprint(match[1] ?? '');
    if (key) {seen.add(key);}
  }
  if (seen.size === 0) {return finalResponse;}

  const cleaned = finalResponse.replace(REASONING_FENCE_RE, (full, body: string) => {
    const key = reasoningFingerprint(body);
    return key && seen.has(key) ? '' : full;
  });
  return normalizeSpacing(cleaned);
}
