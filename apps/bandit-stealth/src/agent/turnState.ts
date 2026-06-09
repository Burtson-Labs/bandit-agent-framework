import type { ConversationEntry } from '../services/conversationTypes';

/**
 * Per-task subagent buffer keyed by taskId (or 'sync' for the synchronous slot).
 * Holds the goal + intermediate tool calls so the parent's `task` tool_result
 * handler can render a `bandit-subagent` card with the full trace.
 *
 * Previously a single global buffer — that worked for one task at a time but
 * broke with concurrent backgrounded subagents (the 2026-05-06 self-eval
 * spawned 7 in parallel and all events collided on one buffer, so the card
 * always showed 0 iter / 0 tools). Map<key, buffer> resolves the collision.
 */
export interface SubagentBuffer {
  goal: string;
  tools: Array<{ name: string; primary: string; isError?: boolean }>;
  iterations?: number;
  hitLimit?: boolean;
  backgrounded: boolean;
}

export type PendingWriteTool = 'write_file' | 'apply_edit' | 'replace_range' | 'apply_patch';

/**
 * Mutable per-turn state for the tool-use loop's event bridge. Owns every
 * variable previously declared as a local `let` / `const Map()` inside
 * performToolUseCompletion so the event bridge handlers can be extracted
 * into a separate file without dragging 16 closure references with them.
 *
 * Field shapes preserved byte-for-byte from the inline declarations they
 * replace — no behavior change. The class is a stateful container, not a
 * service: handlers reach in and mutate fields directly.
 */
export class TurnState {
  static readonly SYNC_KEY = 'sync';
  static readonly REPEAT_WINDOW = 6;

  readonly assistantEntry: ConversationEntry;

  // Skill announcement de-dup
  lastAnnouncedSkillId: string | null = null;

  // Tool-execute / tool-result correlation
  readonly toolStartedAt = new Map<string, number>();
  readonly pendingWriteBefore = new Map<string, string>();
  readonly pendingWriteAfter = new Map<string, string>();
  readonly pendingWriteTool = new Map<string, PendingWriteTool>();
  readonly pendingTimelineIds = new Map<string, string>();
  pendingRunCommand: { cmd: string; args: string } | null = null;
  pendingEditPath: string | null = null;

  // Subagent event buffer (parent's task tool callback + main loop both write here)
  readonly subagentBuffers = new Map<string, SubagentBuffer>();

  // Iteration tracking
  readonly streamedCharsByIteration = new Map<number, number>();
  readonly iterationsWithToolCalls = new Set<number>();
  currentIteration = 0;
  currentIterationStartLength = 0;
  ignoreIterationChunks = false;
  inReasoningFence = false;

  // Ring buffer for repeat-tool-call detection
  readonly recentToolCallDisplays: string[] = [];

  // Chat-streaming state (consumed by buildChatFn).
  // - `imagesAlreadySent` flips to true after the first chat() call that
  //   attaches `turnImages`. Subsequent calls in the same turn (tool-result
  //   follow-ups) must NOT re-attach images: the Ollama vision adapter
  //   rejects multi-turn images and the rest of the turn fails. The guard
  //   inside buildChatFn checks `turnImages.length > 0` so the default-false
  //   here is equivalent to the previous `turnImages.length === 0`
  //   initialization for the no-images case.
  // - `inflightChats` is the live count of in-flight chat() calls in this
  //   turn. The watchdog sizing reads it as `inflightPeers` to widen its
  //   timeout when multiple chats are concurrent (parent + subagents).
  //   Incremented at the top of each chat() call, decremented in finally.
  // - `largePromptWatchdogNoticeShown` is the once-per-turn flag for the
  //   "Watchdog sized to Ns" status push. A turn that fans out into many
  //   chat() calls (subagent loop) should see the notice at most once.
  imagesAlreadySent = false;
  inflightChats = 0;
  largePromptWatchdogNoticeShown = false;

  constructor(assistantEntry: ConversationEntry) {
    this.assistantEntry = assistantEntry;
  }

  /**
   * Resolve the subagent-buffer key for an event payload. Returns the
   * payload's `taskId` for backgrounded subagents, or `SYNC_KEY` for the
   * (at-most-one) in-flight synchronous subagent.
   */
  bufferKeyFor(payload: unknown): string {
    const tid = (payload as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof tid === 'string' && tid ? tid : TurnState.SYNC_KEY;
  }

  /**
   * Iteration-boundary reset. Clears the chunk-suppression flag, snapshots
   * the assistant entry length so streamed prose can be truncated cleanly
   * if the model emits a tool_call mid-stream, and zeroes the streamed-char
   * counter for the new iteration.
   */
  resetForNewIteration(iteration: number, contentLength: number): void {
    this.currentIteration = iteration;
    this.currentIterationStartLength = contentLength;
    this.ignoreIterationChunks = false;
    this.streamedCharsByIteration.set(iteration, 0);
  }
}
