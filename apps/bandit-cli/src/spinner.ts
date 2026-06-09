import { c, supportsTrueColor } from './ansi';

// "Shifty eyes" loader — a pair of pupils that dart left/right and blink,
// for a sneaky/masked Bandit vibe in just two cells (replaces the generic
// braille spinner). ◐ = glance left, ◑ = glance right, ⊖ = blink. Each
// gaze is held for several 80ms ticks so it reads as looking-around rather
// than jittering; the truecolor glow (glowGlyph) breathes on top. All
// frames are 2 cells wide so the status line never shifts.
const FRAMES = [
  '◐◐', '◐◐', '◐◐', '◐◐', // glance left (hold)
  '◑◑', '◑◑', '◑◑', '◑◑', // glance right (hold)
  '⊖⊖',                     // blink
  '◐◐', '◐◐', '◑◑', '◑◑'  // quick dart back
];

// Truecolor "breathing glow" for the spinner glyph. A terminal can't do a
// real glow (no blur/bloom), but smoothly fading a glyph's brightness in
// the brand accent reads exactly like one — the same trick a pulsing logo
// uses. Engages wherever the launch banner's truecolor block-art does
// (shared `supportsTrueColor()` — which deliberately trusts the env rather
// than gating on COLORTERM, since VS Code's terminal / tmux don't set it);
// otherwise the caller falls back to the 2-beat bold pulse, and to a plain
// glyph under NO_COLOR / non-TTY. Brightness is time-based (not frame-
// based) so the breathe stays smooth regardless of the 80ms render cadence.
const TRUECOLOR = supportsTrueColor();
// Bandit accent (cyan); the glyph breathes between ~45% and 100% of it.
const GLOW_RGB = { r: 96, g: 216, b: 255 };
const GLOW_PERIOD_MS = 1500;
function glowGlyph(glyph: string, nowMs: number): string {
  const phase = (nowMs % GLOW_PERIOD_MS) / GLOW_PERIOD_MS;
  const wave = 0.5 + 0.5 * Math.sin(phase * 2 * Math.PI); // 0..1
  const k = 0.45 + 0.55 * wave; // 0.45..1.0 brightness
  const r = Math.round(GLOW_RGB.r * k);
  const g = Math.round(GLOW_RGB.g * k);
  const b = Math.round(GLOW_RGB.b * k);
  return `\x1b[38;2;${r};${g};${b}m${glyph}\x1b[39m`;
}

/** One row of the live plan dock. Mirrors host-kit's TodoItem minus the
 *  id — the spinner only needs status + text to paint the tree. */
export interface DockTodo {
  status: 'pending' | 'in_progress' | 'done';
  content: string;
}

// How many plan items to show before collapsing the rest into a
// "… +N pending, M done" summary line. Keeps the dock from eating the
// whole screen on a 20-item plan while still surfacing the active work.
const DOCK_MAX_VISIBLE = 6;

/**
 * Render a styled checklist for the live dock. Returns one terminal row
 * per string (already truncated to `width` so the multi-line in-place
 * repaint's row math never breaks on a wrap). Empty input → no rows.
 *
 *   ✓ done item        (green check, dim text)
 *   ▪ active item      (bold accent marker + bold text)
 *   ☐ pending item     (dim box, dim text)
 *   … +3 pending, 1 done   (collapse line when over DOCK_MAX_VISIBLE)
 *
 * Visible-width truncation is computed on the PLAIN text before any color
 * codes are applied, so SGR sequences never count toward the column
 * budget and never get sliced mid-escape.
 */
export function renderTodoTree(items: DockTodo[], width: number): string[] {
  if (!items.length) return [];
  const indent = '   ';
  // marker (1) + space (1) + indent (3) = 5 cols of chrome per row.
  const textBudget = Math.max(8, width - indent.length - 2);
  const truncate = (s: string): string =>
    s.length > textBudget ? s.slice(0, textBudget - 1) + '…' : s;

  const rowFor = (t: DockTodo): string => {
    const text = truncate(t.content.replace(/\s+/g, ' ').trim());
    if (t.status === 'done') return `${indent}${c.green('✓')} ${c.dim(text)}`;
    if (t.status === 'in_progress') return `${indent}\x1b[1m${c.accent('▪')} ${c.accent(text)}\x1b[22m`;
    return `${indent}${c.dim('☐')} ${c.dim(text)}`;
  };

  const shown = items.slice(0, DOCK_MAX_VISIBLE);
  const lines = shown.map(rowFor);
  if (items.length > DOCK_MAX_VISIBLE) {
    const rest = items.slice(DOCK_MAX_VISIBLE);
    const pending = rest.filter((t) => t.status === 'pending').length;
    const active = rest.filter((t) => t.status === 'in_progress').length;
    const done = rest.filter((t) => t.status === 'done').length;
    const bits = [
      pending ? `${pending} pending` : null,
      active ? `${active} in progress` : null,
      done ? `${done} done` : null
    ].filter(Boolean);
    lines.push(`${indent}${c.dim('… +' + bits.join(', '))}`);
  }
  return lines;
}

// Rotating phrases shown while the model thinks. Cheeky / casual,
// short enough to read in a glance, deliberately not the
// gerund-vocabulary other agents use. Updated 2026-04-30 per user
// ask: "fewer 'pondering / spicing'-isms, more 'I'm so on this' /
// 'don't threaten me with a good time' energy."
const THINKING_VERBS = [
  "working on it",
  "I'm so on this",
  "don't threaten me with a good time",
  "rolling up my sleeves",
  "say less",
  "on it like a bonnet",
  "warming up the engines",
  "let me cook",
  "loading the brain cells",
  "give me a sec",
  "doing the thing",
  "rummaging through the codebase",
  "putting it together",
  "thinking thoughts",
  "wrenching on it",
  "all hands on deck",
  "in the zone",
  "deep in the weeds",
  "consulting the rubber duck",
  "getting the gang together",
  "untangling the spaghetti",
  "calculating the vibes",
  "reading the room",
  "spinning up the brain",
  "channeling my inner Linus",
  "checking the oracle",
  "reticulating splines",
  "asking the elder gods",
  "doing my best",
  "mid-yeet",
  "summoning the daemons",
  "buffering thoughts",
  "polishing the prose",
  "putting on the chef hat",
  "almost there",
  "this is fine",
  "Bandit at work",
  "loading…trust me",
  "convening the council",
  "diving in",
  "sharpening the axe",
  "popping the hood",
  "stirring the pot",
  "consulting the docs",
  "tracing the call graph",
  "decoding the matrix",
  "trust the process",
  "no thoughts, just code",
  "vibes are immaculate",
  "this one's for the timeline",
  "lock in",
  "we ball",
  "absolutely cooking",
  "they don't pay me enough for this",
  "they pay me too much for this",
  "she's compiling, sir",
  "do not perceive me",
  "I have done a tiny crime",
  "manifesting clean output",
  "writing checks my context can cash",
  "negotiating with the parser",
  "bullying the type system",
  "feeding the linter",
  "appeasing the gods of CI",
  "rebooting my will to live",
  "running on hopes and caffeine",
  "hold my keystrokes",
  "I read the README this time",
  "I did not read the README",
  "speedrunning best practices",
  "speedrunning worst practices",
  "this will work or be deeply funny",
  "Stack Overflow is a friend, actually",
  "found the off-by-one",
  "found another off-by-one",
  "I'll just refactor real quick",
  "narrator: it was not real quick",
  "yeeting the YAML",
  "wrestling regex",
  "fluent in stack traces",
  "don't @ me",
  "don't @ me, I'm thinking",
  "Bandit's brain go brrr",
  "in my final form",
  "approaching critical mass",
  "let him cook",
  "in there like swimwear",
  "send tweet",
  "I do this for fun, sometimes",
  "the duck and I are talking",
  "the duck has notes",
  "we're gonna make it (probably)",
  "calibrating the snark",
  "queueing up a hot take",
  "shipping is a feature",
  "vibe-checking the diff",
  "going through it",
  "you good? I'm good",
  "smol model big dreams",
  "do not interrupt the bit",
  "writing love letters to the compiler",
  "asking for forgiveness, not permission",
  "filing a Linear ticket against reality",
  "reading minds (yours, the model's, mine)"
];

export class Spinner {
  private handle: NodeJS.Timeout | null = null;
  private verbHandle: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = '';
  private startedAt = 0;
  // Running token estimate for the current turn. Set via setTokens —
  // cli.ts accumulates chars across llm_chunk events and divides by
  // 4 for a GPT-style rough count. Shown next to elapsed-seconds in
  // the spinner label so the user sees progress between iterations
  // without having to wait for the next tool card.
  private tokens = 0;
  // Timestamp of the first non-zero token reading for the current turn.
  // Used to compute tok/s against a TURN-level clock rather than the
  // per-iteration spinner clock — without this, restarting the spinner
  // between tool calls reset the divisor and the displayed rate jumped
  // UP at each boundary even though no new tokens had arrived (same
  // cumulative numerator, smaller denominator). Tracking the first-
  // token timestamp gives a stable cumulative tok/s that matches what
  // the user actually observes streaming. Reset to 0 by setTokens(0)
  // so a fresh turn starts a fresh clock.
  private firstTokenAt = 0;
  // Active-streaming clock for the LIVE tok/s rate. Accumulates only the
  // time during which tokens are actually flowing — the gap between two
  // token increases, counted only when it's short enough (≤2s) to be a
  // continuous stream. Tool calls, thinking pauses, first-token latency,
  // and network waits show up as longer gaps and are excluded. Without
  // this the live rate divided cumulative tokens by total wall-clock
  // (incl. all those idle stretches) and read ~2 tok/s while the
  // post-stream summary — which clocks only the content window — showed
  // a truthful ~300. This makes the live number track real generation
  // speed. Reset with the turn via setTokens(0).
  private streamActiveMs = 0;
  private lastTokenStamp = 0;
  // pauseUntil: while Date.now() < pauseUntil, the 80ms render tick
  // is a no-op and the cursor stays visible. Used by the REPL keypress
  // hook so the user can SEE characters they type during an in-flight
  // turn — without this, the spinner clears the prompt line ~12×/sec
  // and any typed character is wiped before the eye can catch it,
  // which is why follow-ups felt impossible to submit.
  private pauseUntil = 0;
  private paused = false;
  // Mid-turn composer buffer. When the user types while a turn is in
  // flight (ink path, raw-stdin capture), the keystrokes land here and
  // render as a `❯ …` line at the bottom of the dock so typing is
  // visible and submittable — restoring the readline path's
  // type-while-working behavior. Empty = no composer row.
  private composer = '';
  // Terminal rows the dock occupied on its last paint. Drives the
  // cursor-up count for the next in-place repaint and the full-block
  // clear on stop()/pauseFor(). 0 = nothing painted yet.
  private dockRows = 0;
  // Turn-view sink. When set (BANDIT_TURN_VIEW), the spinner stops
  // writing its status/dock to stdout entirely and instead hands the
  // composed status line to this callback — which routes it into ink's
  // live turn region (setTurnStatus). This is the fix for the v1.7.316
  // lesson: a mounted ink frame can't coexist with the spinner's
  // in-place `\r\x1b[…A\x1b[0J` repaints, so in turn mode the spinner
  // produces only a string and never touches the terminal. The composer
  // and plan tree are owned by the TurnView, so setComposer/pauseFor/
  // note all no-op while a sink is attached.
  private sink: ((status: string) => void) | null = null;

  /** Attach (or detach with null) the turn-view status sink. While set,
   *  the spinner emits its status line to the sink instead of stdout and
   *  performs no cursor/dock writes. */
  setSink(fn: ((status: string) => void) | null): void {
    this.sink = fn;
  }

  /** Set the mid-turn composer text shown at the bottom of the dock.
   *  Empty string hides the composer row. Repaints immediately when the
   *  spinner is running so typed echo feels responsive instead of
   *  waiting for the next 80ms tick. */
  setComposer(text: string): void {
    if (this.sink) return; // TurnView owns the composer in turn mode.
    this.composer = text;
    if (this.handle && !this.paused) this.render(this.verbHandle !== null);
  }

  start(label: string): void {
    this.stop();
    this.label = label;
    this.startedAt = Date.now();
    if (this.sink) {
      // Sink mode: drive the animation timer (so the glow still breathes)
      // but emit to the sink instead of stdout. No TTY/cursor handling —
      // ink owns the terminal.
      this.handle = setInterval(() => this.render(), 80);
      return;
    }
    if (!process.stdout.isTTY) {
      process.stdout.write(c.dim(`${label}…\n`));
      return;
    }
    hideCursor();
    this.handle = setInterval(() => this.render(), 80);
  }

  /**
   * Start a thinking spinner that cycles through playful verbs every ~2.5s.
   * Use this for "model is busy" states where there's no concrete sub-step
   * to report. Falls back to a single status line on non-TTY stdout.
   */
  startThinking(): void {
    this.stop();
    const pick = () => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    this.label = pick();
    this.startedAt = Date.now();
    if (this.sink) {
      this.handle = setInterval(() => this.render(true), 80);
      this.verbHandle = setInterval(() => {
        let next = pick();
        if (next === this.label && THINKING_VERBS.length > 1) {
          next = THINKING_VERBS[(THINKING_VERBS.indexOf(this.label) + 1) % THINKING_VERBS.length];
        }
        this.label = next;
      }, 2500);
      return;
    }
    if (!process.stdout.isTTY) {
      process.stdout.write(c.dim(`${this.label}…\n`));
      return;
    }
    hideCursor();
    this.handle = setInterval(() => this.render(true), 80);
    this.verbHandle = setInterval(() => {
      let next = pick();
      if (next === this.label && THINKING_VERBS.length > 1) {
        next = THINKING_VERBS[(THINKING_VERBS.indexOf(this.label) + 1) % THINKING_VERBS.length];
      }
      this.label = next;
    }, 2500);
  }

  update(label: string): void {
    this.label = label;
  }

  /**
   * Set the running token estimate shown in the spinner suffix.
   * Called by the CLI as `llm_chunk` events arrive. Values ≤0
   * clear the counter (used between turns to reset to a clean line).
   */
  setTokens(tokens: number): void {
    const next = Math.max(0, Math.floor(tokens));
    if (next === 0) {
      // Reset between turns — caller flips to 0 at turn end.
      this.firstTokenAt = 0;
      this.streamActiveMs = 0;
      this.lastTokenStamp = 0;
    } else {
      const now = Date.now();
      if (this.firstTokenAt === 0) this.firstTokenAt = now;
      if (next > this.tokens) {
        // Add the gap since the last increase to the active-streaming
        // clock, but only when it's a continuous stream (≤2s). Longer
        // gaps are tool calls / thinking / network waits where no tokens
        // flow — excluding them is what keeps the live rate honest.
        if (this.lastTokenStamp > 0) {
          const gap = now - this.lastTokenStamp;
          if (gap <= 2000) this.streamActiveMs += gap;
        }
        this.lastTokenStamp = now;
      }
    }
    this.tokens = next;
  }

  /**
   * Suspend rendering for `ms` and surface the cursor so the user can
   * see what they're typing. Called from the REPL keypress hook on every
   * keystroke during an active turn. Repeated calls extend (don't reset)
   * the pause window so a steady stream of typing keeps the cursor
   * visible without racing against the spinner. Auto-resumes once the
   * window elapses; the next 80ms tick re-hides the cursor and resumes
   * the animation. No-op on non-TTY (matches `start()`/`startThinking()`).
   */
  pauseFor(ms: number): void {
    if (this.sink) return; // TurnView composer owns the cursor in turn mode.
    if (!process.stdout.isTTY) return;
    if (!this.handle) return;  // spinner not running — nothing to pause
    const next = Date.now() + ms;
    if (next > this.pauseUntil) this.pauseUntil = next;
    if (!this.paused) {
      this.paused = true;
      // Clear our last frame (including any multi-line dock) so leftover
      // spinner chars don't sit on the line under the user's typing.
      // Readline will repaint its prompt + buffer on the next keystroke
      // (or already has).
      this.clearDock();
      showCursor();
    }
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
    if (this.verbHandle) {
      clearInterval(this.verbHandle);
      this.verbHandle = null;
    }
    if (this.sink) {
      // Clear the live status region; ink handles the rest. No stdout.
      this.sink('');
      return;
    }
    if (process.stdout.isTTY) {
      // Clear the whole dock (status line + any plan/composer rows),
      // then show the cursor again. clearDock falls back to a plain
      // single-line clear when nothing multi-line was painted.
      this.clearDock();
      showCursor();
    }
  }

  private render(ellipsis = false): void {
    // honor the pauseFor() window. Without this gate, the
    // 80ms timer kept firing through the pause and the spinner repaint
    // immediately wiped any character the user had typed at the prompt
    // — `pauseFor()` was effectively a no-op except for its first
    // one-time line clear. Real user
    // typed "did you run it?" mid-turn, the prompt appeared to accept
    // it (it queued), but subsequent attempts to type more felt
    // blocked because the spinner kept eating the partial buffer.
    if (this.paused) {
      if (Date.now() < this.pauseUntil) {
        // Still inside the pause window — skip the repaint entirely so
        // the user's typing buffer (which readline has painted to the
        // same line) survives.
        return;
      }
      // Window elapsed — fall through to a normal render. Re-hide the
      // cursor first (pauseFor showed it), and let the existing
      // clear-line + paint logic below sweep readline's stale input.
      this.paused = false;
      hideCursor();
    }
    // Clear the entire line first so shorter labels don't leave trailing
    // characters from longer ones (e.g. "wiring" after "calibrating" used
    // to show "wiringting"). Then paint the new frame.
    //
    // Elapsed-seconds suffix kicks in after 3s so quick turns stay clean
    // and only long operations get the "am I hung?" signal. Formatted as
    // integer seconds up to 60s, then Xm Ys. No decimals — the animated
    // frame is what shows the process is alive; the number just tells
    // the user how much of their life they've spent waiting.
    const elapsedMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    let elapsedSuffix = '';
    if (elapsedMs >= 3000) {
      const secs = Math.floor(elapsedMs / 1000);
      elapsedSuffix = secs >= 60
        ? `  ·  ${Math.floor(secs / 60)}m${secs % 60}s`
        : `  ·  ${secs}s`;
    }
    // Token counter + live rate. Counter shows up once we have enough
    // streamed text to be meaningful (>= 100 tokens skips the noisy
    // first half-second). Rate (tok/s) kicks in once we have ≥ 3s of
    // elapsed time so the divisor is statistically reasonable — a
    // glance at "145 tok/s" tells you the model is moving at speed;
    // "20 tok/s" tells you it's chugging. Compact format: `1.2K tok @
    // 145 tok/s` instead of the older `~1.2K tokens` (no rate).
    let tokenSuffix = '';
    if (this.tokens >= 100) {
      const count = this.tokens >= 1000
        ? `${(this.tokens / 1000).toFixed(1)}K`
        : `${this.tokens}`;
      let rate = '';
      // Rate over ACTIVE streaming time only (see streamActiveMs) — the
      // wall-clock with tool calls, thinking pauses, and first-token
      // latency subtracted out. Dividing cumulative tokens by total
      // turn-elapsed (the prior approach) dragged the live number to
      // ~2 tok/s on tool/thinking-heavy turns while the post-stream
      // summary showed a truthful ~300; this tracks the real generation
      // speed live. Needs ≥1.5s of active streaming so the divisor is
      // statistically sane before we show a number.
      if (this.streamActiveMs >= 1500) {
        const tokPerSec = Math.round(this.tokens / (this.streamActiveMs / 1000));
        rate = ` @ ${tokPerSec} tok/s`;
      }
      tokenSuffix = `  ·  ${count} tok${rate}`;
    }
    // Subtle "breathing" effect on the spinner frame: every 3rd frame
    // renders bold, the rest plain accent. That gives a gentle two-
    // beat pulse on top of the 10-frame braille rotation without
    // depending on truecolor or hardcoding RGB (so it still looks
    // right under any theme + on terminals without 24-bit color).
    // SGR 1 turns bold on; SGR 22 (normal intensity) turns it off
    // without resetting other attributes. Wrapping happens AROUND
    // c.accent() so the theme's color codes don't get clobbered.
    const glyph = FRAMES[this.frame];
    // Truecolor terminals get the smooth brightness breathe (glow); others
    // keep the original 2-beat bold pulse so it still feels alive without
    // 24-bit color, and NO_COLOR/non-TTY fall through to a plain glyph.
    const framePainted = TRUECOLOR
      ? glowGlyph(glyph, Date.now())
      : (this.frame % 3 === 0
        ? `\x1b[1m${c.accent(glyph)}\x1b[22m`
        : c.accent(glyph));
    const statusLine =
      framePainted + ' ' +
      c.dim(this.label + (ellipsis ? '…' : '') + elapsedSuffix + tokenSuffix);
    if (this.sink) {
      // Turn mode: emit the composed line into ink's live region. No
      // cursor math, no in-place repaint — ink reconciles it.
      this.sink(statusLine);
    } else {
      this.paintDock(statusLine);
    }
    this.frame = (this.frame + 1) % FRAMES.length;
  }

  /**
   * Paint the live dock in place: an optional mid-turn composer row
   * (what the user is typing while a turn runs) above the status line
   * where the cursor rests. Repaints by moving the cursor up over the
   * previous block and clearing to end-of-screen, so it updates without
   * scrolling. With no composer this collapses to the single status line
   * the spinner has always drawn — the common case. (The plan checklist
   * is committed to scrollback by the CLI, not painted here, so it
   * persists instead of vanishing when the dock clears.)
   */
  private paintDock(statusLine: string): void {
    const cols = process.stdout.columns || 80;
    const lines: string[] = [];
    if (this.composer.length > 0) {
      // Truncate the composer to one row so a long typed line can't wrap
      // and desync the dock's row count. Show the tail (most recent
      // typing) with a leading ellipsis when it overflows.
      const budget = Math.max(8, cols - 4);
      const shown = this.composer.length > budget
        ? '…' + this.composer.slice(this.composer.length - budget + 1)
        : this.composer;
      lines.push(c.accent('❯ ') + shown + c.dim('▏'));
    }
    lines.push(statusLine);

    // Move to the top of the previously-painted block, clear everything
    // from there down, then write the fresh block. `\x1b[0J` clears
    // cursor-to-end-of-screen; the dock is always the bottom-most output
    // (callers stop() the spinner before printing anything else), so it
    // never erases real scrollback.
    let prefix = '\r';
    if (this.dockRows > 1) prefix += `\x1b[${this.dockRows - 1}A`;
    prefix += '\x1b[0J';
    process.stdout.write(prefix + lines.join('\n'));
    this.dockRows = lines.length;
  }

  /**
   * Commit a one-off line to scrollback ABOVE the live dock without
   * stopping the spinner — e.g. a "✓ queued" confirmation when the user
   * submits a message mid-turn. Erases the current dock, writes the
   * note, and leaves the next 80ms tick to repaint the dock below it.
   */
  note(text: string): void {
    // Turn mode: the host commits scrollback through ink's commitTurnLine
    // (and the plan via setTurnPlan), so the spinner never writes notes.
    if (this.sink) return;
    if (!process.stdout.isTTY) {
      process.stdout.write(text + '\n');
      return;
    }
    this.clearDock();
    process.stdout.write(text + '\n');
  }

  /** Erase the whole dock and reset the row counter. Used by stop() and
   *  pauseFor() so leftover dock rows don't strand above the next write. */
  private clearDock(): void {
    if (this.dockRows === 0) {
      process.stdout.write('\r\x1b[2K');
      return;
    }
    let seq = '\r';
    if (this.dockRows > 1) seq += `\x1b[${this.dockRows - 1}A`;
    seq += '\x1b[0J';
    process.stdout.write(seq);
    this.dockRows = 0;
  }
}

/**
 * Bracket a streaming turn with a visible header and a final summary
 * line instead of trying to render a live status bar that tracks the
 * moving cursor.
 *
 * start() → prints a dim "⚡ streaming…" banner on its own line ABOVE
 * the response. Cursor advances to the next line where the
 * stream will begin writing.
 * stop() → prints a single "→ ~N tokens · Ns" summary line AFTER the
 * response completes, so the user has both a start anchor
 * and an end total.
 * setTokens() → cheap no-I/O counter update; summary reads it at stop().
 *
 * Why not a live-updating status line: an earlier version rendered the
 * counter one line below the cursor on a 400ms timer using save/restore
 * cursor, but "below" is where the stream was about to scroll — users
 * saw the counter bounce into weird positions, sometimes rendering
 * AFTER the response text. This bracketing pattern never moves the
 * cursor, so it lands predictably in scrollback.
 */
export class StreamFooter {
  private startedAt = 0;
  private tokens = 0;
  private active = false;

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.tokens = 0;
    // No visible banner at stream start — the response itself is the
    // anchor, and a static "⚡ streaming…" line above it just added
    // noise that never changed. The end-of-stream summary below
    // (→ ~N tokens · Ns) is the useful artifact; this method now
    // just records start state so stop() can compute elapsed.
  }

  setTokens(tokens: number): void {
    this.tokens = Math.max(0, Math.floor(tokens));
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.tokens < 50 && !process.stdout.isTTY) return;
    const elapsedMs = Date.now() - this.startedAt;
    const secs = Math.floor(elapsedMs / 1000);
    const elapsedLabel = secs >= 60
      ? `${Math.floor(secs / 60)}m${secs % 60}s`
      : `${secs}s`;
    const tokenCount = this.tokens >= 1000
      ? `${(this.tokens / 1000).toFixed(1)}K`
      : `${this.tokens}`;
    // Match the live-spinner suffix shape (`1.2K tok @ 145 tok/s · 7s`)
    // so the at-a-glance summary the user sees while streaming and the
    // recap line printed at the end share the same vocabulary.
    let rate = '';
    if (elapsedMs >= 1500 && this.tokens > 0) {
      const tokPerSec = Math.round(this.tokens / (elapsedMs / 1000));
      rate = ` @ ${tokPerSec} tok/s`;
    }
    if (this.tokens >= 50) {
      process.stdout.write(
        '\n' + c.dim(`  ${c.accent('→')} ${tokenCount} tok${rate}  ·  ${elapsedLabel}`) + '\n'
      );
    }
  }
}

// Cursor hide/show are ref-counted so nested spinners don't flicker.
let cursorHidden = 0;
function hideCursor(): void {
  if (!process.stdout.isTTY) return;
  if (cursorHidden === 0) process.stdout.write('\x1b[?25l');
  cursorHidden++;
}
function showCursor(): void {
  if (!process.stdout.isTTY) return;
  if (cursorHidden > 0) cursorHidden--;
  if (cursorHidden === 0) process.stdout.write('\x1b[?25h');
}

// Always restore the cursor on process exit / signal — a crashed CLI should
// never leave the user's terminal with an invisible cursor.
process.on('exit', () => { if (cursorHidden > 0 && process.stdout.isTTY) process.stdout.write('\x1b[?25h'); });
process.on('SIGINT', () => { if (process.stdout.isTTY) process.stdout.write('\x1b[?25h'); process.exit(130); });
