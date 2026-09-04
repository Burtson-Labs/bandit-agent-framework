/**
 * Next-prompt prediction — the "what will you ask next?" composer feature.
 *
 * After a turn completes, a host may make ONE cheap, separate model call to
 * suggest the user's likely next prompts, rendered as selectable chips (IDE)
 * or a hint line (CLI). This module is the shared, host-agnostic core: it
 * builds the (small) prompt and parses the reply. The host owns the model
 * call + rendering, so CLI and extension share identical behavior.
 *
 * Mirrors the planner's split (buildPlannerPrompt / parseGraphProposal): pure
 * functions, no IO, fully unit-testable. Deliberately tiny — this is a
 * latency- and token-sensitive path that runs after every eligible turn, so
 * the prompt is short and the reply is capped.
 *
 * Cost-gating is the host's job and defaults OFF (an extra call per turn is
 * exactly the kind of opt-in cost the framework keeps off by default).
 */

export interface SuggestionTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SuggestionPromptOptions {
  /** How many suggestions to ask for. Default 3; clamped to 1..5. */
  count?: number;
  /** Recently touched files, to bias suggestions toward the actual work. */
  recentFiles?: string[];
  /** Max chars of each turn we include (keeps the prompt cheap). Default 600. */
  perTurnChars?: number;
}

/** Build the suggestion prompt from the tail of the conversation. */
export function buildSuggestionsPrompt(
  conversation: SuggestionTurn[],
  opts: SuggestionPromptOptions = {}
): string {
  const count = Math.min(5, Math.max(1, opts.count ?? 3));
  const perTurnChars = opts.perTurnChars ?? 600;
  // Only the last few turns matter for "what's next"; keep it small.
  const tail = conversation.slice(-4).map((t) => {
    const body = t.content.length > perTurnChars ? t.content.slice(0, perTurnChars) + '…' : t.content;
    return `${t.role === 'user' ? 'User' : 'Assistant'}: ${body}`;
  });
  const filesLine = opts.recentFiles?.length
    ? `\nRecently touched: ${opts.recentFiles.slice(0, 8).join(', ')}`
    : '';
  return [
    `You suggest the user's likely NEXT prompts in a coding assistant. Based on the exchange below, output ${count} short, concrete follow-ups the user would plausibly type next — the natural next steps (run the tests, commit, explain a change, handle an edge case, etc.).`,
    '',
    'Rules:',
    `- Each suggestion is an imperative the USER would type (e.g. "run the tests", "commit with a message", "add error handling to the parser"). Not questions you'd ask them.`,
    '- Short: 3-8 words. Specific to what just happened, not generic.',
    `- Output ONLY a JSON array of ${count} strings in a \`\`\`json fence. Nothing else.`,
    filesLine,
    '',
    'Recent exchange:',
    ...tail,
  ].join('\n');
}

/**
 * Parse suggestions from the model reply. Accepts a ```json fence or a bare
 * array; tolerates prose around it. Never throws — returns [] on anything
 * unparseable, deduped, trimmed, and capped.
 */
export function parseSuggestions(text: string, max = 5): string[] {
  const raw = extractJsonArray(text);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const s = item.trim().replace(/^["'`]|["'`]$/g, '').trim();
    // Drop empties, over-long entries, and question-shaped items (we want
    // user imperatives, not the model interviewing the user).
    if (!s || s.length > 80) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** First ```json (or ```) fenced array, else the first bracket-balanced [...]. */
function extractJsonArray(text: string): string | null {
  const fence = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
  if (fence) return fence[1].trim();
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
