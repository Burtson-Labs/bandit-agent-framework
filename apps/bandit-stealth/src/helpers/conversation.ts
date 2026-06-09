/**
 * Conversation entry construction + name normalisation. Pure helpers
 * extracted from extension.ts as part of the broader shrink (see
 * for the formatting helpers, this is the second cut).
 *
 * No `this`, no VS Code API, no class state. The slash command module
 * needs `createConversationEntry`, so these moved out together.
 */

import type { ConversationEntry, ConversationFeedback, ConversationRole } from '../services/conversationTypes';

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;
const VARIATION_SELECTORS_REGEX = /[️︎]/g;
const ZERO_WIDTH_JOINER_REGEX = /‍/g;

/**
 * Normalise a free-text conversation title: strip emoji + variation
 * selectors + ZWJs, NFC-normalise, collapse whitespace, clamp to
 * `maxLength` characters. Falls back to "New Conversation" when input
 * is empty or normalises to empty.
 */
export function sanitizeConversationName(raw: string | undefined, maxLength = 60): string {
  if (!raw) {
    return 'New Conversation';
  }
  const withoutEmoji = raw.replace(EMOJI_REGEX, '').replace(VARIATION_SELECTORS_REGEX, '').replace(ZERO_WIDTH_JOINER_REGEX, '');
  const normalized = withoutEmoji.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return 'New Conversation';
  }
  const limited = Array.from(normalized).slice(0, maxLength).join('');
  return limited || 'New Conversation';
}

/**
 * Derive a conversation title from its entries. Uses the first
 * non-empty user message; falls back to the supplied fallback string
 * when the conversation has no user content yet (e.g. an assistant-
 * only system message turn).
 */
export function deriveConversationNameFromEntries(entries: ConversationEntry[], fallback: string): string {
  const firstUserMessage = entries.find((entry) => entry.role === 'user' && entry.content.trim().length > 0);
  if (!firstUserMessage) {
    return sanitizeConversationName(fallback);
  }
  return sanitizeConversationName(firstUserMessage.content);
}

/**
 * Generate a sortable, time-prefixed conversation id. Format:
 * `conv-<base36 timestamp>-<6 random base36 chars>`. Base36 keeps the
 * id short enough to read in logs while still time-orderable.
 */
export function createConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a fresh ConversationEntry. Auto-assigns id + timestamp; copies
 * optional fields (images, payload, contextFiles, contextSource)
 * defensively so callers can't accidentally mutate the entry's
 * arrays after the fact.
 */
export function createConversationEntry(
  role: ConversationRole,
  content: string,
  options?: { images?: string[]; payload?: string; contextFiles?: string[]; contextSource?: 'manual' | 'auto' }
): ConversationEntry {
  const entry: ConversationEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: Date.now()
  };
  if (Array.isArray(options?.images) && options?.images.length) {
    entry.images = [...options.images];
  }
  if (typeof options?.payload === 'string' && options.payload.length > 0) {
    entry.payload = options.payload;
  }
  if (Array.isArray(options?.contextFiles) && options.contextFiles.length > 0) {
    entry.contextFiles = [...options.contextFiles];
  }
  if (options?.contextSource) {
    entry.contextSource = options.contextSource;
  }
  return entry;
}

/**
 * Coerce a raw feedback payload (from the webview or a stored entry)
 * into a typed ConversationFeedback. Returns undefined when the
 * input is not an object or has no usable rating — the rating field
 * is the only required signal; everything else is optional.
 */
export function normalizeConversationFeedback(raw: unknown): ConversationFeedback | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const input = raw as Partial<ConversationFeedback> & Record<string, unknown>;
  const rating = input.rating === 'up' || input.rating === 'down' ? input.rating : undefined;
  if (!rating) {
    return undefined;
  }

  const submitted = input.submitted === true;
  const submittedAt = typeof input.submittedAt === 'number' && Number.isFinite(input.submittedAt)
    ? input.submittedAt
    : undefined;
  const note = typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.trim() : undefined;

  return {
    rating,
    submitted,
    submittedAt,
    note
  };
}
