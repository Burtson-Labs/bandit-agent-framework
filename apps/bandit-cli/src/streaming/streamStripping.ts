/**
 * Incremental tool_call-markup stripper for live token streaming.
 *
 * The tool loop aggregates raw chunks for parsing but ALSO emits each
 * chunk as a `tool_loop:llm_chunk` event so hosts can stream to the
 * terminal. Raw chunks contain `<tool_call>{...}</tool_call>` markup
 * that users don't want on screen — they want the model's prose
 * reasoning. This function maintains a small state machine:
 *
 * - "normal": write bytes straight through, but buffer any trailing
 * `<` that might be the start of a tag split across chunks.
 * - "in tool_call": discard bytes until we see `</tool_call>`, then
 * return to normal.
 *
 * Returns the CLEAN text safe to flush to stdout. Bytes that might
 * still grow into a tag (e.g. a lone `<` at the tail) are kept in
 * `state.buffer` and re-examined on the next chunk.
 */
export interface StreamStrippingState {
  buffer: string;
  /** Which suppression mode, if any, is currently open. `null` means
   * we're emitting normal prose. Values match entries in
   * SUPPRESSED_BLOCKS below so we can look up the close tag. */
  suppress: 'tool_call' | 'think' | null;
  wroteAnyChunk: boolean;
  /** Markdown-table render buffer. Populated when consumeTablesInChunk
   * detects a `|...|` row. Holds raw lines (with newlines) until the
   * table closes (blank line or non-`|` line), at which point the
   * whole block is rendered as ANSI box-drawing chars and emitted. */
  tableBuffer: string;
  inTable: boolean;
  /** Trailing partial-line bytes pending the next chunk's newline so
   * consumeMarkdownInChunk can transform whole lines (headers, lists,
   * inline bold/italic/code spans) without splitting markup mid-token. */
  markdownBuffer: string;
  /** True between an opening ``` fence line and its matching closer.
   * Lines inside a fenced code block bypass inline markdown transforms
   * and emit unmodified (no bold-collapse on `**` inside source code). */
  inCodeFence: boolean;
  /** The info string (language) from the open fence line — e.g. `csharp`
   * from ```csharp. Used to syntax-highlight the block's lines; cleared on
   * the closing fence. */
  fenceLang?: string;
  /** Code-fence flag tracked by the table consumer. Mirrors `inCodeFence`
   * in purpose but tracked separately because the table consumer runs
   * before the markdown consumer in the pipeline and can't read its
   * state mid-stream. Used to bail out of pipe-row → box-render when
   * the user is showing markdown source as an example. */
  tableInCodeFence: boolean;
}

/**
 * Tag pairs that should NEVER reach the terminal when streaming. Each
 * entry's `open` matches a partial-tag prefix mid-chunk (so we can
 * buffer potential openers safely across chunk boundaries) and `close`
 * is the full end-tag. Order matters only in that we check the
 * FIRST-encountered open tag per pass — if both `<tool_call` and
 * `<think` appear in the same buffer, we enter whichever is earlier.
 *
 * Qwen 3.6 / bandit-logic emits `<think>…</think>` blocks inline with
 * the response stream (not wrapped in any markup we already strip),
 * so before this list grew those blocks bled straight into the user's
 * terminal — noise like "pondering… are available." in the CLI, observed
 * 2026-04-24. Suppressing them here keeps the raw tokens off-screen;
 * they still land in finalResponse (for downstream detectors that
 * strip their own copy) and the render-time sanitizer on the webview.
 */
export const SUPPRESSED_BLOCKS: ReadonlyArray<{ kind: 'tool_call' | 'think'; open: string; close: string }> = [
  { kind: 'tool_call', open: '<tool_call', close: '</tool_call>' },
  { kind: 'think',     open: '<think',     close: '</think>' }
];

/**
 * Drain whatever's left in the suppression-state buffer at stream end.
 *
 * `consumeStreamChunk` holds back up to 9 chars at every chunk boundary
 * so a partial `<tool_call` or `<think` opener can't leak through as
 * visible text. When the stream ends normally — closing prose, no
 * trailing tag — those held-back bytes are real content the user
 * needs to see. Without this drain they get silently dropped, which
 * shows up as the last 5–9 characters of an assistant turn going
 * missing ("uild" instead of "build", "ode" instead of "code").
 *
 * Only emits when not currently inside a suppressed block; if the
 * stream ended mid-`<tool_call>` we discard the buffer (corrupt
 * markup) rather than leaking partial XML to the terminal.
 */
export function flushStreamChunkBuffer(state: StreamStrippingState): string {
  if (state.suppress !== null) {
    state.buffer = '';
    return '';
  }
  const out = state.buffer;
  state.buffer = '';
  return out;
}

export function consumeStreamChunk(state: StreamStrippingState, chunk: string): string {
  state.buffer += chunk;
  let out = '';
  for (;;) {
    if (state.suppress === null) {
      // Find the earliest open tag across every suppression kind so a
      // `<think>` appearing before a later `<tool_call>` (or vice versa)
      // suppresses from its actual start, not from whichever kind's
      // indexOf we happened to check first.
      let earliestOpenIdx = -1;
      let earliestKind: 'tool_call' | 'think' | null = null;
      let earliestOpenLen = 0;
      for (const block of SUPPRESSED_BLOCKS) {
        const idx = state.buffer.indexOf(block.open);
        if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
          earliestOpenIdx = idx;
          earliestKind = block.kind;
          earliestOpenLen = block.open.length;
        }
      }
      if (earliestOpenIdx === -1) {
        // No complete open tag. We only need to hold back chars from
        // the most recent `<` IF that `<` could still grow into a real
        // suppressed opener (`<tool_call`, `<think`). If there is no
        // `<` in the buffer, or the `<…` tail can't possibly become a
        // suppressed tag, emit everything — there's nothing to defer.
        //
        // Earlier versions of this branch unconditionally held back a
        // 9-byte tail at every chunk boundary "just in case." The
        // tradeoff was wrong: prose streams almost never end mid-tag,
        // and the constant 9-byte deferral interacts badly with
        // anything downstream that resets buffers between iterations.
        // short character runs like `### Ex` and
        // `**Se` getting eaten from a markdown response. Holding only
        // when there's a real `<` in flight removes the cost without
        // losing the protection.
        const lt = state.buffer.lastIndexOf('<', state.buffer.length - 1);
        const tail = lt >= 0 ? state.buffer.slice(lt) : '';
        const tailIsPartialOpener = lt >= 0 && SUPPRESSED_BLOCKS.some((b) => b.open.startsWith(tail));
        const emitEnd = tailIsPartialOpener ? lt : state.buffer.length;
        out += state.buffer.slice(0, emitEnd);
        state.buffer = state.buffer.slice(emitEnd);
        return out;
      }
      // Emit everything up to the tag start, then enter suppression mode.
      out += state.buffer.slice(0, earliestOpenIdx);
      state.buffer = state.buffer.slice(earliestOpenIdx + earliestOpenLen);
      state.suppress = earliestKind;
    } else {
      const closeTag = SUPPRESSED_BLOCKS.find((b) => b.kind === state.suppress)!.close;
      const closeIdx = state.buffer.indexOf(closeTag);
      if (closeIdx === -1) {
        // Still inside the suppressed block, no close yet. Hold back any
        // trailing prefix of the close tag (e.g. `</thi`, `</tool_cal`)
        // so the next chunk can complete it; discard everything before
        // that — it's still suppressed content the user must not see.
        //
        // Pre-fix this branch unconditionally set `state.buffer = ''`,
        // which silently ate the chunk *after* a split close tag:
        // chunks like `['<think>hidden</thi', 'nk> visible'] ` lost the
        // `visible` tail because `nk>` arrived in normal-mode but the
        // close was never recognized. Holding back the close-prefix lets
        // the next consumeStreamChunk call match the full `</think>` and
        // resume emitting normal prose.
        let keep = 0;
        for (let n = Math.min(state.buffer.length, closeTag.length - 1); n > 0; n--) {
          if (closeTag.startsWith(state.buffer.slice(state.buffer.length - n))) {
            keep = n;
            break;
          }
        }
        state.buffer = keep > 0 ? state.buffer.slice(state.buffer.length - keep) : '';
        return out;
      }
      // Skip past the close tag, resume normal mode.
      state.buffer = state.buffer.slice(closeIdx + closeTag.length);
      state.suppress = null;
    }
  }
}

/**
 * Build a fresh `StreamStrippingState` ready for the start of a stream.
 *
 * Centralized so the table and markdown consumers (and tests) don't have
 * to re-declare the seven-field literal each time and so future fields
 * stay defaultable in one place.
 */
export function createStreamStrippingState(): StreamStrippingState {
  return {
    buffer: '',
    suppress: null,
    wroteAnyChunk: false,
    tableBuffer: '',
    inTable: false,
    markdownBuffer: '',
    inCodeFence: false,
    tableInCodeFence: false
  };
}
