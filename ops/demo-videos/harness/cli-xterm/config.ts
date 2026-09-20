/**
 * Playwright + xterm.js harness for Bandit CLI UX.
 *
 * Ink/ANSI terminals have no DOM, so agents (and humans) cannot screenshot
 * layout bugs. This page hosts an xterm.js terminal fed by a PTY that runs
 * `bandit`, giving Playwright a real viewport for:
 *   - demo-video capture (ops/demo-videos)
 *   - agent self-improve loops (`cli_ux_snapshot` skill / future host tool)
 *
 * Usage (from ops/demo-videos or apps/bandit-cli):
 *   BANDIT_BIN=… node --import tsx harness/cli-xterm/serve.ts
 *   npx playwright screenshot http://127.0.0.1:4177/ …
 *
 * This is the foundation — wire a host tool that returns the PNG path once
 * the PTY bridge is stable on CI.
 */

export const CLI_XTERM_HARNESS = {
  id: 'cli-xterm',
  defaultPort: 4177,
  /** Fixed geometry so golden screenshots are comparable. */
  cols: 100,
  rows: 32,
  env: {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Deterministic turn chrome for visual diffs when supported.
    BANDIT_TURN_VIEW: '1',
  },
} as const;
