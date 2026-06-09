import type { BackgroundTaskStore, TurnLogger } from '@burtson-labs/host-kit';
import { TurnState } from '../turnState';
import { formatToolPrimaryDisplay } from '../../helpers/formatting';

/**
 * Deps for the subagent-events family. Unlike the other families, these
 * events fire from the parent's `buildTaskTool({ onEvent })` callback
 * (not from createToolUseLoop's emitEvent), but they read and mutate the
 * same TurnState.subagentBuffers map that the main bridge reads. Keeping
 * them in the same module family preserves the boundary.
 */
export interface SubagentEventDeps {
  state: TurnState;
  turnLog: TurnLogger | null;
  workspaceRoot: string;
  background: BackgroundTaskStore;
  /**
   * `true` iff `state.assistantEntry.id` still appears in the live
   * conversation. The task:done / task:error backgrounded-render
   * branches gate on this — appending a card to a detached entry would
   * silently miss the UI when the user has started a new turn.
   */
  isAssistantEntryLive: () => boolean;
  syncState: () => void;
}

/**
 * Handles the subagent-events family fired from the parent's task tool
 * `onEvent` callback: `task:start`, `subagent:task:spawn`,
 * `subagent:tool_loop:tool_execute`, `subagent:tool_loop:tool_result`,
 * `subagent:tool_loop:llm_start`, `subagent:tool_loop:llm_response`,
 * `subagent:tool_loop:tool_calls`, `task:done`, `task:error`.
 *
 * Behavior preserved byte-for-byte. Per-task buffers keyed by taskId
 * remain the design contract — a single global buffer broke under
 * concurrent backgrounded subagents (the 2026-05-06 self-eval spawned
 * 7 in parallel and all events collided on one buffer).
 */
export function handleSubagentEvent(type: string, payload: unknown, deps: SubagentEventDeps): void {
  const { state, turnLog, workspaceRoot, background, isAssistantEntryLive, syncState } = deps;
  const assistantEntry = state.assistantEntry;

  if (type === 'task:start') {
    const p = payload as { goal?: string; taskId?: string; background?: boolean };
    const key = typeof p?.taskId === 'string' && p.taskId ? p.taskId : TurnState.SYNC_KEY;
    state.subagentBuffers.set(key, {
      goal: p?.goal ?? '',
      tools: [],
      backgrounded: Boolean(p?.background)
    });
    // Surface a one-line narrative the moment a subagent is
    // dispatched so the chat doesn't go silent during delegation.
    // Plain text with the ◉ glyph rather than `_..._` italic —
    // markdown-it's flanking logic won't open italic when `_`
    // is followed by a non-word glyph.
    const goalText = (p?.goal ?? '').trim();
    if (goalText) {
      const narrative = `\n\n◉ Investigating: ${goalText.slice(0, 200)}${goalText.length > 200 ? '…' : ''}\n`;
      assistantEntry.content += narrative;
      assistantEntry.payload = assistantEntry.content;
      assistantEntry.timestamp = Date.now();
      syncState();
    }
    return;
  }

  if (type === 'subagent:task:spawn') {
    // Telemetry: subagent system-prompt size + inheritance source
    // captured at spawn time so a later stall/watchdog can be correlated
    // with the actual prompt size we sent.
    const p = payload as {
      taskId?: string;
      goal?: string;
      systemPromptChars?: number;
      inheritedFromParent?: boolean;
      nativeTools?: boolean;
      registryToolCount?: number;
    };
    void turnLog?.append({
      type: 'subagent-spawn',
      taskId: p?.taskId,
      systemPromptChars: p?.systemPromptChars,
      inheritedFromParent: p?.inheritedFromParent,
      nativeTools: p?.nativeTools,
      registryToolCount: p?.registryToolCount
    });
    return;
  }

  if (type === 'subagent:tool_loop:tool_execute') {
    const p = payload as { name?: string; params?: Record<string, string>; taskId?: string };
    const buf = state.subagentBuffers.get(state.bufferKeyFor(payload));
    if (buf) {
      const primary = formatToolPrimaryDisplay(p?.name ?? '', p?.params, workspaceRoot);
      buf.tools.push({ name: p?.name ?? '', primary });
    }
    return;
  }

  if (type === 'subagent:tool_loop:tool_result') {
    const p = payload as { name?: string; isError?: boolean; taskId?: string };
    const buf = state.subagentBuffers.get(state.bufferKeyFor(payload));
    if (buf && p?.isError) {
      const last = buf.tools[buf.tools.length - 1];
      if (last && last.name === p.name) {last.isError = true;}
    }
    return;
  }

  if (type === 'subagent:tool_loop:llm_start') {
    const p = payload as {
      iteration?: number;
      messageCount?: number;
      promptCharsTotal?: number;
      systemPromptChars?: number;
      thinkOverride?: boolean;
      taskId?: string;
    };
    void turnLog?.append({
      type: 'subagent-llm-start',
      taskId: p?.taskId,
      iteration: p?.iteration,
      messageCount: p?.messageCount,
      promptCharsTotal: p?.promptCharsTotal,
      systemPromptChars: p?.systemPromptChars,
      thinkOverride: p?.thinkOverride
    });
    return;
  }

  if (type === 'subagent:tool_loop:llm_response') {
    // Diagnostic capture: 2000-char response preview + responseLength +
    // hasToolCallMarkup + endsWithFenceClose flags + llmDurationMs.
    // Lets us tell apart parser bugs from "model never emitted markup",
    // latency from hang, and reasoning-fence-eaten-the-output from
    // truncation when a subagent stalls.
    const p = payload as {
      iteration?: number;
      response?: string;
      responseLength?: number;
      hasToolCallMarkup?: boolean;
      endsWithFenceClose?: boolean;
      llmDurationMs?: number;
      taskId?: string;
    };
    void turnLog?.append({
      type: 'subagent-llm-response',
      taskId: p?.taskId,
      iteration: p?.iteration,
      responseLength: p?.responseLength,
      hasToolCallMarkup: p?.hasToolCallMarkup,
      endsWithFenceClose: p?.endsWithFenceClose,
      llmDurationMs: p?.llmDurationMs,
      responsePreview: typeof p?.response === 'string' ? p.response.slice(0, 2000) : undefined
    });
    return;
  }

  if (type === 'subagent:tool_loop:tool_calls') {
    const p = payload as { iteration?: number; tools?: string[]; taskId?: string };
    void turnLog?.append({
      type: 'subagent-tool-calls',
      taskId: p?.taskId,
      iteration: p?.iteration,
      tools: p?.tools ?? []
    });
    return;
  }

  if (type === 'task:done') {
    const p = payload as { iterations?: number; hitLimit?: boolean; taskId?: string };
    const key = typeof p?.taskId === 'string' && p.taskId ? p.taskId : TurnState.SYNC_KEY;
    const buf = state.subagentBuffers.get(key);
    if (buf) {
      buf.iterations = p?.iterations ?? 0;
      buf.hitLimit = Boolean(p?.hitLimit);
    }
    // Backgrounded tasks render their card here (with real iter/tool
    // counts), since the parent's `task` tool result already returned
    // at spawn time with no work done. Pull the synopsis from the
    // BackgroundTaskStore record. If the assistant entry isn't being
    // built any more (parent turn ended), the card is dropped — the
    // auto-inject path delivers the synopsis on the user's next turn
    // instead.
    if (buf?.backgrounded && key !== TurnState.SYNC_KEY) {
      const record = background.get(key);
      const synopsis = record?.synopsis ?? '';
      const fence = JSON.stringify({
        goal: buf.goal,
        result: synopsis,
        iterations: buf.iterations ?? 0,
        hitLimit: buf.hitLimit ?? false,
        tools: buf.tools,
        isError: false
      });
      // Only mutate if the entry is still in the conversation — it
      // can get filtered out (e.g. empty-on-error path) or the user
      // may have started a new turn. Either way, an append-and-sync
      // to a detached entry would silently miss the UI.
      if (isAssistantEntryLive()) {
        assistantEntry.content += `\n\n\`\`\`bandit-subagent\n${fence}\n\`\`\`\n`;
        assistantEntry.payload = assistantEntry.content;
        syncState();
      }
      state.subagentBuffers.delete(key);
    }
    return;
  }

  if (type === 'task:error') {
    const p = payload as { taskId?: string; error?: string };
    const key = typeof p?.taskId === 'string' && p.taskId ? p.taskId : TurnState.SYNC_KEY;
    const buf = state.subagentBuffers.get(key);
    if (buf) {
      buf.hitLimit = false;
      buf.iterations = 0;
    }
    // Same backgrounded-render branch as task:done, but mark the card
    // as an error so the webview borders it red.
    if (buf?.backgrounded && key !== TurnState.SYNC_KEY) {
      const fence = JSON.stringify({
        goal: buf.goal,
        result: p?.error ?? 'subagent failed',
        iterations: buf.iterations ?? 0,
        hitLimit: false,
        tools: buf.tools,
        isError: true
      });
      if (isAssistantEntryLive()) {
        assistantEntry.content += `\n\n\`\`\`bandit-subagent\n${fence}\n\`\`\`\n`;
        assistantEntry.payload = assistantEntry.content;
        syncState();
      }
      state.subagentBuffers.delete(key);
    }
    return;
  }
}
