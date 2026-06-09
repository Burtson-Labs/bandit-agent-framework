import { useCallback, useEffect, useRef, useState } from "react";

export interface MentionEntry {
  path: string;
  isDir: boolean;
}

export interface MentionPickerHook {
  /** Current set of file/dir suggestions for the @-mention popover. */
  mentionSuggestions: MentionEntry[];
  /**
   * Debounced workspace-files query — 120ms is tight enough to feel
   * instant while typing, loose enough that a fast typist doesn't
   * generate a search per keystroke against vscode.workspace.findFiles.
   * Posts `searchWorkspaceFiles` to the extension on settle.
   */
  handleFileMentionQuery: (query: string) => void;
  /**
   * Dispatch handler for the inbound `workspaceFileSuggestions` wire
   * message. Filters out malformed entries — the extension owns the
   * truth but the wire is untyped JSON, so any non-string `path` or
   * non-boolean `isDir` gets dropped here defensively.
   */
  handleWorkspaceFileSuggestions: (entries: unknown) => void;
}

const MENTION_QUERY_DEBOUNCE_MS = 120;

/**
 * Owns the @-mention autocomplete pipeline: the debounced outbound
 * search query, the inbound suggestions state, and the unmount
 * cleanup that drops any pending search if the webview tears down
 * while a debounce is in flight.
 */
export function useMentionPicker(): MentionPickerHook {
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionEntry[]>([]);
  const mentionQueryTimer = useRef<number | null>(null);

  // Unmount cleanup — drop any pending debounce so the postMessage
  // doesn't fire into a dead React tree (harmless but noisy).
  useEffect(
    () => () => {
      if (mentionQueryTimer.current !== null) {
        window.clearTimeout(mentionQueryTimer.current);
        mentionQueryTimer.current = null;
      }
    },
    []
  );

  const handleFileMentionQuery = useCallback((query: string) => {
    if (mentionQueryTimer.current !== null) {
      window.clearTimeout(mentionQueryTimer.current);
    }
    mentionQueryTimer.current = window.setTimeout(() => {
      mentionQueryTimer.current = null;
      vscode.postMessage({ type: "searchWorkspaceFiles", query });
    }, MENTION_QUERY_DEBOUNCE_MS);
  }, []);

  const handleWorkspaceFileSuggestions = useCallback((entries: unknown) => {
    const filtered = Array.isArray(entries)
      ? entries.filter(
          (e): e is MentionEntry =>
            e !== null &&
            typeof e === "object" &&
            typeof (e as { path?: unknown }).path === "string" &&
            typeof (e as { isDir?: unknown }).isDir === "boolean"
        )
      : [];
    setMentionSuggestions(filtered);
  }, []);

  return { mentionSuggestions, handleFileMentionQuery, handleWorkspaceFileSuggestions };
}
