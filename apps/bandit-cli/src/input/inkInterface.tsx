/**
 * EventEmitter adapter that mirrors `readline.Interface`'s surface area
 * but renders through ink. cli.ts already references `rl.line`,
 * `rl.cursor`, `rl.write`, `rl.prompt`, `rl.setPrompt`, `rl.pause`,
 * `rl.resume`, `rl.close`, `rl.on('line')` and `rl.on('close')` across
 * ~80 call sites. To keep that diff small we expose the same shape and
 * proxy reads/writes into React state via an external store.
 *
 * Behind-flag in v1.7.307; v1.7.308 fixed:
 *   - scrollback bloat (submitted prompts get committed as plain `❯ <line>`,
 *     not as a frozen snapshot of the framed input)
 *   - `@`-mention picker now lives inside the React tree (the external
 *     openFilePicker fought ink for raw stdin and never opened)
 *   - Up/Down history pulls real entries from the session
 */

import * as React from 'react';
import { EventEmitter } from 'events';
import { render, Box, Static, Text, type Instance } from 'ink';
import { InkInputFrame } from './InkInputFrame';
import { TurnView } from './TurnView';
// Type-only import so spinner.ts (which registers module-level process.on
// 'SIGINT'/'exit' handlers) is NOT pulled into this module's RUNTIME graph
// — that coupling starved the turn-view demo's timers. The plan snapshot
// is rendered inline below instead of via spinner's renderTodoTree.
import type { DockTodo } from '../spinner';
import { c, glyph } from '../ansi';

/**
 * Live progress block for background subagent activity. Painted above
 * the composer when the host has any running tasks; vanishes the moment
 * the running set goes empty. Rendering is a pure function of the
 * `narratorLines` array set by the host — no inference, no second model,
 * works on every provider. The actual content + cadence is owned by
 * cli.ts which subscribes to the BackgroundTaskStore and ticks every 2s
 * to refresh the elapsed-time figures.
 */
function NarratorBlock({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" dimColor>▸ background tasks</Text>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}

export interface InkInterfaceOptions {
  /** Workspace root for the @-mention overlay's file search. */
  cwd: string;
  /** Footer hint line. Same content as the ANSI footer in cli.ts. */
  footerTip: string;
  /** Tab completer — matches readline's (line) => [hits, substring] shape.
   *  Surface kept for parity; the ink frame does its own @-mention overlay
   *  via the `searchFiles` option below. */
  completer?: (line: string) => [string[], string];
  /** Synchronous workspace file matcher used by the @-mention overlay.
   *  Same function the readline completer uses, just passed through here
   *  so the React component doesn't need to import cli.ts internals. */
  searchFiles?: (query: string) => string[];
  /** Called when the user presses Ctrl+V — same hook cli.ts uses with
   *  readline. Should return the @-mention insertion string (e.g.
   *  ".bandit/pastes/paste-…png") if a clipboard image was captured. */
  onCtrlV?: () => Promise<string | null | void>;
  /** Called on every keystroke so the spinner can pause itself while
   *  the user is typing. */
  onActivity?: () => void;
  /** History navigation (Up/Down). Returns the recalled line or undefined. */
  historyPrev?: () => string | undefined;
  historyNext?: () => string | undefined;
  /** Called while a turn is in flight (ink paused, raw-stdin capture)
   *  with the current type-ahead buffer on every change, so the host can
   *  echo it live — e.g. as the composer row of the spinner's dock.
   *  Restores the readline path's "see what you type mid-turn." */
  onTurnType?: (buffer: string) => void;
  /** Called when the user presses Enter mid-turn. The host queues the
   *  line to run after the current turn finishes (the lost
   *  "send a message while the AI is working" behavior). */
  onTurnSubmit?: (line: string) => void;
  /** Turn-view only: invoked by pause() while turn mode is active, BEFORE
   *  ink unmounts. The host uses this to suspend its mid-turn stdout
   *  capture so a sub-flow that owns raw stdin (the permission picker's
   *  arrow menu, etc.) can write its prompt straight to the terminal
   *  instead of having it swallowed into <Static> while ink is gone. */
  onPauseInTurn?: () => void;
  /** Turn-view only: invoked by resume() while turn mode is active, AFTER
   *  ink re-mounts. Reinstalls the stdout capture the matching
   *  onPauseInTurn suspended, so the rest of the turn keeps committing to
   *  <Static>. */
  onResumeInTurn?: () => void;
}

interface CommittedLine {
  id: number;
  text: string;
  /** When true the line is rendered RAW (a bare <Text>) so its own
   *  embedded ANSI fully owns the styling. Phase 0 proved ink preserves
   *  embedded color/truecolor through <Static>; forcing an outer cyan
   *  (the prompt-echo default) would tint uncolored segments. Prompt
   *  echoes (`❯ …`) stay non-raw → cyan; turn output is raw. */
  raw?: boolean;
}

interface InkInterfaceState {
  value: string;
  promptText: string;
  /** Lines committed above the live frame. Rendered via <Static> so each
   *  line lands in terminal scrollback exactly once. */
  committed: CommittedLine[];
  /** True while a submit is in flight — the live frame stops rendering
   *  so the row it occupied is empty BEFORE pause()/unmount fires.
   *  Without this, unmount's last paint writes the just-submitted
   *  frame contents into scrollback (= the empty composer box the
   *  user sees stacked between turns). Set in handleSubmit, cleared
   *  in resetForResume. */
  submitting: boolean;
  /** Bumps every time the buffer value is set programmatically (paste,
   *  history recall, type-ahead seed, external rl.write). Used as the
   *  TextInput's React key in InkInputFrame so a fresh mount initializes
   *  `cursorOffset = value.length`, jumping the visible cursor to the
   *  end of the inserted text. Plain user typing goes through
   *  setValue() WITHOUT bumping this so React reuses the TextInput
   *  instance and cursor state stays continuous. */
  cursorBump: number;
  /** Live narrator lines for background subagent activity. Rendered as
   *  a compact "⚡ background tasks" block above the composer whenever
   *  non-empty. The host sets this from a backgroundStore subscription
   *  + a 2s wallclock tick, so the user sees subagent progress in real
   *  time without any second-model inference — narration is pure
   *  task-store snapshot rendering, works identically on Ollama / cloud
   *  / OpenAI-compatible providers. */
  narratorLines: string[];
  /** True while a turn is in flight AND the turn-view is active (ink stays
   *  mounted through the turn instead of pausing/unmounting). When true the
   *  App renders <TurnView> — the persistent mid-turn composer + plan tree
   *  + status — instead of the idle <InkInputFrame>. Gated by the host on
   *  BANDIT_TURN_VIEW; the default path never sets this. */
  turnMode: boolean;
  /** Plan/todo items shown as an in-place tree in the turn view. */
  turnPlan: DockTodo[];
  /** Pre-colored status line (spinner glyph + tok/s + elapsed). '' hides it. */
  turnStatus: string;
  /** In-progress streamed line (assistant tail not yet newlined). '' hides it. */
  turnStream: string;
  /** Mid-turn composer buffer — distinct from `value` so entering/leaving
   *  turn mode never clobbers a half-typed idle prompt. */
  turnComposer: string;
  /** CTA hint under the composer. */
  turnCta: string;
  /** Bumps when turnComposer is set programmatically so the turn-view
   *  TextInput remounts with the cursor at end-of-text. */
  turnComposerBump: number;
  /** True while a mid-turn sub-flow is reading a line (a permission
   *  deny+note, a yes/no answer — the host armed `lineIntercept`). When
   *  set, the composer delivers the raw value verbatim even when EMPTY
   *  (empty Enter = plain deny per the picker contract) and does NOT
   *  classify it as a `/btw` nudge. Without this an empty-Enter on a
   *  deny+note prompt is swallowed and the whole turn hangs. */
  awaitingLine: boolean;
}

class InkInterfaceStore {
  private state: InkInterfaceState = {
    value: '', promptText: '❯ ', committed: [], submitting: false, cursorBump: 0, narratorLines: [],
    turnMode: false, turnPlan: [], turnStatus: '', turnStream: '', turnComposer: '', turnCta: '', turnComposerBump: 0,
    awaitingLine: false
  };
  private listeners = new Set<() => void>();
  private nextCommitId = 1;

  getSnapshot = (): InkInterfaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setValue(next: string): void {
    if (this.state.value === next) return;
    this.state = { ...this.state, value: next };
    this.emit();
  }

  /** Same as setValue() but also bumps the cursor counter. Use for any
   *  programmatic value update where the visible cursor should jump to
   *  the end of the new text (paste, history recall, type-ahead seed,
   *  external rl.write). */
  setValueProgrammatic(next: string): void {
    if (this.state.value === next) return;
    this.state = { ...this.state, value: next, cursorBump: this.state.cursorBump + 1 };
    this.emit();
  }

  setPromptText(next: string): void {
    if (this.state.promptText === next) return;
    this.state = { ...this.state, promptText: next };
    this.emit();
  }

  /** Replace the narrator block contents. Empty array hides the block.
   *  Host wires this from a backgroundStore subscription so subagent
   *  progress streams into the UI without any extra inference. */
  setNarratorLines(next: string[]): void {
    // Reference-equality short-circuit isn't enough — host produces fresh
    // arrays every tick. Compare contents so an unchanged snapshot
    // doesn't trigger a render storm at 2 Hz.
    const cur = this.state.narratorLines;
    if (cur.length === next.length && cur.every((l, i) => l === next[i])) return;
    this.state = { ...this.state, narratorLines: next };
    this.emit();
  }

  /** Append a line to the committed-scrollback array. Static items are
   *  immutable from ink's perspective — once rendered, each item stays
   *  in the terminal buffer. Never mutate or remove past entries.
   *  `raw` lines render without the outer cyan tint so their embedded
   *  ANSI owns the styling (turn output); the default (false) keeps the
   *  prompt-echo cyan. */
  commitLine(text: string, raw = false): void {
    const entry: CommittedLine = { id: this.nextCommitId++, text, raw };
    this.state = { ...this.state, committed: [...this.state.committed, entry] };
    this.emit();
  }

  // ---- turn-view state (all no-ops on unchanged input) ----

  setTurnMode(next: boolean): void {
    if (this.state.turnMode === next) return;
    this.state = { ...this.state, turnMode: next };
    this.emit();
  }

  setTurnPlan(items: DockTodo[]): void {
    const cur = this.state.turnPlan;
    if (
      cur.length === items.length &&
      cur.every((t, i) => t.status === items[i].status && t.content === items[i].content)
    ) return;
    this.state = { ...this.state, turnPlan: items };
    this.emit();
  }

  setTurnStatus(text: string): void {
    if (this.state.turnStatus === text) return;
    this.state = { ...this.state, turnStatus: text };
    this.emit();
  }

  setTurnStream(text: string): void {
    if (this.state.turnStream === text) return;
    this.state = { ...this.state, turnStream: text };
    this.emit();
  }

  setTurnComposer(text: string, programmatic = false): void {
    if (this.state.turnComposer === text) return;
    this.state = {
      ...this.state,
      turnComposer: text,
      turnComposerBump: programmatic ? this.state.turnComposerBump + 1 : this.state.turnComposerBump
    };
    this.emit();
  }

  setTurnCta(text: string): void {
    if (this.state.turnCta === text) return;
    this.state = { ...this.state, turnCta: text };
    this.emit();
  }

  setAwaitingLine(next: boolean): void {
    if (this.state.awaitingLine === next) return;
    this.state = { ...this.state, awaitingLine: next };
    this.emit();
  }

  /** Reset the ephemeral turn-view fields (stream/status/plan/composer)
   *  on turn end. The committed array is NOT touched — those lines are
   *  real scrollback and ink has already written each once. */
  clearTurnState(): void {
    this.state = {
      ...this.state,
      turnPlan: [], turnStatus: '', turnStream: '', turnComposer: '', turnCta: '', awaitingLine: false
    };
    this.emit();
  }

  setSubmitting(next: boolean): void {
    if (this.state.submitting === next) return;
    this.state = { ...this.state, submitting: next };
    this.emit();
  }

  /** Drop the committed-line array AND the submitting flag so the next
   *  mount starts with a fresh empty frame and no replay of prior
   *  static items (each was already written to scrollback during the
   *  prior mount; re-rendering would duplicate them). Called from
   *  `iface.resume()`. */
  resetForResume(): void {
    if (this.state.committed.length === 0 && !this.state.submitting) return;
    this.state = { ...this.state, committed: [], submitting: false };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export interface InkLineInterface extends EventEmitter {
  /** Current buffer value. Writable so cli.ts can splice in content
   *  (clipboard image paste mention, etc.). */
  line: string;
  /** Cursor position (always at end-of-line in ink — TextInput owns
   *  the cursor visually; we expose this for surface parity only). */
  cursor: number;
  prompt(preserveCursor?: boolean): void;
  setPrompt(text: string): void;
  /** Inject text at the cursor (used by clipboard-image paste). */
  write(data: string | null, key?: { name?: string; ctrl?: boolean }): void;
  pause(): InkLineInterface;
  resume(): InkLineInterface;
  /** True when pause() has been called and the live frame is currently
   *  unmounted. Callers like the MCP trust gate use this to decide
   *  whether they need to temporarily resume ink to receive input. */
  isPaused(): boolean;
  close(): void;
  /** No-op in ink — readline's internal repaint helper. Kept for
   *  surface parity with the spinner-pause keypress handler. */
  _refreshLine(): void;
  /** Replace the narrator block contents above the composer. Empty
   *  array (or no call) hides the block entirely. Host wires this from
   *  a BackgroundTaskStore subscription + a 2s wallclock tick so
   *  subagent progress streams into the UI without any second-model
   *  inference. Optional so callers can call it through `?.` without
   *  branching on the readline-vs-ink path. */
  setNarratorLines?(lines: string[]): void;

  // ---- turn-view surface (BANDIT_TURN_VIEW) ----
  // All optional so the readline path and the default ink path can call
  // through `?.` without branching. Calling these keeps ink MOUNTED
  // through the turn (no pause/unmount) and switches the live region to
  // the persistent composer + plan tree + status.

  /** Enter turn mode: ink stays mounted, the idle input frame is replaced
   *  by <TurnView>. `cta` overrides the default composer hint. */
  enterTurnMode?(cta?: string): void;
  /** Leave turn mode: flush any partial streamed line to scrollback, drop
   *  the ephemeral turn state, restore the idle input frame. */
  exitTurnMode?(): void;
  /** True while turn mode is active. */
  isTurnMode?(): boolean;
  /** Commit one finished line to <Static> scrollback (raw — its own ANSI
   *  owns the styling). The append-only record the user scrolls back to. */
  commitTurnLine?(text: string): void;
  /** Set the in-place plan/todo tree. */
  setTurnPlan?(items: DockTodo[]): void;
  /** Set the ephemeral status line (spinner glyph + tok/s + elapsed). */
  setTurnStatus?(text: string): void;
  /** Set the in-progress streamed line (assistant tail, pre-newline). */
  setTurnStream?(text: string): void;
  /** Set the composer CTA hint. */
  setTurnCta?(text: string): void;
  /** Mark whether a mid-turn sub-flow is reading a line (host armed
   *  `lineIntercept`). While true the composer delivers Enter verbatim
   *  (incl. empty) and skips `/btw` classification, so a deny+note prompt
   *  can't hang on an empty Enter and a `/btw`-prefixed note isn't mangled. */
  setAwaitingLine?(awaiting: boolean): void;
}

export function createInkLineInterface(opts: InkInterfaceOptions): InkLineInterface {
  const emitter = new EventEmitter();
  const store = new InkInterfaceStore();
  let instance: Instance | null = null;
  let closed = false;
  let paused = false;

  // Private writer for ink. The turn-view (BANDIT_TURN_VIEW) monkeypatches
  // `process.stdout.write` mid-turn to line-buffer the agent's output into
  // ink's <Static> scrollback. ink's OWN frame writes must NOT go through
  // that patch (they'd be captured as garbage). So we hand ink a Proxy of
  // process.stdout whose `write` is bound to the ORIGINAL stdout write
  // captured here at mount — everything else (columns, rows, isTTY,
  // on/off for resize) delegates straight through. With no patch active
  // this behaves identically to passing process.stdout; once the patch is
  // installed, ink keeps writing to the real terminal underneath it.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const inkStdout = new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'write') return realStdoutWrite;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as NodeJS.WriteStream;

  const App: React.FC = () => {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

    const handleChange = (next: string): void => {
      store.setValue(next);
    };

    const handleSubmit = (value: string): void => {
      // Commit + hide the frame + defer the emit so React flushes the
      // empty-frame render BEFORE cli.ts pauses ink for the turn.
      // Without the defer, the synchronous emit triggers pause →
      // unmount before React renders the cleared state, and unmount's
      // final paint writes the OLD frame (still showing the typed
      // text) into scrollback as a stale snapshot.
      const promptPrefix = state.promptText.trim() || '❯';
      store.commitLine(`${promptPrefix} ${value}`);
      store.setValue('');
      store.setSubmitting(true);
      queueMicrotask(() => emitter.emit('line', value));
    };

    const handleCtrlV = (beforeValue: string): void => {
      // `beforeValue` is the pre-event props.value from InkInputFrame —
      // the buffer as of the last render, BEFORE ink-text-input's
      // useInput synchronously injected the spurious 'v' that
      // accompanies Ctrl+V. Using this as the strip baseline (rather
      // than store.getSnapshot().value, which already includes the 'v')
      // is the only way the post-paste subtraction works: the store
      // mutation has already happened by the time this handler runs,
      // so any in-process snapshot would over-count by one char.
      const before = beforeValue;
      void (async () => {
        const insertion = await opts.onCtrlV?.();
        if (typeof insertion !== 'string' || insertion.length === 0) return;
        const current = store.getSnapshot().value;
        let base = current;
        if (
          current.length === before.length + 1 &&
          current.startsWith(before) &&
          current.endsWith('v')
        ) {
          base = before;
        }
        // Programmatic path: bumps cursorBump so TextInput remounts
        // with cursor at the end of the just-inserted mention path
        // instead of stranded at column 0.
        store.setValueProgrammatic(base + insertion);
      })();
    };

    const handleHistoryPrev = (): void => {
      const recalled = opts.historyPrev?.();
      if (typeof recalled === 'string') store.setValueProgrammatic(recalled);
    };

    const handleHistoryNext = (): void => {
      const recalled = opts.historyNext?.();
      if (typeof recalled === 'string') store.setValueProgrammatic(recalled);
    };

    const handleTurnComposerSubmit = (value: string): void => {
      const awaiting = store.getSnapshot().awaitingLine;
      const trimmed = value.trim();
      // Clear the composer immediately (programmatic so the next mount's
      // cursor resets to col 0). The host decides queue-vs-nudge by the
      // leading token and renders its own confirmation in the turn view.
      store.setTurnComposer('', true);
      if (awaiting) {
        // A mid-turn sub-flow (permission deny+note, a yes/no answer) is
        // reading a line via the host's lineIntercept. Deliver the raw
        // value VERBATIM — even empty (= plain deny per the picker
        // contract) — and skip /btw classification so a "/btw …" note
        // isn't mangled. turnSubmit → consumedByLineIntercept resolves it.
        emitter.emit('turnSubmit', value);
        return;
      }
      if (trimmed.length === 0) return;
      const btw = trimmed.match(/^\/btw\s+([\s\S]+)$/i);
      if (btw) {
        emitter.emit('nudge', btw[1].trim());
      } else {
        emitter.emit('turnSubmit', trimmed);
      }
    };

    return (
      <>
        <Static items={state.committed}>
          {(item) => (
            item.raw
              ? <Text key={item.id}>{item.text}</Text>
              : <Text key={item.id} color="cyan">{item.text}</Text>
          )}
        </Static>
        {state.turnMode ? (
          <TurnView
            plan={state.turnPlan}
            status={state.turnStatus}
            stream={state.turnStream}
            composer={state.turnComposer}
            // While a sub-flow is reading a line (deny+note, a yes/no
            // answer), the composer IS that answer — so the CTA says so
            // instead of the misleading "type to queue · /btw nudges".
            cta={state.awaitingLine ? 'type your reply · Enter submits · Esc cancels' : state.turnCta}
            cursorBumpKey={state.turnComposerBump}
            onComposerChange={(next) => store.setTurnComposer(next)}
            onComposerSubmit={handleTurnComposerSubmit}
            onEscape={() => emitter.emit('escape')}
          />
        ) : (
          <>
            {!state.submitting && state.narratorLines.length > 0 && (
              <NarratorBlock lines={state.narratorLines} />
            )}
            {!state.submitting && (
              <InkInputFrame
                value={state.value}
                promptText={state.promptText}
                footerTip={opts.footerTip}
                searchFiles={opts.searchFiles}
                completer={opts.completer}
                cursorBumpKey={state.cursorBump}
                onChange={handleChange}
                onAccept={(next) => store.setValueProgrammatic(next)}
                onSubmit={handleSubmit}
                onEscape={() => emitter.emit('escape')}
                onCtrlV={handleCtrlV}
                onActivity={() => opts.onActivity?.()}
                onHistoryPrev={handleHistoryPrev}
                onHistoryNext={handleHistoryNext}
              />
            )}
          </>
        )}
      </>
    );
  };

  instance = render(<App />, { exitOnCtrlC: false, stdout: inkStdout });

  // Ctrl+C → emit 'close' so cli.ts's existing close handler runs
  // (drains queue, disposes mcp pool, saves session, exit(0)).
  process.on('SIGINT', () => {
    if (closed) return;
    closed = true;
    emitter.emit('close');
  });

  // --- Resize hardening: stop the idle composer from stacking ---
  // ink 7 erases its previous frame by the LOGICAL line count it captured at
  // the OLD terminal width (log-update's eraseLines), but the terminal REFLOWS
  // the near-full-width composer border whenever the width changes. A width
  // change — which display sleep/wake, Spaces switches, and lid/monitor events
  // all emit as SIGWINCH while the CLI sits idle — leaves ink erasing the wrong
  // number of physical rows and stranding a copy of the box. Idle through a few
  // of those and the empty frames ladder up (the duplicated-composer bug).
  //
  // We can't safely fix ink's mid-resize erase from out here, but at idle ink
  // owns ONLY the bottom composer: `committed` is reset to [] every turn-end
  // (resetForResume) because those lines live permanently in the terminal's
  // real scrollback via <Static>. So the clean fix is to tear the frame down
  // and re-render once the resize settles — a fresh ink instance has empty
  // log-update state, so it repaints the composer from scratch (no dedupe, no
  // stray) and re-emits nothing into scrollback.
  //
  // We `prependListener` so we win the race against ink's own resized handler
  // and unmount BEFORE it can run its width-stale erase (the unmounted instance
  // then makes ink's handler a no-op). Debounced so a burst of sleep/wake
  // resizes collapses to one repaint, and gated on an actual column change so a
  // same-width SIGWINCH (already erased cleanly) never forces a needless
  // redraw. Turn-mode is left alone — any stray there is wiped when the turn
  // ends and resume() re-renders from scratch.
  let resizeTimer: NodeJS.Timeout | null = null;
  let lastCols = process.stdout.columns ?? 80;
  const onResize = (): void => {
    const cols = process.stdout.columns ?? 80;
    if (cols === lastCols) return; // no width change → no reflow → ink stays clean
    lastCols = cols;
    if (closed || paused || store.getSnapshot().turnMode) return;
    // Tear down before ink's (prepended-after) resized handler runs its broken
    // erase. clear() moves the cursor to the frame's top so the settle-time
    // eraseDown + repaint land in the right place. Only the first event of a
    // burst has a mounted instance; later events just push the settle timer.
    if (instance) {
      try { instance.clear(); } catch { /* non-fatal */ }
      try { instance.unmount(); } catch { /* non-fatal */ }
      instance = null;
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (closed || paused || instance || store.getSnapshot().turnMode) return;
      // Sweep any reflow overflow left below the cursor, then repaint. eraseDown
      // is safe here: the composer is the bottom-most live region, so nothing
      // valuable lives below the cursor (the conversation is scrollback above).
      realStdoutWrite('\x1b[0J');
      instance = render(<App />, { exitOnCtrlC: false, stdout: inkStdout });
    }, 140);
  };
  process.stdout.prependListener('resize', onResize);

  const iface = emitter as InkLineInterface;

  Object.defineProperty(iface, 'line', {
    get: () => store.getSnapshot().value,
    set: (next: string) => store.setValue(next)
  });
  Object.defineProperty(iface, 'cursor', {
    get: () => store.getSnapshot().value.length,
    set: () => {
      // ink-text-input owns the visual cursor; explicit reseating is
      // a no-op.
    }
  });

  iface.prompt = (_preserveCursor?: boolean): void => {
    // Critical for the slash-command / no-pause flow. handleSubmit
    // sets submitting=true to hide the live frame so ink's unmount
    // (which fires when cli.ts pauses for an agent turn) doesn't
    // snapshot a half-typed composer into scrollback. For agent
    // turns my resume() clears submitting on the way back. But
    // slash commands / empty lines / bash-cancel never go through
    // pause/resume, so submitting stays true forever — the
    // InkInputFrame stays unmounted, ink's useInput hook is gone,
    // ink's own bookkeeping calls stdin.unref() (see ink's
    // App.js:225/247), and the process exits cleanly to the shell
    // as soon as the worker is idle.
    //
    // cli.ts calls rl.prompt() at the tail of every non-pause line
    // path. Clearing submitting here re-mounts the InkInputFrame,
    // ink re-refs stdin via the new useInput hook, and the REPL
    // survives. For the agent-turn path, resume() already cleared
    // submitting so this is a no-op.
    if (closed || paused) return;
    if (store.getSnapshot().submitting) {
      store.setSubmitting(false);
    }
    // Belt-and-suspenders: explicitly ref stdin in the brief window
    // between this state update and ink's re-render committing the
    // new useInput hook. Without this, a slow React tick could let
    // the loop drain before ink's setRawMode/ref runs.
    if (process.stdin.isTTY) {
      try { process.stdin.ref(); } catch { /* non-fatal */ }
    }
  };

  iface.setPrompt = (text: string): void => {
    store.setPromptText(text);
  };

  iface.write = (data: string | null, _key?: { name?: string; ctrl?: boolean }): void => {
    if (typeof data === 'string' && data.length > 0) {
      // Programmatic injection — bump cursor so it lands at the end of
      // the appended text instead of staying at column 0.
      store.setValueProgrammatic(store.getSnapshot().value + data);
    }
  };

  // Raw-stdin handler installed only while ink is paused. Lets the user
  // cancel an in-flight turn with Esc, which the InkInputFrame's own
  // useInput hook can't see (it's unmounted for the turn duration).
  // Also keeps a typed-during-turn buffer so plain-text type-ahead
  // surfaces in the input frame when the turn ends — matches the
  // readline path's buffering behavior. Non-printable bytes (cursor
  // keys, etc.) are dropped from the buffer because re-inserting them
  // as literal text would corrupt the next prompt.
  let pauseDataListener: ((chunk: Buffer | string) => void) | null = null;
  let typeAheadBuffer = '';

  iface.pause = (): InkLineInterface => {
    if (paused || closed) return iface;
    const inTurn = store.getSnapshot().turnMode;
    // Turn-view: let the host suspend its stdout capture BEFORE we unmount
    // so the sub-flow that's pausing us (permission picker, etc.) can draw
    // straight to the terminal. No-op outside turn mode / readline path.
    if (inTurn) opts.onPauseInTurn?.();
    paused = true;
    // Turn-view: ERASE the live TurnView frame (composer box + CTA) before
    // unmount. ink's unmount only resets log-update state — it does NOT
    // erase the last frame (log.done()) — so without this the composer
    // strands in scrollback above the sub-flow's prompt. clear() writes the
    // erase escapes; the sub-flow (e.g. the permission menu) then draws
    // where the composer was, and the composer only reappears when ink
    // remounts (resume) — which for deny+note is exactly when the note is
    // being typed. The normal pause path already hides its frame via the
    // `submitting` flag, so this is turn-view only.
    if (inTurn) {
      try { instance?.clear(); } catch { /* non-fatal */ }
    }
    instance?.unmount();
    instance = null;
    // Keep stdin in raw mode so Esc bytes still reach us. Without this
    // ink's unmount cleanup drops raw mode and the terminal switches
    // to cooked — no Esc detection until the user hits Enter.
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode?.(true); } catch { /* non-fatal */ }
    }
    typeAheadBuffer = '';
    pauseDataListener = (chunk: Buffer | string) => {
      // If a sub-flow attached its own keypress listener (permission
      // picker, bash child wrapper, etc.) it owns stdin while active.
      // Don't buffer bytes for type-ahead replay AND don't emit
      // 'escape' — arrow keys send `\x1b[A`, function keys send
      // `\x1bOP`, etc. Treating the leading `\x1b` as a standalone
      // Esc would mistakenly cancel the turn on every navigation
      // keypress inside the picker.
      const subFlowActive = process.stdin.listenerCount('keypress') > 0;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      let changed = false;
      for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        if (b === 0x1b) {
          if (subFlowActive) continue;
          // Standalone Esc cancels the turn. Esc followed by `[` (CSI)
          // or `O` (SS3) is the start of an escape sequence (arrow
          // keys, function keys, paste-bracket markers) — those are
          // never a cancel intent, so we skip without emitting.
          const next = bytes[i + 1];
          if (next === 0x5b || next === 0x4f) continue;
          emitter.emit('escape');
          continue;
        }
        if (b === 0x03) {
          // Ctrl+C — let the SIGINT handler above own the shutdown
          // path. Don't buffer or re-emit here.
          continue;
        }
        if (subFlowActive) {
          // Sub-flow consumes the byte via its own keypress listener;
          // we stay out of the way so we don't double-handle it.
          continue;
        }
        // Enter (CR / LF) submits the buffered line to run after the
        // current turn — this is the "send a message while the AI is
        // working" path. The host queues it; we reset the buffer.
        if (b === 0x0d || b === 0x0a) {
          const line = typeAheadBuffer.trim();
          typeAheadBuffer = '';
          changed = true;
          if (line.length > 0) opts.onTurnSubmit?.(line);
          continue;
        }
        // Backspace / Delete trims the buffer so mid-turn edits work.
        if (b === 0x7f || b === 0x08) {
          if (typeAheadBuffer.length > 0) {
            typeAheadBuffer = typeAheadBuffer.slice(0, -1);
            changed = true;
          }
          continue;
        }
        // Keep printable ASCII + common UTF-8 continuation bytes for
        // type-ahead replay. Drop the rest (arrow keys, function keys,
        // etc.) — those only mean something to an active input handler
        // and would render as garbage if pasted in.
        if (b >= 0x20) {
          typeAheadBuffer += String.fromCharCode(b);
          changed = true;
        }
      }
      // Echo the live buffer to the host (spinner composer row) so the
      // user sees what they're typing mid-turn, then submits with Enter.
      if (changed) opts.onTurnType?.(typeAheadBuffer);
    };
    process.stdin.on('data', pauseDataListener);
    return iface;
  };

  iface.resume = (): InkLineInterface => {
    if (!paused || closed) return iface;
    paused = false;
    if (pauseDataListener) {
      process.stdin.off('data', pauseDataListener);
      pauseDataListener = null;
    }
    // Drop committed items AND submitting flag on remount. Static
    // replay would otherwise duplicate every prior commit in
    // scrollback (each was already written during the prior mount);
    // submitting=true would hide the live frame on the fresh mount.
    store.resetForResume();
    // Seed the next mount with any type-ahead the user typed while
    // ink was paused. Empty in the common case. Programmatic path so
    // the cursor lands at the end of the seeded text — the next mount
    // is fresh anyway (ink remount initializes cursorOffset to
    // value.length) so the bump is belt-and-suspenders here, but
    // keeping all programmatic setValue paths consistent makes the
    // intent obvious to future readers.
    if (typeAheadBuffer.length > 0) {
      store.setValueProgrammatic(typeAheadBuffer);
      typeAheadBuffer = '';
    }
    instance = render(<App />, { exitOnCtrlC: false, stdout: inkStdout });
    // Turn-view: reinstall the host's stdout capture now that ink is back,
    // so the remainder of the turn keeps committing output to <Static>.
    if (store.getSnapshot().turnMode) opts.onResumeInTurn?.();
    return iface;
  };

  iface.isPaused = (): boolean => paused;

  iface.close = (): void => {
    if (closed) return;
    closed = true;
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    process.stdout.off('resize', onResize);
    instance?.unmount();
    instance = null;
    emitter.emit('close');
  };

  iface._refreshLine = (): void => {
    // Spinner-pause's repaint call. In ink the persistent frame is
    // re-rendered automatically on state change — nothing to do.
  };

  iface.setNarratorLines = (lines: string[]): void => {
    if (closed) return;
    // Forward to the store. Ink will re-render the narrator block in
    // place (or hide it when `lines` is empty). The store's own equality
    // check short-circuits unchanged snapshots so the 2s host tick
    // doesn't trigger a useless render at idle.
    store.setNarratorLines(lines);
  };

  // ---- turn-view surface ----

  iface.enterTurnMode = (cta?: string): void => {
    if (closed) return;
    // ink must be MOUNTED through the turn (the whole point). If a prior
    // sub-flow paused us, remount first so the turn view has a live tree.
    if (paused) iface.resume();
    // Fresh ephemeral state; the committed array (incl. the just-echoed
    // prompt) stays — it's real scrollback, append-only.
    store.clearTurnState();
    if (cta) store.setTurnCta(cta);
    store.setTurnMode(true);
    // handleSubmit set submitting=true to hide the idle frame; turn mode
    // renders the TurnView regardless, so this is belt-and-suspenders.
    store.setSubmitting(false);
  };

  iface.exitTurnMode = (): void => {
    if (closed) return;
    const snap = store.getSnapshot();
    // Persist a final plan snapshot to scrollback before the live tree is
    // cleared, so a turn's checklist stays visible in history (matching
    // the flag-off path, which commits the plan via spinner.note). Only
    // fires when this turn actually had a plan — turnPlan is reset to []
    // by enterTurnMode → clearTurnState at turn start, so a non-empty
    // turnPlan here means setTurnPlan ran this turn.
    if (snap.turnPlan.length > 0) {
      const done = snap.turnPlan.filter((t) => t.status === 'done').length;
      store.commitLine(c.dim(`  ${glyph.bullet} plan · ${done}/${snap.turnPlan.length} done`), true);
      // Inline row rendering (mirrors spinner.renderTodoTree's markers) so
      // we don't runtime-import spinner.ts. ✓ done · ▪ active · ☐ pending.
      for (const t of snap.turnPlan) {
        const text = t.content.replace(/\s+/g, ' ').trim();
        const row = t.status === 'done'
          ? `   ${c.green('✓')} ${c.dim(text)}`
          : t.status === 'in_progress'
            ? `   ${c.accent('▪')} ${text}`
            : `   ${c.dim('☐ ' + text)}`;
        store.commitLine(row, true);
      }
    }
    // Flush a half-streamed line so its content isn't lost when the live
    // region clears. Pre-colored → raw commit. (Usually already empty —
    // the host's removeTurnCapture flushes + clears turnStream first.)
    if (snap.turnStream.length > 0) store.commitLine(snap.turnStream, true);
    store.clearTurnState();
    store.setTurnMode(false);
    store.setSubmitting(false);
  };

  iface.isTurnMode = (): boolean => store.getSnapshot().turnMode;

  iface.commitTurnLine = (text: string): void => {
    if (closed) return;
    store.commitLine(text, true);
  };

  iface.setTurnPlan = (items: DockTodo[]): void => {
    if (closed) return;
    store.setTurnPlan(items);
  };

  iface.setTurnStatus = (text: string): void => {
    if (closed) return;
    store.setTurnStatus(text);
  };

  iface.setTurnStream = (text: string): void => {
    if (closed) return;
    store.setTurnStream(text);
  };

  iface.setTurnCta = (text: string): void => {
    if (closed) return;
    store.setTurnCta(text);
  };

  iface.setAwaitingLine = (awaiting: boolean): void => {
    if (closed) return;
    store.setAwaitingLine(awaiting);
  };

  return iface;
}
