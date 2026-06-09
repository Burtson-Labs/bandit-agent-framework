#!/usr/bin/env node
/**
 * Generate a synthetic asciinema .cast file showcasing the Bandit CLI.
 *
 * Why synthetic vs recording a real session:
 * - Deterministic timing — no model-latency variance, no rerolls
 * - Zero risk of leaking project-specific context (no real prompts hit
 *   the user's Ollama or the gateway during recording)
 * - Easy to iterate — change the script, re-run, get a new GIF in
 *   under a second
 *
 * The output exactly matches what bandit actually prints (same ANSI
 * sequences, same status-bar layout, same prompt glyph) so the GIF
 * reads as a real session.
 *
 * Usage:
 *   node apps/bandit-cli/scripts/make-demo-cast.mjs > demo.cast
 *   agg demo.cast demo.gif --theme monokai --speed 1.0 --font-size 14
 *
 * Tip: tweak `events` below to change demo content. Each event is
 * `{ at: secondsSinceStart, out: ansiString }`. The script normalizes
 * timing into the asciinema v2 format on emit.
 */

const COLS = 120;
const ROWS = 35;

// ── ANSI helpers ────────────────────────────────────────────────────────────
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ACCENT = `${ESC}[38;2;56;189;248m`;   // cyan-ish (Bandit's accent)
const CYAN = `${ESC}[36m`;
const MAGENTA = `${ESC}[35m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const dim = (s) => `${DIM}${s}${RESET}`;
const accent = (s) => `${ACCENT}${s}${RESET}`;
const bold = (s) => `${BOLD}${s}${RESET}`;
const cyan = (s) => `${CYAN}${s}${RESET}`;
const magenta = (s) => `${MAGENTA}${s}${RESET}`;
const green = (s) => `${GREEN}${s}${RESET}`;

// Right-align the status bar to the terminal width, dimmed.
const statusBar = (parts) => {
  const label = parts.join(' · ');
  const padding = Math.max(0, COLS - label.length - 1);
  return ' '.repeat(padding) + dim(label) + '\n';
};

const prompt = `${accent('›')} `;
const newline = '\n';

// ── Demo script ─────────────────────────────────────────────────────────────
// Each entry is `{ at: tSec, out: string }`. The generator interleaves
// these into the asciinema event stream with proper monotonic deltas.
const events = [];
const E = (at, out) => events.push({ at, out });

// 0.0–0.4s: prompt + user invokes bandit
E(0.0, dim('$ ') + 'bandit\n');

// 0.4–2.0s: banner + tips + recent activity
E(0.4,
  '\n' +
  // Compact ASCII banner — keeps the GIF small and works on any terminal.
  accent('  ╺┳━━┳╸ ██████╗  █████╗ ███╗   ██╗██████╗ ██╗████████╗\n') +
  accent('   ┃◉ ┃  ██╔══██╗██╔══██╗████╗  ██║██╔══██╗██║╚══██╔══╝\n') +
  accent('   ┃ ◉┃  ██████╔╝███████║██╔██╗ ██║██║  ██║██║   ██║   \n') +
  accent('   ┃◉ ┃  ██╔══██╗██╔══██║██║╚██╗██║██║  ██║██║   ██║   \n') +
  accent('   ┃ ◉┃  ██████╔╝██║  ██║██║ ╚████║██████╔╝██║   ██║   \n') +
  accent('   ╰──╯  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚═╝   ╚═╝   \n') +
  '\n' +
  '  ' + bold('v1.7.72') + '   ' + dim('local-first coding agent') + '\n' +
  '         ' + dim('built by ') + accent('Burtson Labs') + '\n' +
  '\n'
);
E(1.0, '  ' + bold('Tips for getting started') + '\n');
E(1.1, `    ${dim('•')} Type ${accent('?')} at the prompt for keyboard shortcuts.\n`);
E(1.2, `    ${dim('•')} Type ${cyan('/help')} for the full list of slash commands.\n`);
E(1.3, '\n  ' + bold('Recent activity') + '\n');
E(1.4, `    ${dim('•')} ${dim('2026-04-25 17:01')}\n`);
E(1.5, `    ${dim('•')} ${dim('2026-04-25 16:45')}\n`);
E(1.6, `    ${dim('•')} ${dim('2026-04-25 14:22')}\n\n`);
E(1.8, dim('  ✻ booting…') + '\n');
E(2.4, dim('  ✓ ollama detected · 12 models') + '\n');
E(2.6, dim('  ✓ memory: BANDIT.md · 11 skills') + '\n\n');

// 2.8s: footer hint + status bar + first prompt
E(2.8,
  '\n' + ' '.repeat(COLS - 84) +
  dim('? for shortcuts  ·  /help for commands  ·  @path to pin a file  ·  Ctrl+V paste image') + '\n'
);
E(3.0, statusBar(['bandit-core-1', '0 turns', '1s', 'main']));
E(3.05, prompt);

// 4.0s: user hits ? — menu pops instantly
E(4.0, '?\n\n');
E(4.05,
  '  ' + accent('?')      + '       ' + dim('show this menu     ') + '  ' + accent('Ctrl+V') + '       ' + dim('paste image  ') + '  ' + cyan('/help')     + '         ' + dim('full command list') + '\n' +
  '  ' + accent('/')      + '       ' + dim('slash commands     ') + '  ' + accent('Ctrl+C') + '       ' + dim('cancel turn  ') + '  ' + cyan('/login')    + '        ' + dim('save cloud API key') + '\n' +
  '  ' + accent('@')      + '       ' + dim('pin a file         ') + '  ' + accent('Ctrl+D') + '       ' + dim('exit         ') + '  ' + cyan('/provider') + '     ' + dim('switch ollama/bandit') + '\n' +
  '  ' + accent('↑ / ↓')  + '   ' + dim('history            ') + '  ' + accent('Enter')  + '        ' + dim('submit       ') + '  ' + cyan('/tasks')    + '        ' + dim('background subagents') + '\n\n'
);
E(4.7, statusBar(['bandit-core-1', '0 turns', '2s', 'main']));
E(4.75, prompt);

// 6.0s: user submits the audit prompt
E(6.0, 'audit every package.json in this monorepo for outdated deps in the background\n\n');

// 6.4s: agent dispatches todo + task
E(6.4, '  ' + accent('→') + ' todo_write\n');
E(6.7, '  ' + accent('→') + ' task\n');
E(7.1, '  ' + magenta('✦') + ' subagent: ' + dim('Audit every package.json in the workspace for outdated dependency versions and report findings.') + '\n');
E(7.6, dim('Spawned background subagent (task id: ') + accent('bg-q9z2') + dim('). I\'ll let you know when it\'s done — keep going.') + '\n');
E(8.0, '\n  ' + dim('→ ~146 tokens  ·  1s') + '\n\n');
E(8.2, '─'.repeat(80) + '\n');
E(8.3, '  ' + dim('✻ recap: "audit every package.json…" → Spawned background subagent (bg-q9z2)') + '\n');
E(8.4, statusBar(['bandit-core-1', '1 turn', '8s', 'main', cyan('bg:1 running')]));
E(8.45, prompt);

// 9.5s: user keeps the conversation going while subagent runs
E(9.5, 'what other commands do you support?\n\n');
E(10.0, 'Quick rundown of what I can do beyond the basics:\n\n');
E(10.4, '  ' + cyan('/insights') + ' generates an HTML report of your sessions, tool usage, and productivity tips.\n');
E(10.7, '  ' + cyan('/rewind')   + '   restores any file from per-edit checkpoints — undo a write without git.\n');
E(11.0, '  ' + cyan('/provider') + ' hot-swap between local Ollama and Bandit Cloud mid-session.\n');
E(11.3, '  ' + cyan('/theme')    + '   pick from 6 palettes including colorblind-friendly variants.\n\n');
E(11.6, '  ' + dim('→ ~89 tokens  ·  1s') + '\n\n');
E(11.7, '─'.repeat(80) + '\n');
E(11.8, '  ' + dim('✻ recap: "what other commands…" → Quick rundown of what I can do beyond the basics') + '\n');
E(11.9, statusBar(['bandit-core-1', '2 turns', '12s', 'main', cyan('bg:1 running')]));
E(11.95, prompt);

// 13.0s: user checks /tasks
E(13.0, '/tasks\n\n');
E(13.1,
  bold('Background subagent tasks:') + '\n' +
  '  ' + cyan('bg-q9z2') + '  ' + cyan('running (5s)') + '  ' + dim('Audit every package.json in the workspace for outdated…') + '\n\n' +
  dim('Use /tasks <id> for the full synopsis or /tasks cancel <id> to stop one.') + '\n'
);
E(13.6, statusBar(['bandit-core-1', '2 turns', '14s', 'main', cyan('bg:1 running')]));
E(13.65, prompt);

// 14.5s: user runs /insights
E(14.5, '/insights\n');
E(14.7, green('✓ insights written to ') + cyan('~/.bandit/insights.html') + '\n');
E(14.8, dim('  (opening in your default browser)') + '\n');
E(15.0, statusBar(['bandit-core-1', '2 turns', '15s', 'main', cyan('bg:1 running')]));
E(15.05, prompt);

// 16.5s: subagent completes, notice + synopsis injects on next user prompt
E(16.5, '  ' + green('✓ background task bg-q9z2 completed') + '\n');
E(16.6, statusBar(['bandit-core-1', '2 turns', '17s', 'main']));
E(16.65, prompt);

// 17.5s: user types acknowledgement → agent gets the synopsis injected
E(17.5, 'so?\n\n');
E(18.0, 'Audit done — your subagent surfaced 3 packages worth bumping:\n\n');
E(18.4, `  ${cyan('typescript')} ${dim('5.4.0')} → ${green('5.9.3')}  ${dim('(safe, minor)')}\n`);
E(18.7, `  ${cyan('vitest')}     ${dim('3.8.1')} → ${green('4.0.10')} ${dim('(safe, minor)')}\n`);
E(19.0, `  ${cyan('esbuild')}    ${dim('0.24.0')} → ${green('0.28.0')} ${dim('(major — review breaking changes)')}\n\n`);
E(19.3, 'Want me to bump them and run the test suite?\n\n');
E(19.6, '  ' + dim('→ ~218 tokens  ·  2s') + '\n\n');
E(19.7, '─'.repeat(80) + '\n');
E(19.8, '  ' + dim('✻ recap: "so?" → Audit done — 3 packages worth bumping') + '\n');
E(19.9, statusBar(['bandit-core-1', '3 turns', '20s', 'main']));
E(19.95, prompt);

// 21.5s: graceful exit
E(21.5, 'exit\n');
E(21.6, dim('  ℹ session saved: 20260425-194523-x9q1') + '\n');

// ── Emit asciinema v2 cast ──────────────────────────────────────────────────
// Header line first, then each event as [time, "o", data]. The format
// is deterministic — `agg` reads it directly.
const header = {
  version: 2,
  width: COLS,
  height: ROWS,
  timestamp: Math.floor(Date.now() / 1000),
  env: { TERM: 'xterm-256color', SHELL: '/bin/zsh' },
  title: 'Bandit CLI demo'
};

process.stdout.write(JSON.stringify(header) + '\n');
for (const ev of events) {
  process.stdout.write(JSON.stringify([ev.at, 'o', ev.out]) + '\n');
}
