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
 * `tool_calls` carries the iteration-bookkeeping mutation that the rest
 * of the loop relies on, and now also preserves streamed reasoning when
 * it strips the iteration's tool-call prose preamble (2026-06-15); the
 * others are trace-only.
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
      // Drop this iteration's tool-call PROSE preamble ("Okay, I'll read
      // the file…") but KEEP any reasoning the model streamed. Slicing
      // the whole iteration segment deleted the reasoning the moment a
      // tool ran, so cards vanished mid-turn and only reappeared at
      // finalize when the full message re-rendered — the "reasoning
      // disappears then all reappears" churn (2026-06-15, Mark). Keeping
      // the reasoning fences here leaves a stable collapsed card in place
      // through the whole turn.
      const prefix = assistantEntry.content.slice(0, state.currentIterationStartLength);
      const segment = assistantEntry.content.slice(state.currentIterationStartLength);
      const reasoning = segment.match(/```bandit-reasoning[\s\S]*?```/gi);
      const keptReasoning = reasoning ? reasoning.join('\n\n') : '';
      assistantEntry.content = keptReasoning
        ? `${prefix.replace(/\s*$/, '')}\n\n${keptReasoning}\n`
        : prefix;
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
