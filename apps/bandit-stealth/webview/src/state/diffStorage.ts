export type DiffPreviewAction = "apply" | "explain" | "discard";

export interface CompletedChangeEntry {
  path: string;
  diffText?: string;
  added?: number;
  removed?: number;
}

export const LIVE_DIFF_STORAGE_PREFIX = "bandit-stealth:liveDiff:";

export const getDiffStorageKey = (conversationId?: string | null): string | null =>
  conversationId ? `${LIVE_DIFF_STORAGE_PREFIX}${conversationId}` : null;

export const readStoredDiffEntries = (
  conversationId?: string | null
): Record<string, CompletedChangeEntry> => {
  if (typeof window === "undefined") {
    return {};
  }
  const key = getDiffStorageKey(conversationId);
  if (!key) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries: Record<string, CompletedChangeEntry> = {};
    Object.entries(parsed ?? {}).forEach(([path, value]) => {
      if (typeof path !== "string" || !value || typeof value !== "object") {
        return;
      }
      const record = value as { diffText?: unknown; added?: unknown; removed?: unknown };
      entries[path] = {
        path,
        diffText: typeof record.diffText === "string" ? record.diffText : undefined,
        added: typeof record.added === "number" ? record.added : undefined,
        removed: typeof record.removed === "number" ? record.removed : undefined
      };
    });
    return entries;
  } catch {
    return {};
  }
};

export const persistStoredDiffEntries = (
  conversationId: string | null | undefined,
  entries: Record<string, CompletedChangeEntry>
): void => {
  if (typeof window === "undefined") {
    return;
  }
  const key = getDiffStorageKey(conversationId);
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    // Ignore storage quota issues.
  }
};
