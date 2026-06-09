/**
 * Turn-view demo — exercises the REAL TurnView component + ink interface
 * plumbing through a scripted fake turn, with no agent and no risk to the
 * live turn path. This is the Phase 1 checkpoint from
 * docs/ink-turn-view-plan.md: prove the persistent mid-turn composer +
 * in-place plan tree + streaming + ANSI fidelity feel right BEFORE the
 * invasive cli.ts routing (Phase 2/3) goes in.
 *
 * Run it:
 *     node apps/bandit-cli/dist/__demo__/turn-view-demo.js
 *
 * While it runs the composer stays live the whole time — type to see the
 * buffer echo mid-"turn", Enter queues, `/btw <msg>` nudges, Esc stops.
 */

import { createInkLineInterface, type InkLineInterface } from '../input/inkInterface';
import type { DockTodo } from '../spinner';
import { c, supportsTrueColor } from '../ansi';

// Reproduce the spinner's shifty-eyes frames + truecolor breathe so the
// demo's status line matches what the real turn will show. (The real
// spinner owns these; mirrored here only because the demo drives the
// status string directly instead of through the spinner sink that
// Phase 2 will install.)
const FRAMES = ['◐◐', '◐◐', '◐◐', '◑◑', '◑◑', '◑◑', '⊖⊖', '◐◐', '◑◑'];
const TRUECOLOR = supportsTrueColor();
const GLOW = { r: 96, g: 216, b: 255 };
function glowGlyph(glyph: string, nowMs: number): string {
  if (!TRUECOLOR) return c.accent(glyph);
  const phase = (nowMs % 1500) / 1500;
  const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 2 * Math.PI));
  return `\x1b[38;2;${Math.round(GLOW.r * k)};${Math.round(GLOW.g * k)};${Math.round(GLOW.b * k)}m${glyph}\x1b[39m`;
}

const iface: InkLineInterface = createInkLineInterface({
  cwd: process.cwd(),
  footerTip: 'turn-view demo · type to queue · /btw to nudge · Esc to stop',
  searchFiles: () => []
});

// Fresh plan array of fresh objects each call — exactly how the real
// cli.ts commitTodoChecklist drives setTurnPlan (items.map(t => ({...}))).
type Status = DockTodo['status'];
const planAt = (s0: Status, s1: Status, s2: Status): DockTodo[] => [
  { status: s0, content: 'map the auth module surface' },
  { status: s1, content: 'extract token refresh into a helper' },
  { status: s2, content: 'add a regression test for expiry' }
];

let frame = 0;
let turnStart = Date.now();
let fakeTokens = 0;
let statusTimer: NodeJS.Timeout | null = null;

function paintStatus(): void {
  const elapsed = Math.floor((Date.now() - turnStart) / 1000);
  const glyph = glowGlyph(FRAMES[frame % FRAMES.length], Date.now());
  frame += 1;
  const rate = fakeTokens > 0 ? `  ·  ${(fakeTokens / 1000).toFixed(1)}K tok @ ${120 + (frame % 40)} tok/s` : '';
  iface.setTurnStatus?.(glyph + ' ' + c.dim(`working on it  ·  ${elapsed}s${rate}`));
}

function startStatus(): void {
  if (statusTimer) return;
  statusTimer = setInterval(paintStatus, 90);
}

// Composer wiring — the host-side behavior Phase 3 will implement for real.
iface.on('turnSubmit', (msg: string) => {
  iface.commitTurnLine?.(c.green('  ✓ queued') + c.dim(` — runs after this turn: “${msg}”`));
});
iface.on('nudge', (msg: string) => {
  iface.commitTurnLine?.(c.accent('  ➜ nudged the running agent') + c.dim(` — it sees this before its next step: “${msg}”`));
});
iface.on('escape', () => {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  iface.commitTurnLine?.(c.yellow('↷ cancelled by Esc — agent stopped.'));
  iface.exitTurnMode?.();
  setTimeout(() => { iface.close(); process.exit(0); }, 400);
});
iface.on('close', () => process.exit(0));

// Scripted timeline. setTimeout/Date.now are fine here — this is an
// ordinary node entry, not a Workflow script.
const steps: Array<[number, () => void]> = [
  [200, () => {
    iface.commitTurnLine?.(c.bold(c.accent('● bandit')) + c.dim('  turn-view demo — a scripted fake turn'));
    iface.commitTurnLine?.(c.cyan('❯ ') + 'refactor the auth module to extract token refresh');
    turnStart = Date.now();
    iface.enterTurnMode?.();
    iface.setTurnPlan?.(planAt('in_progress', 'pending', 'pending'));
    startStatus();
  }],
  [1100, () => iface.commitTurnLine?.(c.dim('  ') + c.cyan('read_file') + c.dim('  src/auth/session.ts  (142 lines)'))],
  [2000, () => iface.commitTurnLine?.(c.dim('  ') + c.cyan('grep') + c.dim('  "refreshToken"  → 4 matches in 3 files'))],
  [2800, () => {
    // stream a sentence char-by-char into the live region, then flush.
    const sentence = 'Token refresh is duplicated across session.ts and middleware.ts — I will lift it into a single refreshIfExpired() helper.';
    let i = 0;
    const stream = setInterval(() => {
      fakeTokens += 6;
      i = Math.min(sentence.length, i + 2);
      iface.setTurnStream?.(sentence.slice(0, i));
      if (i >= sentence.length) {
        clearInterval(stream);
        iface.commitTurnLine?.(sentence);
        iface.setTurnStream?.('');
      }
    }, 35);
  }],
  [5200, () => {
    iface.setTurnPlan?.(planAt('done', 'in_progress', 'pending'));
    iface.commitTurnLine?.(c.dim('  ') + c.green('+') + c.dim(' src/auth/refresh.ts  ') + c.green('(new, 28 lines)'));
  }],
  [6800, () => {
    iface.commitTurnLine?.(c.dim('  ') + c.cyan('edit_file') + c.dim('  src/auth/session.ts  ') + c.green('+2 ') + c.red('-19'));
    iface.setTurnPlan?.(planAt('done', 'done', 'in_progress'));
  }],
  [8200, () => {
    iface.setTurnPlan?.(planAt('done', 'done', 'done'));
    iface.commitTurnLine?.('');
    iface.commitTurnLine?.(c.green('✓ done') + c.dim('  — extracted refreshIfExpired(), wired both call sites, added expiry test.'));
    iface.setTurnStatus?.(c.dim('  idle — type below · Enter queues · /btw nudges · Esc / Ctrl+C exits'));
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }]
];

for (const [delay, fn] of steps) setTimeout(fn, delay);
