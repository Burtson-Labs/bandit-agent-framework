import type { TurnLogger } from '@burtson-labs/host-kit';
import type { TurnState } from '../turnState';

/**
 * Deps for the meta-events family. The seven event types break down as:
 *
 * - `tool_calls` — the only one that mutates state. Marks the current
 *   iteration as having emitted tool calls, kicks chunk-suppression on,
 *   and truncates any streamed prose since the iteration boundary.
 * - `cancelled`, `compacted`, `hallucinated_tool_result`,
 *   `fired_and_forgotten_nudge`, `announce_intent_nudge`,
 *   `json_todo_auto_promoted` — trace-only signals.
 */
export interface MetaEventDeps {
  state: TurnState;
  turnLog: TurnLogger | null;
  getToolLoopIteration: (payload: unknown, fallback: number) => number;
  syncState: () => void;
}

/**
 * Handles the meta-events family of the tool-use loop's emit callback:
 * `tool_loop:tool_calls`, `tool_loop:cancelled`, `tool_loop:compacted`,
 * `tool_loop:hallucinated_tool_result`,
 * `tool_loop:fired_and_forgotten_nudge`,
 * `tool_loop:announce_intent_nudge`, `tool_loop:json_todo_auto_promoted`.
 *
 * Behavior preserved byte-for-byte from the inline switch. `tool_calls`
 * carries the iteration-bookkeeping mutation that the rest of the loop
 * relies on; the others are trace-only.
 */
export function handleMetaEvent(type: string, payload: unknown, deps: MetaEventDeps): void {
  const { state, turnLog, getToolLoopIteration, syncState } = deps;
  const assistantEntry = state.assistantEntry;

  if (type === 'tool_loop:tool_calls') {
    const iteration = getToolLoopIteration(payload, state.currentIteration);
    const p = payload as { tools?: string[] };
    void turnLog?.append({ type: 'tool-calls', iteration, tools: p?.tools ?? [] });
    state.iterationsWithToolCalls.add(iteration);
    state.ignoreIterationChunks = true;
    state.streamedCharsByIteration.set(iteration, 0);
    if (assistantEntry.content.length !== state.currentIterationStartLength) {
      assistantEntry.content = assistantEntry.content.slice(0, state.currentIterationStartLength);
      assistantEntry.payload = assistantEntry.content;
      assistantEntry.timestamp = Date.now();
      syncState();
    }
    return;
  }

  if (type === 'tool_loop:cancelled') {
    const p = payload as { iteration?: number; stage?: string };
    void turnLog?.append({ type: 'cancelled', iteration: p?.iteration, stage: p?.stage });
    return;
  }

  if (type === 'tool_loop:compacted') {
    const p = payload as { iteration?: number; messagesCompacted?: number; beforeTokens?: number; afterTokens?: number };
    void turnLog?.append({
      type: 'compacted',
      iteration: p?.iteration,
      messagesCompacted: p?.messagesCompacted,
      beforeTokens: p?.beforeTokens,
      afterTokens: p?.afterTokens
    });
    return;
  }

  if (type === 'tool_loop:hallucinated_tool_result') {
    const p = payload as { iteration?: number; responsePreview?: string };
    void turnLog?.append({ type: 'hallucinated-tool-result', iteration: p?.iteration, responsePreview: p?.responsePreview });
    return;
  }

  if (type === 'tool_loop:fired_and_forgotten_nudge') {
    const p = payload as { iteration?: number; backgroundSpawns?: number };
    void turnLog?.append({ type: 'fired-and-forgotten-nudge', iteration: p?.iteration, backgroundSpawns: p?.backgroundSpawns });
    return;
  }

  if (type === 'tool_loop:announce_intent_nudge') {
    const p = payload as { iteration?: number; responsePreview?: string };
    void turnLog?.append({ type: 'announce-intent-nudge', iteration: p?.iteration, responsePreview: p?.responsePreview });
    return;
  }

  if (type === 'tool_loop:json_todo_auto_promoted') {
    const p = payload as { iteration?: number; itemCount?: number };
    void turnLog?.append({ type: 'json-todo-auto-promoted', iteration: p?.iteration, itemCount: p?.itemCount });
    return;
  }
}
