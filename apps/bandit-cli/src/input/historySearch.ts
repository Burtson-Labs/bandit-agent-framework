/**
 * Reverse history search matching (the Ctrl+R shell affordance).
 *
 * Pure and UI-free so the matching logic is testable without ink or a TTY —
 * the frame owns only the key handling and rendering.
 */

/**
 * Return history entries matching `query`, most-recent-first and de-duplicated.
 *
 * Substring, case-insensitive — the same behavior readline / bash Ctrl+R give,
 * which is what muscle memory expects. An empty query matches nothing (the
 * search prompt shows but nothing is selected until the user types).
 */
export function searchHistory(history: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) {return [];}
  const seen = new Set<string>();
  const out: string[] = [];
  // Walk newest → oldest so the first match is the most recent, matching how
  // Ctrl+R surfaces the last thing you ran first.
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.toLowerCase().includes(q) && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}
