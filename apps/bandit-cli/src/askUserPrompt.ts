/**
 * Interactive "ask the user" prompt for the CLI — the host side of the
 * agent-core `ask_user` tool.
 *
 * Renders one or more questions as a keyboard-driven form: suggested options
 * per question, a "type your own" custom-answer row, and (for multiple
 * questions) a tab bar with a final Submit tab. Mirrors permissionPrompt.ts's
 * lifecycle exactly so it composes with the turn-view:
 *   - `rl.pause()` in turn mode fires onPauseInTurn → removeTurnCapture, so
 *     the form renders live on the real stdout instead of being swallowed
 *     into the <Static> scrollback capture; the matching resume reinstalls it.
 *   - The custom-answer path reuses the deny+note resume→readLine→pause dance
 *     so free text is typed in ink's composer (with the lineIntercept queue
 *     bypass), then control returns to the raw-mode form.
 *
 * Answers are RADIO-BUTTON semantics: the highlighted option on each question
 * IS that question's answer (defaulting to the first option), so navigating
 * straight to Submit records your selections rather than leaving them blank.
 * Enter advances to the next question; a free-text answer is recorded only
 * once typed. Falls back to a sequential text prompt when stdin isn't a TTY.
 */

import * as readline from 'readline';
import { c } from './ansi';
import type { UserInputQuestion, UserInputResponse } from '@burtson-labs/agent-core';

/** The slice of the ink/readline interface we drive. All optional so the
 *  one-shot / non-ink paths degrade cleanly. */
interface InkLike {
  pause?: () => void;
  resume?: () => void;
  isPaused?: () => boolean;
  isTurnMode?: () => boolean;
}

export interface AskUserPromptDeps {
  /** The REPL's ink/readline interface — paused while the form owns stdin. */
  rl?: InkLike;
  /** Reads one line of fresh user input (used for custom answers). Should
   *  honor `bypassQueue` so a stale mid-turn message isn't consumed as the
   *  answer — same contract as the permission deny+note follow-up. */
  readLine?: (opts?: { bypassQueue?: boolean }) => Promise<string>;
}

export async function promptAskUser(
  questions: UserInputQuestion[],
  deps: AskUserPromptDeps = {}
): Promise<UserInputResponse> {
  if (questions.length === 0) return { answers: {} };
  if (!process.stdin.isTTY) return promptSequential(questions, deps.readLine);
  return promptInteractive(questions, deps);
}

/** Non-TTY fallback: print each question + numbered options, read a line
 *  (a digit selects an option, anything else is a free-text answer). */
async function promptSequential(
  questions: UserInputQuestion[],
  readLine?: (opts?: { bypassQueue?: boolean }) => Promise<string>
): Promise<UserInputResponse> {
  if (!readLine) return { answers: {}, cancelled: true };
  const answers: Record<string, string> = {};
  for (const q of questions) {
    process.stdout.write('\n' + c.bold(q.question) + '\n');
    const opts = q.options ?? [];
    opts.forEach((o, i) =>
      process.stdout.write(c.dim(`  ${i + 1}) ${o.label}${o.description ? ' — ' + o.description : ''}`) + '\n')
    );
    process.stdout.write(c.accent('› your answer' + (opts.length ? ' (number or text)' : '') + ': '));
    const raw = (await readLine({ bypassQueue: true })).trim();
    if (!raw) continue;
    const n = parseInt(raw, 10);
    answers[q.id] = !isNaN(n) && n >= 1 && n <= opts.length ? opts[n - 1].label : raw;
  }
  return { answers };
}

function promptInteractive(
  questions: UserInputQuestion[],
  deps: AskUserPromptDeps
): Promise<UserInputResponse> {
  const multi = questions.length > 1;
  // Tab indices: 0..N-1 are questions; index N (multi only) is the Submit tab.
  const submitTab = questions.length;
  const lastTab = multi ? submitTab : questions.length - 1;

  // The highlighted row per question IS that question's answer (radio
  // semantics). Free text typed via the custom row is stashed here.
  const selRows = questions.map(() => 0);
  const customText: Record<string, string> = {};
  let qIndex = 0;
  let prevLines = 0;
  let firstDraw = true;

  const nOpts = (qi: number): number => questions[qi].options?.length ?? 0;
  const allowFree = (qi: number): boolean => questions[qi].allowFreeform !== false;
  const rowCount = (qi: number): number => Math.max(1, nOpts(qi) + (allowFree(qi) ? 1 : 0));
  const isCustomRow = (qi: number, row: number): boolean => allowFree(qi) && row === nOpts(qi);

  /** The current answer for a question, derived from its highlighted row. */
  const answerFor = (qi: number): string | undefined => {
    const row = selRows[qi];
    if (isCustomRow(qi, row)) return customText[questions[qi].id];
    return questions[qi].options?.[row]?.label;
  };
  const isAnswered = (qi: number): boolean => {
    const a = answerFor(qi);
    return a !== undefined && a !== '';
  };

  const cols = (): number => process.stdout.columns || 80;
  const fit = (s: string): string => {
    const w = Math.max(20, cols() - 4);
    return s.length > w ? s.slice(0, w - 1) + '…' : s;
  };

  const buildLines = (): string[] => {
    const lines: string[] = [];
    const onSubmit = multi && qIndex === submitTab;
    lines.push(c.accent('│ ') + c.bold('Bandit needs your input'));

    if (multi) {
      const labels = questions.map((q, i) => q.header || `Q${i + 1}`).concat('Submit');
      const plain = labels.map((l) => ` ${l} `).join(' ');
      if (plain.length <= Math.max(20, cols() - 4)) {
        const allAnswered = questions.every((_, i) => isAnswered(i));
        const bar = labels
          .map((t, i) => {
            const txt = ` ${t} `;
            if (i === qIndex) return c.accent('‹') + c.bold(txt) + c.accent('›');
            if (i === submitTab) return '  ' + (allAnswered ? c.green(txt) : c.dim(txt));
            return '  ' + (isAnswered(i) ? c.green(txt) : c.dim(txt));
          })
          .join('');
        lines.push(c.accent('│ ') + bar);
      } else {
        const where = onSubmit ? 'Review & submit' : `Question ${qIndex + 1} of ${questions.length}`;
        lines.push(c.accent('│ ') + c.dim(where));
      }
    }
    lines.push(c.accent('│'));

    if (onSubmit) {
      lines.push(c.accent('│ ') + c.bold('Review your answers'));
      lines.push(c.accent('│'));
      questions.forEach((q, i) => {
        const a = answerFor(i);
        const head = q.header || `Q${i + 1}`;
        const shown = a !== undefined && a !== '' ? c.green(fit(a)) : c.red('— not answered —');
        lines.push(c.accent('│ ') + c.dim(`${head}: `) + shown);
      });
    } else {
      const q = questions[qIndex];
      const opts = q.options ?? [];
      lines.push(c.accent('│ ') + c.bold(fit(q.question)));
      lines.push(c.accent('│'));
      for (let r = 0; r < rowCount(qIndex); r++) {
        const sel = r === selRows[qIndex];
        const marker = sel ? c.accent('▸ ') : '  ';
        const digit = `${r + 1} `;
        if (isCustomRow(qIndex, r)) {
          const typed = customText[q.id];
          const label = typed ? `${digit}${fit(typed)}  (custom)` : `${digit}Type a custom answer…`;
          const styled = sel ? c.bold(label) : typed ? c.green(label) : c.dim(label);
          // A typed custom answer that's currently highlighted is the live answer.
          lines.push(c.accent('│ ') + marker + styled + (sel && typed ? c.green(' ✓') : ''));
        } else {
          const o = opts[r];
          const label = fit(`${digit}${o.label}`);
          const styled = sel ? c.bold(label) : c.dim(label);
          // The highlighted option IS the recorded answer — flag it so the
          // user sees their choice is captured without an extra keystroke.
          lines.push(c.accent('│ ') + marker + styled + (sel ? c.green(' ✓') : ''));
          if (sel && o.description) {
            lines.push(c.accent('│ ') + '    ' + c.dim(fit(o.description)));
          }
        }
      }
    }

    lines.push(c.accent('│'));
    const hint = onSubmit
      ? 'enter submit · ←→ back to questions · esc cancel'
      : multi
        ? '↑↓ choose · ←→ switch question · enter next · esc cancel'
        : '↑↓ choose · enter confirm · esc cancel';
    lines.push(c.accent('╰── ') + c.dim(hint));
    return lines;
  };

  const render = (): void => {
    const lines = buildLines();
    if (!firstDraw) {
      const up = prevLines - 1;
      process.stdout.write('\r' + (up > 0 ? `\x1b[${up}A` : '') + '\x1b[0J');
    }
    firstDraw = false;
    process.stdout.write(lines.join('\n'));
    prevLines = lines.length;
  };

  const wasRaw = process.stdin.isRaw === true;
  const wasPaused = deps.rl?.isPaused?.() ?? false;

  return new Promise<UserInputResponse>((resolve) => {
    let done = false;

    const fallbackReadLine = (_opts?: { bypassQueue?: boolean }): Promise<string> =>
      new Promise<string>((r) => {
        const temp = readline.createInterface({ input: process.stdin, output: process.stdout });
        temp.once('line', (line) => {
          temp.close();
          r(line);
        });
      });

    const rearm = (): void => {
      process.stdin.setRawMode?.(true);
      readline.emitKeypressEvents(process.stdin);
      process.stdin.resume();
      process.stdin.on('keypress', onKey);
    };

    const finish = (cancelled: boolean): void => {
      if (done) return;
      done = true;
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode?.(wasRaw);
      // Advance past the form so the turn's next output starts on a fresh row.
      process.stdout.write('\n');
      // Remount the turn composer for the rest of the turn — but only if WE
      // unmounted it (mirrors permissionPrompt's restoreRl). If the caller
      // had already paused ink, leave it for them to resume.
      if (!wasPaused) deps.rl?.resume?.();
      if (cancelled) {
        resolve({ answers: {}, cancelled: true });
        return;
      }
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        const a = answerFor(i);
        if (a !== undefined && a !== '') answers[q.id] = a;
      });
      resolve({ answers });
    };

    // Free-text answer: tear down our raw input, reveal the composer, read a
    // line via the same bypass-queue path the deny+note follow-up uses, then
    // re-arm the form (or submit, for a single question).
    const openCustom = (qi: number): void => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode?.(false);
      const q = questions[qi];
      const inTurn = deps.rl?.isTurnMode?.() === true;
      process.stdout.write(
        '\n' +
          c.accent('│ ') +
          c.cyan(`Type your answer${q.header ? ` for "${q.header}"` : ''}:`) +
          (inTurn ? '\n' : ' ')
      );
      deps.rl?.resume?.();
      const gather = deps.readLine ?? fallbackReadLine;
      gather({ bypassQueue: true })
        .then((text) => {
          deps.rl?.pause?.();
          const val = text.trim();
          if (val) customText[q.id] = val;
          // Keep the highlight on the custom row so the typed answer shows.
          selRows[qi] = nOpts(qi);
          if (val && !multi) {
            finish(false);
            return;
          }
          rearm();
          if (val && multi) qIndex = Math.min(lastTab, qi + 1);
          firstDraw = true;
          render();
        })
        .catch(() => {
          deps.rl?.pause?.();
          finish(true);
        });
    };

    const onKey = (
      _str: string,
      key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined
    ): void => {
      if (!key) return;
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        finish(true);
        return;
      }

      const onSubmit = multi && qIndex === submitTab;

      if (key.name === 'left' || (key.name === 'tab' && key.shift)) {
        if (qIndex > 0) {
          qIndex--;
          render();
        }
        return;
      }
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) {
        if (qIndex < lastTab) {
          qIndex++;
          render();
        }
        return;
      }

      if (!onSubmit) {
        const rows = rowCount(qIndex);
        if (key.name === 'up') {
          selRows[qIndex] = (selRows[qIndex] - 1 + rows) % rows;
          render();
          return;
        }
        if (key.name === 'down') {
          selRows[qIndex] = (selRows[qIndex] + 1) % rows;
          render();
          return;
        }
        if (key.name && /^[1-9]$/.test(key.name)) {
          const d = parseInt(key.name, 10) - 1;
          if (d < rows) {
            selRows[qIndex] = d;
            render();
          }
          return;
        }
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (onSubmit) {
          finish(false);
          return;
        }
        // On the custom row, Enter opens the text editor; otherwise the
        // highlighted option is already recorded, so Enter just advances.
        if (isCustomRow(qIndex, selRows[qIndex])) {
          openCustom(qIndex);
          return;
        }
        if (!multi) {
          finish(false);
          return;
        }
        qIndex = Math.min(lastTab, qIndex + 1);
        render();
        return;
      }
    };

    // Take stdin: pause ink (turn mode → removeTurnCapture so we render
    // live), enter raw mode, draw.
    if (!wasPaused) deps.rl?.pause?.();
    process.stdin.setRawMode?.(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    render();
  });
}
