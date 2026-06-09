/**
 * TurnView — the live bottom region that stays mounted for the WHOLE
 * duration of an agent turn (the ink-owns-turn step; see
 * docs/ink-turn-view-plan.md). It renders below ink's <Static> committed
 * scrollback and contains, top-to-bottom:
 *
 *   [in-progress streamed line]   ← the not-yet-newlined tail of output
 *   [plan / todo tree]            ← updates IN PLACE across todo_write
 *   [status line]                 ← spinner glyph + tok/s + elapsed
 *   ╭───────────────────────────────────────────────╮
 *   │ ❯ <composer buffer>                            │
 *   ╰───────────────────────────────────────────────╯
 *     type to queue · Enter sends after turn · /btw nudges now · Esc stops
 *
 * Everything here is EPHEMERAL — it re-renders in place and never lands in
 * scrollback. Permanent turn output (assistant tokens once a line
 * completes, tool cards, diffs) is committed to <Static> by the host via
 * `commitTurnLine` and is NOT this component's concern. That split is the
 * whole point: scrollback stays a faithful, scroll-up-able record while a
 * composer + CTA stay pinned at the bottom even while the model streams.
 *
 * The plan tree is rendered NATIVELY in ink (markers + colors via Text
 * props) rather than fed pre-colored strings, so it updates cleanly in
 * place as item statuses change — the durable version of the
 * committed-scrollback checklist the lightweight build approximated.
 */

import * as React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { DockTodo } from '../spinner';

export interface TurnViewProps {
  /** Plan/todo items, rendered as an in-place tree. Empty → no tree. */
  plan: DockTodo[];
  /** Pre-colored status line (spinner glyph + tok/s + elapsed). The host
   *  owns the styling; we pass it straight through a <Text>. '' → hidden. */
  status: string;
  /** The in-progress streamed line — the tail of assistant output that
   *  hasn't hit a newline yet. Flushed to <Static> by the host on newline,
   *  at which point this goes back to ''. Pre-colored. '' → hidden. */
  stream: string;
  /** Mid-turn composer buffer. */
  composer: string;
  /** CTA hint shown under the composer. */
  cta: string;
  onComposerChange: (next: string) => void;
  onComposerSubmit: (value: string) => void;
  /** Esc — host wires this to the active turn's AbortController. */
  onEscape?: () => void;
  /** Bumps when the composer value is set programmatically so TextInput
   *  remounts with the cursor at end-of-text (same trick InkInputFrame
   *  uses). */
  cursorBumpKey?: number;
}

// Mirror the spinner dock's collapse threshold so the in-place tree and
// the old committed-block checklist agree on how many rows to show before
// summarizing — no surprise when the default flips.
const PLAN_MAX_VISIBLE = 6;

function PlanTree({ items }: { items: DockTodo[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === 'done').length;
  const shown = items.slice(0, PLAN_MAX_VISIBLE);
  const rest = items.slice(PLAN_MAX_VISIBLE);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        <Text color="cyan">●</Text> plan · {done}/{items.length} done
      </Text>
      {shown.map((t, i) => {
        const text = t.content.replace(/\s+/g, ' ').trim();
        if (t.status === 'done') {
          return (
            <Text key={i}>
              {'   '}<Text color="green">✓</Text> <Text dimColor>{text}</Text>
            </Text>
          );
        }
        if (t.status === 'in_progress') {
          return (
            <Text key={i} bold>
              {'   '}<Text color="cyan">▪</Text> <Text color="cyan">{text}</Text>
            </Text>
          );
        }
        return (
          <Text key={i} dimColor>
            {'   '}☐ {text}
          </Text>
        );
      })}
      {rest.length > 0 && (
        <Text dimColor>
          {'   '}… +{summarize(rest)}
        </Text>
      )}
    </Box>
  );
}

function summarize(items: DockTodo[]): string {
  const pending = items.filter((t) => t.status === 'pending').length;
  const active = items.filter((t) => t.status === 'in_progress').length;
  const done = items.filter((t) => t.status === 'done').length;
  return [
    pending ? `${pending} pending` : null,
    active ? `${active} in progress` : null,
    done ? `${done} done` : null
  ].filter(Boolean).join(', ');
}

export function TurnView(props: TurnViewProps): React.JSX.Element {
  // Esc cancels the turn. TextInput owns every other key (typing,
  // backspace, cursor) so the composer stays fully editable mid-turn.
  // Enter is handled by TextInput's onSubmit, not here, so the two never
  // fight for the same event.
  useInput((_input, key) => {
    if (key.escape) {
      props.onEscape?.();
    }
  });

  const cta = props.cta && props.cta.length > 0
    ? props.cta
    : 'type to queue · Enter sends after turn · /btw nudges now · Esc stops';

  // Cap the frame one column short of the terminal width — a full-width
  // rounded-border Box lands its right border on the last column, and with
  // auto-wrap (DECAWM) on that sprouts a phantom wrapped line. (Same reason
  // as InkInputFrame.)
  const { stdout } = useStdout();
  const frameWidth = Math.max(20, (stdout?.columns ?? 80) - 1);

  return (
    <Box flexDirection="column" width={frameWidth}>
      {props.stream.length > 0 && (
        <Box marginBottom={0}>
          <Text>{props.stream}</Text>
        </Box>
      )}
      <PlanTree items={props.plan} />
      {props.status.length > 0 && (
        <Box>
          <Text>{props.status}</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={props.plan.length > 0 || props.status.length > 0 ? 0 : 0}>
        <Text color="cyan">❯ </Text>
        <TextInput
          key={`turn-tx-${props.cursorBumpKey ?? 0}`}
          value={props.composer}
          onChange={props.onComposerChange}
          onSubmit={props.onComposerSubmit}
          showCursor
          focus
        />
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>{cta}</Text>
      </Box>
    </Box>
  );
}
