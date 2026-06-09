// Subagent card open/closed state, keyed by stable goal-derived key. The
// markdown is rendered via dangerouslySetInnerHTML and the entire DOM is
// replaced on every stream chunk, which wipes any user toggle on a
// `<details>` element. We persist the open state outside React so a card
// the user expanded mid-run stays expanded across re-renders.
export const subagentOpenState = new Map<string, boolean>();

// companion map for the synopsis `<pre>` scrollTop. Long
// subagent synopses use `max-height: 280px; overflow-y: auto` so the
// user can scroll inside the card. Without persistence, every stream
// chunk's markdown re-render mounts a fresh `<pre>` at scrollTop=0 and
// the user gets snapped back to the top mid-read. Same shape as the
// open-state map: capture-phase scroll listener saves, useLayoutEffect
// restores after each render.
export const subagentScrollState = new Map<string, number>();

export const subagentKeyFor = (goal: string): string => {
  // Cheap, in-session-stable hash: length + djb2 over the first 256 chars.
  // Collisions just mean two cards share toggle state — harmless and
  // vanishingly rare with goals that already differ by phrasing.
  const slice = goal.slice(0, 256);
  let h = 5381;
  for (let i = 0; i < slice.length; i++) {h = ((h << 5) + h + slice.charCodeAt(i)) | 0;}
  return `${slice.length}-${(h >>> 0).toString(36)}`;
};

// Diff card open/closed state, same shape as subagentOpenState. The
// previous behavior was: render with `open` if <=50 lines, otherwise
// closed; every stream chunk re-renders the markdown via
// dangerouslySetInnerHTML and the user's toggle is lost. With this
// map we restore the user's intent across re-renders.
// Captured 2026-05-25: user scrolled the chat while a turn was
// streaming and watched diff cards auto-collapse — actually the
// stream chunks were causing it, the scroll just made it visible.
export const diffOpenState = new Map<string, boolean>();

export const diffKeyFor = (path: string, plus: number, minus: number, bodyHash: string): string => {
  // Path + plus/minus stats + first-256-char body hash gives a stable
  // key across chunks of the same diff (body grows as the model
  // streams). Different paths get different keys; different diffs to
  // the same path (rare in one turn) get different keys via bodyHash.
  return `${path}|${plus}|${minus}|${bodyHash}`;
};

// Reasoning fence open/closed state. The fence is rendered as <details
// open> on first paint so the user can read chain-of-thought live, but
// they should also be able to COLLAPSE it without it springing open
// again on the next stream chunk.
export const reasoningOpenState = new Map<string, boolean>();

export const getFileDisplayName = (path: string): string => {
  if (!path) {
    return path;
  }
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};
