import { createStreamStrippingState } from '../streaming/streamStripping';
import { consumeTablesInChunk, flushTableState } from './tableRender';
import { consumeMarkdownInChunk, flushMarkdownState } from './markdownRender';

/**
 * Render a COMPLETE markdown string to terminal output (ANSI: headers, bold,
 * lists, blockquotes, and box-drawing tables) — the same table→markdown pipeline
 * the REPL streams live (see cli.ts), run in one shot over a fresh state.
 *
 * Used for answers that arrive WHOLE rather than streamed — notably a graph run's
 * synthesized sink output. Without this the graph path printed the model's raw
 * markdown (`#`, `**`, `| … |`) straight to stdout, so a graph-routed turn looked
 * unformatted next to a normal turn. (Stream-chunk stripping is intentionally NOT
 * applied here: the text is already clean synthesis, not live model tokens.)
 */
export function renderMarkdownDocument(md: string): string {
  const state = createStreamStrippingState();
  const body = consumeMarkdownInChunk(state, consumeTablesInChunk(state, md));
  const tail = consumeMarkdownInChunk(state, flushTableState(state)) + flushMarkdownState(state);
  return body + tail;
}
