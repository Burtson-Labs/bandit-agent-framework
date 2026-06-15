import * as path from 'path';
import { previewText, runHooks, type HookSettings, type TodoStore, type TurnLogger } from '@burtson-labs/host-kit';
import type { StatusIndicatorController } from '../statusIndicators';
import { TurnState } from '../turnState';
import { formatToolPrimaryDisplay, readFileSafe } from '../../helpers/formatting';
import type { ToolCallDetail } from '../../helpers/toolDetail';
import type { ToolCallDetailService } from '../../provider/services/toolCallDetailService';

/**
 * Deps for the tool-events family. Same shape pattern as ChatEventDeps:
 * the provider implements the callbacks so this module never reaches
 * into the provider class directly.
 */
export interface ToolEventDeps {
  state: TurnState;
  turnLog: TurnLogger | null;
  indicators: StatusIndicatorController;
  workspaceRoot: string;
  toolToSkill: Map<string, string>;
  skillNameById: Map<string, string>;
  hookSettings: HookSettings;
  toolCallDetails: ToolCallDetailService;
  todoStore: TodoStore;
  syncState: () => void;
  setStatusMessage: (text: string) => void;
  /**
   * Mid-iteration push of the conversation list to the webview without
   * persisting. Mirrors the inline `void this.updateConversation(
   * [...this.conversations.messages], { persist: false })` call from the
   * old tool_execute handler — preserved verbatim because the timeline
   * card flush relies on the webview seeing this entry before the next
   * iteration's chunks arrive.
   */
  updateConversation: () => void;
}

/**
 * Handles the tool-events family of the tool-use loop's emit callback:
 * `tool_loop:tool_execute`, `tool_loop:tool_result`, `tool_loop:tool_error`,
 * `tool_loop:tool_blocked`, `tool_loop:tool_not_found`.
 *
 * Behavior preserved byte-for-byte from the inline switch the provider
 * used to host. The v1.7.341 timeline-card label-flip threshold (5s + 1KB
 * snapshot) lives in agent-core's loop emit boundary, not here — this
 * handler just records what agent-core reports.
 */
export function handleToolEvent(type: string, payload: unknown, deps: ToolEventDeps): void {
  const {
    state,
    turnLog,
    indicators,
    workspaceRoot,
    toolToSkill,
    skillNameById,
    hookSettings,
    toolCallDetails,
    todoStore,
    syncState,
    setStatusMessage,
    updateConversation
  } = deps;
  const assistantEntry = state.assistantEntry;

  if (type === 'tool_loop:tool_error') {
    const p = payload as { name?: string; error?: string };
    void turnLog?.append({ type: 'tool-error', name: p?.name, error: p?.error });
    return;
  }

  if (type === 'tool_loop:tool_blocked') {
    const p = payload as { name?: string; reason?: string };
    void turnLog?.append({ type: 'tool-blocked', name: p?.name, reason: p?.reason });
    return;
  }

  if (type === 'tool_loop:tool_not_found') {
    const p = payload as { name?: string };
    void turnLog?.append({ type: 'tool-not-found', name: p?.name });
    return;
  }

  if (type === 'tool_loop:tool_execute') {
    indicators.stopThinking();
    indicators.stopToolCallGen();
    const p = payload as { name?: string; params?: Record<string, string> };
    const name = p?.name ?? '';
    // keep the thinking ticker alive across the `task`
    // tool's await. Subagent runs are 30-180s of silent thread
    // otherwise: tool_loop:tool_execute stops the ticker like it
    // does for any other tool, but task is the only tool whose
    // resolution takes minutes. Restarting the ticker here so the
    // user sees something cycling. The parent's first real chunk
    // on the next iteration will stop it again.
    if (name === 'task') {
      indicators.startThinking();
    }
    void turnLog?.append({
      type: 'tool-execute',
      name,
      params: p?.params ? Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, previewText(v)])) : {}
    });
    const skillId = name ? toolToSkill.get(name) : undefined;
    const skillName = skillId ? skillNameById.get(skillId) : undefined;
    // Announce the skill once per contiguous run of its tools so users
    // see which skill the agent is invoking without repeating every call.
    if (skillId && skillId !== state.lastAnnouncedSkillId && skillName) {
      const skillMarker = `\n\n_▸ using skill: ${skillName}_\n`;
      if (!assistantEntry.content.endsWith(skillMarker)) {
        assistantEntry.content += skillMarker;
        assistantEntry.payload = assistantEntry.content;
      }
      state.lastAnnouncedSkillId = skillId;
    }
    // Capture pre-write state for diff summaries. We read here (before
    // the tool runs) so we can compare against params.content later.
    // IMPORTANT: only capture `before` on the FIRST edit to this file
    // within an iteration. Later parallel edits to the same file
    // overwriting this would clobber the original pre-iteration
    // state and make the final diff show only the last edit's delta.
    if (name === 'write_file' && p?.params?.path) {
      const absPath = path.isAbsolute(p.params.path) ? p.params.path : path.resolve(workspaceRoot, p.params.path);
      if (!state.pendingWriteBefore.has(absPath)) {
        state.pendingWriteBefore.set(absPath, readFileSafe(absPath));
      }
      state.pendingWriteTool.set(absPath, 'write_file');
      state.pendingWriteAfter.set(absPath, p.params.content ?? '');
    }
    // apply_edit / replace_range: capture before-state too so we can
    // render a diff card on success. Without this, the user sees the
    // italic `→ apply_edit …` line and then nothing — no visual
    // confirmation that the edit landed or what changed.
    if ((name === 'apply_edit' || name === 'replace_range') && p?.params?.path) {
      const absPath = path.isAbsolute(p.params.path) ? p.params.path : path.resolve(workspaceRoot, p.params.path);
      // Only set on FIRST edit to this file this iteration.
      // Multiple parallel same-file edits should
      // share one diff card showing the cumulative change.
      if (!state.pendingWriteBefore.has(absPath)) {
        state.pendingWriteBefore.set(absPath, readFileSafe(absPath));
      }
      state.pendingWriteTool.set(absPath, name as 'apply_edit' | 'replace_range');
      // `after` is computed from the actual file post-edit (in
      // tool_result); the placeholder keeps the key ordering
      // consistent with write_file's flow.
      state.pendingWriteAfter.set(absPath, '');
    }
    // run_command: stash params so the tool_result handler can
    // pair IN (command) with OUT (captured stdout/stderr).
    if (name === 'run_command') {
      state.pendingRunCommand = {
        cmd: String(p?.params?.cmd ?? ''),
        args: String(p?.params?.args ?? '')
      };
    }
    // Track the most recent edit path so the tool_result handler
    // can snapshot the post-write disk state IMMEDIATELY rather
    // than waiting for the iteration-boundary flush.
    if ((name === 'write_file' || name === 'apply_edit' || name === 'replace_range' || name === 'apply_patch') && p?.params?.path) {
      const absPath = path.isAbsolute(p.params.path) ? p.params.path : path.resolve(workspaceRoot, p.params.path);
      if (!state.pendingWriteTool.has(absPath) && name === 'apply_patch') {state.pendingWriteTool.set(absPath, 'apply_patch');}
      state.pendingEditPath = absPath;
    }
    // Surface the tool call inline in the chat so users see what the
    // agent is doing. Paths get compacted to a workspace-relative
    // form so the transcript stays readable.
    const primaryParam = formatToolPrimaryDisplay(name, p?.params, workspaceRoot);
    const display = primaryParam ? `→ ${name} ${primaryParam}` : `→ ${name}`;
    // Repeat detection — if this tool+primary was invoked in the
    // recent window, render a distinct marker so the user sees the
    // model is redoing work (rather than N identical lines stacking
    // up and looking like normal progress).
    const isRepeat = state.recentToolCallDisplays.slice(-TurnState.REPEAT_WINDOW).includes(display);
    // Emit as a bandit-tl (timeline) fence rather than raw italic
    // markdown. The webview renderer turns consecutive bandit-tl
    // rows into a vertical rail with status dots. The `id` lets
    // tool_result rewrite this row's status when the call finishes.
    const tlId = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const tlPayload = JSON.stringify({
      id: tlId,
      glyph: isRepeat ? '↺' : '→',
      name,
      primary: primaryParam || null,
      status: isRepeat ? 'repeat' : 'running',
      skill: skillName ?? null
    });
    // Remember the id so tool_result can find and mutate this
    // specific fence. Pending entries are keyed by tool name; if
    // multiple parallel calls to the same tool fire, the Map
    // stores the latest (and tool_result events come back in
    // submission order, so they pair up correctly).
    state.pendingTimelineIds.set(name, tlId);
    const marker = `\n\n\`\`\`bandit-tl\n${tlPayload}\n\`\`\`\n`;
    state.recentToolCallDisplays.push(display);
    if (state.recentToolCallDisplays.length > TurnState.REPEAT_WINDOW * 2) {
      state.recentToolCallDisplays.splice(0, state.recentToolCallDisplays.length - TurnState.REPEAT_WINDOW);
    }
    if (!assistantEntry.content.endsWith(marker)) {
      // Strip any trailing partial-tag starter left from the
      // previous iteration's LLM stream (`…<` or `…<tool_c`).
      // The iteration-boundary truncation clears whole
      // `<tool_call>` blocks but can miss the bare `<` that
      // lands between a tool marker and the next iteration's
      // first streamed chunk, leaving `foo.cs<` stuck in
      // history. Clean it here so every marker starts flush.
      assistantEntry.content = assistantEntry.content.replace(
        /<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?$|<$/,
        ''
      );
      // Close any unclosed reasoning fence before the tool marker —
      // appending a bandit-tl fence inside an open ```bandit-reasoning
      // fence makes the renderer read the tl opener as the reasoning
      // closer and dump the tl JSON as a raw code block.
      const lastReasoningOpen = assistantEntry.content.lastIndexOf('```bandit-reasoning');
      if (lastReasoningOpen !== -1
        && !/\n\s*```/.test(assistantEntry.content.slice(lastReasoningOpen + '```bandit-reasoning'.length))) {
        assistantEntry.content = assistantEntry.content.replace(/\s*$/, '') + '\n```\n';
      }
      assistantEntry.content += marker;
      assistantEntry.payload = assistantEntry.content;
      updateConversation();
      syncState();
    }
    setStatusMessage(skillName ? `Running ${skillName}: ${name}…` : `Running tool: ${name}…`);
    return;
  }

  if (type === 'tool_loop:tool_result') {
    const p = payload as { name?: string; isError?: boolean; outputLength?: number; outputSnippet?: string; outputFull?: string };
    const name = p?.name ?? '';
    const started = state.toolStartedAt.get(name);
    const duration = started ? Date.now() - started : 0;
    void turnLog?.append({ type: 'tool-result', name, isError: Boolean(p?.isError), durationMs: duration, outputLength: p?.outputLength });
    void runHooks('PostToolUse', hookSettings, { toolName: name, durationMs: duration }, workspaceRoot);

    // Snapshot the post-write disk state IMMEDIATELY for edit
    // tools when the result was successful. Closing the gap
    // between "tool wrote the file" and "diff renderer reads
    // the file" matters because anything in that gap (a
    // formatter, the user reverting in the editor, git stash,
    // a follow-up apply_edit fixing TS errors, the IDE's
    // auto-save round-trip) produces a wrong diff in the chat panel.
    if (
      !p?.isError
      && state.pendingEditPath
      && (name === 'write_file' || name === 'apply_edit' || name === 'replace_range' || name === 'apply_patch')
    ) {
      const snapshot = readFileSafe(state.pendingEditPath);
      if (snapshot.length > 0 || state.pendingWriteBefore.has(state.pendingEditPath)) {
        state.pendingWriteAfter.set(state.pendingEditPath, snapshot);
      }
      state.pendingEditPath = null;
    }

    // Flip this tool's timeline row from running → done/error and
    // back-fill its duration. We find the exact fence by its id
    // (set in tool_execute above) and rewrite the JSON payload in
    // place inside assistantEntry.content. If the id is gone
    // (e.g. truncated by the iteration-boundary cleanup) we just
    // no-op — the row stays "running" visually.
    const tlId = state.pendingTimelineIds.get(name);

    // Cache the full output keyed by the timeline id so the
    // webview can open a detail view on card click. tlId
    // doubles as the runId — both the bandit-tl row and the
    // bandit-run card reference this same key. The service
    // handles eviction at the cap and the fire-and-forget
    // disk write for cross-reload survival.
    if (tlId) {
      const detail: ToolCallDetail = {
        tool: name,
        params: state.pendingRunCommand
          ? { cmd: state.pendingRunCommand.cmd, args: state.pendingRunCommand.args }
          : null,
        cmd: state.pendingRunCommand
          ? [state.pendingRunCommand.cmd, state.pendingRunCommand.args].filter(Boolean).join(' ').trim()
          : undefined,
        output: p?.outputFull ?? p?.outputSnippet ?? '',
        outputLength: p?.outputLength ?? (p?.outputSnippet?.length ?? 0),
        isError: Boolean(p?.isError),
        durationMs: duration,
        at: Date.now()
      };
      toolCallDetails.capture(tlId, detail, workspaceRoot);
    }
    if (tlId) {
      state.pendingTimelineIds.delete(name);
      const fenceRe = new RegExp(
        '```bandit-tl\\n(\\{"id":"' + tlId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^\\n]*\\})\\n```',
        'g'
      );
      assistantEntry.content = assistantEntry.content.replace(fenceRe, (_full: string, jsonStr: string) => {
        try {
          const row = JSON.parse(jsonStr);
          row.status = p?.isError ? 'error' : 'done';
          row.durationMs = duration;
          return '```bandit-tl\n' + JSON.stringify(row) + '\n```';
        } catch {
          return _full;
        }
      });
      assistantEntry.payload = assistantEntry.content;
      syncState();
    }

    // task (subagent) completion: render a collapsible card
    // that surfaces the goal, the tools the subagent ran, and
    // the final synopsis. Parent assistantEntry.content stays
    // clean — the card is the whole subagent trace.
    //
    // Synchronous tasks render here at the tool-result moment
    // because the subagent has fully completed before the parent
    // tool result lands. Backgrounded tasks DO NOT render here:
    // at this point the subagent has only just been spawned and
    // the buffer has 0 iterations / 0 tools — the user-visible
    // card would be the misleading "0 iter · 0 tools" pill we
    // saw 2026-05-06. Backgrounded cards render later from the
    // `task:done` / `task:error` handlers when real data is available.
    if (name === 'task') {
      const buf = state.subagentBuffers.get(TurnState.SYNC_KEY);
      if (buf && !buf.backgrounded) {
        const synopsis = (payload as { outputSnippet?: string } | undefined)?.outputSnippet ?? '';
        const fence = JSON.stringify({
          goal: buf.goal,
          result: synopsis,
          iterations: buf.iterations ?? 0,
          hitLimit: buf.hitLimit ?? false,
          tools: buf.tools,
          isError: Boolean(p?.isError)
        });
        assistantEntry.content += `\n\n\`\`\`bandit-subagent\n${fence}\n\`\`\`\n`;
        assistantEntry.payload = assistantEntry.content;
        state.subagentBuffers.delete(TurnState.SYNC_KEY);
        syncState();
      }
    }

    // run_command: render a Claude-Code-style IN/OUT card. The
    // agent-core event carries up to 280 chars of outputSnippet;
    // anything longer gets a "… (N more chars)" marker. The
    // renderer in App.tsx picks up the `bandit-run` fence.
    if (name === 'run_command' && state.pendingRunCommand) {
      const fullCmd = [state.pendingRunCommand.cmd, state.pendingRunCommand.args].filter(Boolean).join(' ').trim();
      const snippet = p?.outputSnippet ?? '';
      const truncated = (p?.outputLength ?? 0) > snippet.length;
      const payloadJson = JSON.stringify({
        // runId pairs this card with the toolCallDetails map so
        // the webview can open the full IN/OUT in an editor tab.
        runId: tlId ?? null,
        cmd: fullCmd,
        out: snippet,
        isError: Boolean(p?.isError),
        truncated,
        totalLen: p?.outputLength ?? snippet.length
      });
      assistantEntry.content += `\n\n\`\`\`bandit-run\n${payloadJson}\n\`\`\`\n`;
      assistantEntry.payload = assistantEntry.content;
      state.pendingRunCommand = null;
      syncState();
    }

    // Diff card rendering is deferred to iteration boundaries
    // (see flushPendingEditDiffs) so that parallel edits to
    // the same file get combined into one cumulative card
    // and parallel edits to different files each get their
    // own card. Rendering per-tool_result would mis-correlate
    // when the model emits 10 apply_edits in one iteration
    // (real telemetry: S3Api Apr 22, iteration 2 had 10).

    // todo_write success → render the current checklist as a block.
    // The model calls todo_write repeatedly (once per plan revision /
    // status change), so we REPLACE the previous Plan block in
    // place instead of appending a new one.
    if (name === 'todo_write' && !p?.isError) {
      const items = todoStore.snapshot();
      if (items.length > 0) {
        // Accept every status alias the store might have persisted
        // before the normalizer landed (old "complete" payloads
        // still in conversation state), plus the canonical forms.
        const isDone = (s: string) =>
          s === 'done' || s === 'complete' || s === 'completed' || s === 'finished';
        const isActive = (s: string) =>
          s === 'in_progress' || s === 'in-progress' || s === 'inprogress'
          || s === 'active' || s === 'working' || s === 'running';
        const lines = items.map(t => {
          const status = String(t.status ?? '').toLowerCase();
          const box = isDone(status) ? '✓' : isActive(status) ? '◐' : '○';
          return `${box} ${t.content}`;
        });
        const block = `\n\n**Plan**\n${lines.map(l => '- ' + l).join('\n')}\n`;
        // Remove ALL prior Plan blocks from the content, then
        // append a fresh one at the current end. This way the
        // plan always renders near the most recent activity
        // instead of getting stranded near the top of a long
        // turn's transcript.
        const PLAN_BLOCK_REGEX = /\n\n\*\*Plan\*\*\n(?:- [^\n]*\n)+/g;
        assistantEntry.content = assistantEntry.content.replace(PLAN_BLOCK_REGEX, '');
        assistantEntry.content += block;
        assistantEntry.payload = assistantEntry.content;
        syncState();
      }
    }
    return;
  }
}
