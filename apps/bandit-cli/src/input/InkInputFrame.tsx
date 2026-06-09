/**
 * Persistent input frame for the Bandit CLI — the ink replacement for
 * the readline + ANSI cursor-dance footer in cli.ts. The frame survives
 * the failure modes the v1.7.306 ANSI variant cannot:
 *
 *   - typed/pasted input that wraps to multiple visual rows
 *   - window resize between prompt and submit
 *   - multi-line paste from the system clipboard
 *
 * Render shape (matches Claude Code's input look — single rounded box,
 * tiny dim hint underneath, no per-frame divider sandwich):
 *
 *   [conditional `?` shortcuts overlay above]
 *   [conditional `!` shell-mode banner above]
 *   [conditional `@` file-suggestion overlay above]
 *   ╭──────────────────────────────────────────────╮
 *   │ ❯ <buffer with cursor>                        │
 *   ╰──────────────────────────────────────────────╯
 *     ? for shortcuts
 *
 * ink composes the persistent block at the bottom of the terminal;
 * anything cli.ts writes to stdout (tool calls, diff renders, etc.)
 * scrolls into the area above the frame.
 */

import * as React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';

export interface InkInputFrameProps {
  /** Current buffer contents. The adapter owns this state so the
   *  outer cli.ts code can still read/write `rl.line` synchronously. */
  value: string;
  /** Visual prompt prefix. The adapter sets this via setPrompt(). */
  promptText: string;
  /** Footer tip line (right-aligned, dim). */
  footerTip: string;
  /** Called on every keystroke that changes the buffer. */
  onChange: (next: string) => void;
  /** Like onChange but for PROGRAMMATIC buffer replacements (accepting an
   *  @-mention via Tab/Enter) — the host routes this through the
   *  cursor-bumping path so the visible cursor jumps to the END of the
   *  inserted text instead of being stranded mid-line. Falls back to
   *  onChange when not provided. */
  onAccept?: (next: string) => void;
  /** Called when the user presses Enter. The adapter emits `line`. */
  onSubmit: (value: string) => void;
  /** Called on Esc — cli.ts wires this to the active turn's AbortController. */
  onEscape?: () => void;
  /** Called when the user presses Ctrl+V (clipboard image capture).
   *  `beforeValue` is the buffer contents as seen by THIS handler —
   *  i.e. props.value, which lags one render behind the store. That
   *  matters because ink-text-input's useInput subscribes to the same
   *  input event and runs BEFORE us (React child-first effect order),
   *  so by the time we fire it has already inserted a literal 'v' into
   *  the store. Passing the pre-event props.value gives the host an
   *  honest "this is what was there before the keystroke" baseline so
   *  it can strip the spurious 'v' without false positives. */
  onCtrlV?: (beforeValue: string) => void;
  /** Called on any keystroke (so the spinner can pause). */
  onActivity?: () => void;
  /** Called when the user presses Up/Down for history navigation. */
  onHistoryPrev?: () => void;
  onHistoryNext?: () => void;
  /** Fuzzy-search workspace files for the @ suggestion overlay.
   *  When omitted, typing `@` just inserts the literal character. */
  searchFiles?: (query: string) => string[];
  /** Slash-command + path completer matching readline's shape:
   *  `(line) => [hits, substring]`. Called on Tab when the buffer
   *  is NOT in @-mention mode — completes /slash names, file paths
   *  inside argv, etc. Single hit auto-completes; multiple hits
   *  print a list above the prompt.  */
  completer?: (line: string) => [string[], string];
  /** Bumps when the buffer value is set programmatically (paste,
   *  history recall, type-ahead seed on resume). Used as the TextInput's
   *  React key so a fresh mount initializes `cursorOffset = value.length`
   *  — moving the visible cursor to the end of the just-inserted text.
   *  ink-text-input's `useEffect` only repositions the cursor when the
   *  new value SHRINKS past the old offset; it doesn't move forward
   *  to follow programmatic inserts, which is what stranded the cursor
   *  at column 0 after a clipboard image paste. */
  cursorBumpKey?: number;
}

const SHORTCUT_ROWS: Array<[string, string, string, string, string, string]> = [
  ['?',     'show this menu',   'Esc',    'stop agent',    '/help',     'full command list'],
  ['/',     'slash commands',   'Ctrl+V', 'paste image',   '/doctor',   'setup check'],
  ['@',     'pin a file',       'Ctrl+C', 'cancel turn',   '/login',    'save cloud API key'],
  ['↑ / ↓', 'history',          'Ctrl+D', 'exit',          '/provider', 'switch ollama/bandit'],
  ['',      '',                 'Enter',  'submit',        '/model',    'switch model'],
  ['',      '',                 '',       '',              '/tasks',    'background subagents'],
  ['',      '',                 '',       '',              '/rewind',   'undo agent edit'],
  ['',      '',                 '',       '',              '/clear',    'reset chat']
];

function ShortcutsOverlay(): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {SHORTCUT_ROWS.map((row, i) => (
        <Box key={i}>
          <Box width={8}><Text color="cyan">{row[0]}</Text></Box>
          <Box width={17}><Text dimColor>{row[1]}</Text></Box>
          <Box width={10}><Text color="cyan">{row[2]}</Text></Box>
          <Box width={14}><Text dimColor>{row[3]}</Text></Box>
          <Box width={10}><Text color="cyan">{row[4]}</Text></Box>
          <Box><Text dimColor>{row[5]}</Text></Box>
        </Box>
      ))}
    </Box>
  );
}

const AT_MENTION_MAX = 8;

function AtMentionOverlay({
  results,
  selectedIdx
}: { results: string[]; selectedIdx: number }): React.JSX.Element {
  const total = results.length;
  // Scroll the visible window so the highlighted item stays on screen —
  // the list used to show a fixed first-8 slice, so arrowing past item 8
  // moved the selection off-screen ("doesn't scroll down"). Keep the
  // selection roughly centered, clamped to the list bounds.
  const start = total > AT_MENTION_MAX
    ? Math.max(0, Math.min(selectedIdx - Math.floor(AT_MENTION_MAX / 2), total - AT_MENTION_MAX))
    : 0;
  const visible = results.slice(start, start + AT_MENTION_MAX);
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text dimColor>Tab descends into dirs  ·  Enter inserts  ·  ↑ ↓ navigate  ·  Esc dismiss</Text>
      {total === 0 ? (
        <Text dimColor>  (no matches)</Text>
      ) : (
        visible.map((path, j) => {
          const i = start + j;
          return (
            <Text key={path} color={i === selectedIdx ? 'cyan' : undefined}>
              {i === selectedIdx ? '▸ ' : '  '}
              {path}
            </Text>
          );
        })
      )}
      {total > AT_MENTION_MAX && (
        <Text dimColor>  {start + 1}–{Math.min(start + AT_MENTION_MAX, total)} of {total}  ·  ↑↓ for more</Text>
      )}
    </Box>
  );
}

/**
 * Extract the trailing `@<chars>` token from the buffer for file-mention
 * matching. Returns the query when the token starts at column 0 or after
 * whitespace; null when the `@` is mid-word (e.g. an email address) so
 * the overlay doesn't pop on `foo@bar.com`.
 */
function extractAtToken(value: string): string | null {
  const m = value.match(/(^|\s)@([^\s@]*)$/);
  return m ? m[2] : null;
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length && prefix.length > 0; i += 1) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return '';
    }
  }
  return prefix;
}

export function InkInputFrame(props: InkInputFrameProps): React.JSX.Element {
  const { stdout } = useStdout();
  const [atResults, setAtResults] = React.useState<string[]>([]);
  const [atSelectedIdx, setAtSelectedIdx] = React.useState(0);

  // Cap the frame ONE column short of the terminal width. A rounded-border
  // Box that spans the full width lands its right border on the terminal's
  // last column; with auto-wrap (DECAWM) on, that printable char at the last
  // column sets the deferred-wrap flag and the composer sprouts a phantom
  // line on the right — and ink then mis-erases the height change, stranding
  // a duplicate prompt. Leaving the last column blank avoids the wrap. The
  // resize effect below forces a re-render so this re-derives on width change.
  const cols = stdout?.columns ?? 80;
  const frameWidth = Math.max(20, cols - 1);

  // We no longer drive the rendered width off `cols` — the rounded-border
  // Box stretches to the parent (the full terminal width via the ink root)
  // automatically. Subscribing to resize is still useful because some
  // consumers want re-render on width change, but the layout no longer
  // hand-computes padding / divider widths.
  React.useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      // Force a re-render by touching state.
      setAtResults((prev) => prev.slice());
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Drive the @-mention overlay off the buffer itself. Whenever the
  // trailing `@<chars>` token changes, re-run the search and reset the
  // selection cursor. When the token disappears (Enter, space, backspace
  // past the `@`, Esc), the overlay closes implicitly because atResults
  // collapses to []. Pulling this off the value rather than dedicated
  // open/close events avoids the readline path's race between keypress
  // and rl.line mutation.
  const atToken = extractAtToken(props.value);
  const atActive = atToken !== null && props.searchFiles !== undefined;

  React.useEffect(() => {
    if (atToken === null || !props.searchFiles) {
      setAtResults([]);
      setAtSelectedIdx(0);
      return;
    }
    const hits = props.searchFiles(atToken);
    setAtResults(hits);
    setAtSelectedIdx(0);
  }, [atToken, props.searchFiles]);

  const showShortcuts = props.value === '?';
  const showBang = props.value.startsWith('!') && !showShortcuts;

  /**
   * Accept the currently-selected @-mention entry.
   *
   * `mode: 'finalize'` (Enter) — inserts the path followed by a space so
   * the overlay closes and the user can keep typing the rest of the
   * prompt without re-triggering on the next character.
   *
   * `mode: 'descend'` (Tab) — directory entries (those that end with `/`)
   * are inserted WITHOUT a trailing space so the overlay stays open and
   * the next character extends the query into that directory. Files
   * accepted via Tab behave like Enter — there's nothing to descend into.
   */
  const acceptAtMention = React.useCallback((mode: 'finalize' | 'descend'): void => {
    if (!atActive || atResults.length === 0) return;
    const picked = atResults[atSelectedIdx] ?? atResults[0];
    if (!picked) return;
    const stripped = props.value.replace(/@[^\s@]*$/, '');
    const isDir = picked.endsWith('/');
    const trailing = (mode === 'descend' && isDir) ? '' : ' ';
    // Programmatic replacement → route through onAccept so the cursor
    // jumps to the end of the inserted path (Tab/Enter on a mention).
    (props.onAccept ?? props.onChange)(`${stripped}@${picked}${trailing}`);
  }, [atActive, atResults, atSelectedIdx, props]);

  // We used to keep a `ctrlVSuppressRef` ref here to drop the 'v' that
  // ink-text-input synchronously inserts when Ctrl+V fires. That never
  // worked: TextInput's useInput subscribes to ink's input event in a
  // child-mount effect, so its handler runs BEFORE InkInputFrame's
  // useInput — by the time we could set the suppression flag, the 'v'
  // was already through. We rely now on the host's post-paste strip,
  // which uses the pre-event `props.value` we pass to onCtrlV (see
  // below) as its baseline — that's the buffer as of the last render,
  // before TextInput's 'v' injection committed.
  const handleChange = React.useCallback((next: string): void => {
    props.onChange(next);
  }, [props]);

  // TextInput stays focused at all times so backspace, typing, and
  // cursor movement always work. useInput here ONLY intercepts the
  // overlay/control keys (Esc, Up/Down, Tab, Ctrl+V); other keys fall
  // through to TextInput. Enter is NOT intercepted by useInput when
  // the overlay is active — handleTextInputSubmit below wraps
  // TextInput's onSubmit and finalizes the @-selection there, so we
  // never have two handlers fighting for the same Enter event.
  useInput((input, key) => {
    props.onActivity?.();
    if (atActive) {
      if (key.escape) {
        // Dismiss the overlay without losing the typed `@query`.
        // Clearing atResults hides the overlay until the next
        // keystroke re-runs the search.
        setAtResults([]);
        return;
      }
      if (key.upArrow) {
        setAtSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAtSelectedIdx((i) => Math.min(Math.max(0, atResults.length - 1), i + 1));
        return;
      }
      if (key.tab) {
        // Tab descends: directory entries are inserted without a
        // trailing space so the next keystroke extends the search
        // into that directory (e.g. @apps/ → @apps/bandit-cli/).
        acceptAtMention('descend');
        return;
      }
      // Any other keystroke (letters, backspace, ctrl+anything) passes
      // through to TextInput unchanged. Backspace there removes a
      // character from the buffer, the @-token shrinks, and the
      // overlay search re-runs against the smaller query — letting
      // the user edit the query without leaving the overlay.
      if (key.ctrl && input === 'v') {
        // Pass props.value (the pre-event render snapshot) so the host
        // can strip the 'v' that ink-text-input is about to inject —
        // see the onCtrlV prop doc and the long comment by handleChange
        // for why we can't suppress earlier in the event chain.
        props.onCtrlV?.(props.value);
        return;
      }
      return;
    }
    if (key.escape) {
      props.onEscape?.();
      return;
    }
    if (key.ctrl && input === 'v') {
      // Pass the pre-event props.value as the strip baseline. ink-text-input's
      // useInput subscribes to ink's input event during its mount effect,
      // which is BEFORE InkInputFrame's useInput effect runs (React child-
      // first effect order). So by the time this handler fires, TextInput
      // has already synchronously injected a literal 'v' into the store.
      // props.value still reflects the last RENDERED value (no re-render
      // has happened yet), giving the host an honest "buffer before the
      // keystroke" snapshot that the post-paste strip can subtract from
      // the post-paste store value. Without this baseline, the strip's
      // length-equality check fails and the `v` survives — which is what
      // broke the @-mention regex and made Bandit appear to lose vision.
      props.onCtrlV?.(props.value);
      return;
    }
    // Clear-buffer shortcut. Shift+Backspace is the natural binding most
    // users reach for, but many terminals (macOS Terminal, default
    // gnome-terminal) don't differentiate it from a plain Backspace, so
    // we also accept Ctrl+U — the POSIX "kill line" sequence that
    // reliably arrives as ctrl + 'u' across every TTY we ship to.
    if ((key.shift && key.backspace) || (key.ctrl && input === 'u')) {
      if (props.value.length > 0) {
        props.onChange('');
      }
      return;
    }
    if (key.upArrow) {
      props.onHistoryPrev?.();
      return;
    }
    if (key.downArrow) {
      props.onHistoryNext?.();
      return;
    }
    if (key.tab && props.completer) {
      // Tab completion outside the @-mention overlay. Restores the
      // readline-path behavior for slash-command discovery (e.g.
      // `/he<Tab>` → `/help`). The completer returns [hits, substring]
      // matching readline's shape; `substring` is the prefix portion
      // of the line that matched and gets replaced by the chosen
      // completion.
      //
      // We only act on a single hit or a longer common prefix —
      // listing multiple matches would require writing above the live
      // ink frame, which only works through ink's <Static>. That
      // multi-hit list belongs to a follow-up; the single-hit and
      // prefix-extension cases already cover almost all real use.
      const [hits, substring] = props.completer(props.value);
      if (hits.length === 0) return;
      const head = props.value.slice(0, props.value.length - substring.length);
      if (hits.length === 1) {
        props.onChange(head + hits[0]);
        return;
      }
      const common = longestCommonPrefix(hits);
      if (common.length > substring.length) {
        props.onChange(head + common);
      }
      return;
    }
  });

  // Wraps TextInput's onSubmit. When the @-overlay is showing entries,
  // Enter should finalize the highlighted selection — NOT submit the
  // prompt-in-progress. Otherwise we bubble the submit up to the host.
  const handleTextInputSubmit = React.useCallback((value: string): void => {
    if (atActive && atResults.length > 0) {
      acceptAtMention('finalize');
      return;
    }
    props.onSubmit(value);
  }, [atActive, atResults.length, acceptAtMention, props]);

  // Footer hint, pinned to the bottom under the input box. Defaults
  // to "? for shortcuts" when nothing's passed; otherwise renders the
  // host's full tip line (e.g. `? shortcuts · /doctor · /review · @path · Ctrl+V image`)
  // so the user sees the menu of common entry points without having
  // to press `?` first. ink redraws this in-place per render — there's
  // no scrollback cost to keeping it rich.
  // Shell-mode indicator is HEIGHT-STABLE: instead of a separate banner
  // box above the input (which changes the frame height — and ink leaves
  // the old, taller frame stranded in scrollback when it shrinks back, so
  // `!` then backspace produced two composers), we recolor the existing
  // input border + footer yellow. The frame is the same height whether or
  // not `!` is typed, so there's nothing for ink to mis-erase.
  const hint = showBang
    ? '▸ SHELL MODE — next Enter runs in /bin/sh; the agent will not see it'
    : (props.footerTip && props.footerTip.length > 0 ? props.footerTip : '? for shortcuts');

  return (
    <Box flexDirection="column" width={frameWidth}>
      {showShortcuts && <ShortcutsOverlay />}
      {atActive && <AtMentionOverlay results={atResults} selectedIdx={atSelectedIdx} />}
      <Box borderStyle="round" borderColor={showBang ? 'yellow' : 'gray'} paddingX={1}>
        <Text color={showBang ? 'yellow' : 'cyan'}>{props.promptText}</Text>
        <TextInput
          key={`tx-${props.cursorBumpKey ?? 0}`}
          value={props.value}
          onChange={handleChange}
          onSubmit={handleTextInputSubmit}
          showCursor
          focus
        />
      </Box>
      <Box paddingLeft={2}>
        {/* truncate-end keeps the footer to exactly ONE line at any width.
            Without this, a wide normal hint wraps to 2 lines on a narrow
            terminal while the shorter shell-mode hint fits on 1 — the
            height flip-flop is what ink fails to erase, stranding the old
            footer when you type `!` then backspace. */}
        <Text color={showBang ? 'yellow' : undefined} dimColor={!showBang} wrap="truncate-end">{hint}</Text>
      </Box>
    </Box>
  );
}
