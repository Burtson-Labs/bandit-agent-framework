/**
 * `buildFlushPendingEditDiffs` — factory for the iteration-boundary
 * (and turn-end) diff-card flusher.
 *
 * Each call empties `state.pendingWrite{Before,After,Tool}` and for
 * every file whose contents changed, appends a `bandit-edit` /
 * `bandit-write` markdown block to the assistant entry and fires a
 * fire-and-forget checkpoint. The closure mutates the three Maps on
 * `state` and the assistant entry content/payload in place — same
 * shape as the inline closure it replaces in `performToolUseCompletion`.
 *
 * Why a factory rather than a plain function: the call site needs to
 * pass turn-scoped values (`assistantEntry`, `workspaceRoot`,
 * `checkpointStore`, `turnId`) once and then invoke the resulting
 * closure repeatedly from the chat-events handler at every
 * `llm_start` iteration boundary plus once at turn-end. Capturing
 * those values once at the top of the turn avoids threading them
 * through every event-handler call.
 *
 * Load-bearing behaviors preserved from the inline closure:
 *
 *  - **Three "after" sources, in priority order.** (1) `write_file`
 *    gives us full content via `params.content`. (2) `apply_edit` /
 *    `replace_range` / `apply_patch` stash the post-write disk state
 *    on `state.pendingWriteAfter` in the `tool_result` handler so a
 *    later format-on-save can't corrupt the rendered diff. (3) If
 *    neither populated, re-read from disk now.
 *  - **`isNew` is keyed on `before === ''`.** A truly missing file
 *    reads as empty string from `readFileSafe`, so the "created" vs
 *    "edited" distinction collapses to a single condition.
 *  - **Checkpoint iteration is `state.currentIteration + 1`.** The
 *    flush runs as the NEXT iteration is about to start, so the
 *    checkpoint records the iteration the edits will apply within.
 *  - **All three maps cleared after the loop.** A partial clear would
 *    leak stale before/after pairs into the next iteration's flush.
 *  - **Synchronous body.** Runs synchronously between the chat-events
 *    handler's `llm_start` dispatch and the chat-events handler's
 *    `currentIteration` write — async would let the iteration index
 *    advance before the flush reads it, corrupting the checkpoint.
 *    The single `void this.syncState()` at the end is fire-and-forget,
 *    safe to be async.
 */
import * as path from 'path';
import type { CheckpointStore } from '@burtson-labs/host-kit';
import {
  buildCompactDiffBlock,
  lineDiffCounts,
  readFileSafe
} from '../helpers/formatting';
import type { ConversationEntry } from '../services/conversationTypes';
import type { TurnState } from './turnState';

export interface FlushPendingEditDiffsDeps {
  state: TurnState;
  assistantEntry: ConversationEntry;
  workspaceRoot: string;
  checkpointStore: CheckpointStore;
  turnId: string;
  syncState: () => void;
}

export function buildFlushPendingEditDiffs(deps: FlushPendingEditDiffsDeps): () => void {
  const { state, assistantEntry, workspaceRoot, checkpointStore, turnId, syncState } = deps;
  return () => {
    if (state.pendingWriteBefore.size === 0) {return;}
    for (const [absPath, before] of state.pendingWriteBefore.entries()) {
      const pendingAfter = state.pendingWriteAfter.get(absPath);
      const after = (pendingAfter && pendingAfter.length > 0) ? pendingAfter : readFileSafe(absPath);
      if (before === after) {continue;}
      const rel = path.relative(workspaceRoot, absPath) || absPath;
      const { plus, minus } = lineDiffCounts(before, after);
      const isNew = before === '';
      const header = isNew
        ? `\n\n**✦ created** \`${rel}\` · **+${after.split('\n').length} lines**\n`
        : `\n\n**✎ edited** \`${rel}\` · **+${plus} −${minus}**\n`;
      const preview = buildCompactDiffBlock(before, after, 60, { relPath: rel, plus, minus });
      assistantEntry.content += header + preview;
      assistantEntry.payload = assistantEntry.content;
      const tool = state.pendingWriteTool.get(absPath) ?? ((pendingAfter && pendingAfter.length > 0) ? 'write_file' : 'apply_edit');
      void checkpointStore.create({
        turnId,
        tool,
        absolutePath: absPath,
        before,
        after,
        iteration: state.currentIteration + 1
      }).catch(() => undefined);
    }
    state.pendingWriteBefore.clear();
    state.pendingWriteAfter.clear();
    state.pendingWriteTool.clear();
    syncState();
  };
}
