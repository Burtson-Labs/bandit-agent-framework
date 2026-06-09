/**
 * Pure intent-memory helpers extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. These four functions had no `this`
 * dependency — they take inputs and return outputs — so they're a
 * clean cut alongside the helper extractions in /  * and the type extraction in .
 *
 * The stateful intent methods (recordIntentMemory, setIntentInsight,
 * attachIntentToMessage, interpretIntent) intentionally stay on the
 * class because they touch context.workspaceState, secrets, and the
 * live conversation array.
 */
import type { ConversationEntry, IntentInsight } from '../services/conversationTypes';
import type { IntentMemoryEntry } from '../agentTypes';

/**
 * Sanitize and de-duplicate an intent-memory list. Drops entries
 * without a usable summary, clamps confidence to [0,1], coerces a
 * missing/invalid lastUsed to "now", de-duplicates by `action:summary`
 * keeping whichever copy was used most recently, then returns at most
 * 20 sorted newest-first.
 */
export function normalizeIntentMemory(entries: IntentMemoryEntry[] | undefined): IntentMemoryEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  const normalized = new Map<string, IntentMemoryEntry>();
  for (const entry of entries) {
    if (!entry || typeof entry.summary !== 'string' || entry.summary.trim().length === 0) {
      continue;
    }
    const action = typeof entry.action === 'string' && entry.action.trim().length > 0 ? entry.action.trim() : 'unknown';
    const summary = entry.summary.trim();
    const key = `${action}:${summary}`;
    const confidence = typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
      ? Math.max(0, Math.min(1, entry.confidence))
      : undefined;
    const record: IntentMemoryEntry = {
      action,
      target: typeof entry.target === 'string' && entry.target.trim().length > 0 ? entry.target.trim() : undefined,
      summary,
      confidence,
      lastUsed: typeof entry.lastUsed === 'number' && Number.isFinite(entry.lastUsed) ? entry.lastUsed : Date.now()
    };
    const existing = normalized.get(key);
    if (!existing || existing.lastUsed < record.lastUsed) {
      normalized.set(key, record);
    }
  }

  return Array.from(normalized.values())
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, 20);
}

/** Walk a conversation backwards and return the most recent attached intent, if any. */
export function findLatestIntent(entries: ConversationEntry[]): IntentInsight | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]?.intent;
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Pick the best human-readable summary for an intent. Prefer the
 * model-supplied `summary`, then assemble `action • intent • target`,
 * then fall back to the action verb, then the catch-all string.
 */
export function summarizeIntent(insight: IntentInsight): string {
  if (insight.summary && insight.summary.trim().length > 0) {
    return insight.summary.trim();
  }
  const parts = [insight.action, insight.intent, insight.target]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  if (parts.length === 0) {
    return insight.action || 'General assistance';
  }
  return parts.join(' • ');
}

/**
 * Coerce a raw API/intent-endpoint payload into a typed IntentInsight.
 * Returns undefined for anything that's not an object or is missing
 * a usable `action`. Trims strings, clamps confidence to [0,1], and
 * preserves the original `raw` map for downstream debugging.
 */
export function normalizeIntentInsight(raw: unknown): IntentInsight | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const input = raw as Partial<IntentInsight> & Record<string, unknown>;
  const action = typeof input.action === 'string' && input.action.trim().length > 0 ? input.action.trim() : undefined;
  if (!action) {
    return undefined;
  }

  const target = typeof input.target === 'string' && input.target.trim().length > 0 ? input.target.trim() : undefined;
  const intent = typeof input.intent === 'string' && input.intent.trim().length > 0 ? input.intent.trim() : undefined;
  const summary = typeof input.summary === 'string' && input.summary.trim().length > 0
    ? input.summary.trim()
    : undefined;
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(1, input.confidence))
    : undefined;
  const rationale = typeof input.rationale === 'string' && input.rationale.trim().length > 0
    ? input.rationale.trim()
    : undefined;

  const rawData = typeof input.raw === 'object' && input.raw !== null ? (input.raw as Record<string, unknown>) : undefined;

  return {
    action,
    target,
    intent,
    summary,
    confidence,
    rationale,
    raw: rawData
  };
}
