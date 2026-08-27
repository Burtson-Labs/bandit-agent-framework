/**
 * Last-resort crash guard for the interactive CLI.
 *
 * A long-running REPL that puts the terminal into raw mode and hides the cursor
 * has three ways to ruin a user's day when an unexpected error escapes:
 *
 *  1. The raw stack trace prints over whatever was on screen.
 *  2. The terminal is left wedged — raw mode on, cursor hidden — so the shell
 *     is unusable until `stty sane` / `reset`, which most users don't know.
 *  3. The in-flight conversation looks lost, because the session file only gets
 *     rewritten at turn boundaries.
 *
 * This installs `uncaughtException` / `unhandledRejection` handlers that turn
 * all three into a non-event: restore the terminal, write a crash log, tell the
 * user their work is safe and exactly how to get back to it, then exit cleanly.
 *
 * It is deliberately NOT a way to keep running through errors — a process whose
 * invariants just broke should stop. The guard makes stopping graceful, not
 * survivable.
 *
 * Everything is injected so the whole thing is testable without actually
 * crashing a process or owning a real TTY.
 */

export interface CrashContext {
  /** Restore the terminal to a sane state: show cursor, leave raw mode, etc.
   *  Must never throw — it runs on the crash path. */
  restoreTerminal: () => void;
  /** The active session so the user can be told their work is preserved and how
   *  to resume it. Returns null when there is no session yet (early crash). */
  sessionInfo: () => { id: string; path: string } | null;
  /** Persist the crash details somewhere durable. Returns the path written, or
   *  null if it couldn't be written (never throws). */
  writeCrashLog: (report: string) => string | null;
  /** Sink for the user-facing message. Defaults to process.stderr. */
  write?: (text: string) => void;
  /** Terminate the process. Defaults to process.exit. Injected for tests. */
  exit?: (code: number) => void;
  /** Wrap a line of user-facing text in an attention color. Defaults to identity
   *  (so tests assert on plain text and non-TTY output stays clean). */
  emphasize?: (text: string) => string;
}

export interface InstalledCrashGuard {
  /** Remove the handlers. Primarily for tests and clean shutdown. */
  uninstall: () => void;
  /** The handler itself, exposed so tests can drive it directly. */
  handle: (origin: 'uncaughtException' | 'unhandledRejection', err: unknown) => void;
}

/**
 * Build the crash-report body written to the log file. Kept pure so a test can
 * assert its shape without going through the filesystem.
 */
export function formatCrashReport(
  origin: string,
  err: unknown,
  sessionId: string | null,
  isoTimestamp: string,
): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return [
    `Bandit CLI crash report`,
    `time:    ${isoTimestamp}`,
    `origin:  ${origin}`,
    `session: ${sessionId ?? '(none)'}`,
    `message: ${e.message}`,
    '',
    'stack:',
    e.stack ?? '(no stack)',
    '',
  ].join('\n');
}

/**
 * Build the short, friendly message shown to the user on the terminal. Separate
 * from the log so the on-screen version stays scannable — the detail lives in
 * the file.
 */
export function formatUserMessage(
  err: unknown,
  session: { id: string; path: string } | null,
  logPath: string | null,
  emphasize: (t: string) => string,
): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines: string[] = [
    '',
    emphasize('✗ Bandit hit an unexpected error and has to stop.'),
    `  ${message}`,
    '',
  ];
  if (session) {
    // The reassurance is the point: the user's conversation is on disk, and the
    // resume command is right here so they don't have to hunt for the id.
    lines.push('  Your conversation is saved. Pick up where you left off with:');
    lines.push(`    bandit --resume ${session.id}`);
    lines.push('');
  }
  if (logPath) {
    lines.push(`  Crash details written to: ${logPath}`);
    lines.push('  If this keeps happening, that file is what to attach to a bug report.');
  } else {
    lines.push('  (Could not write a crash log — please note the error above for a bug report.)');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Install the crash guard. Returns a handle for uninstalling and for driving
 * the handler directly in tests.
 */
export function installCrashGuard(ctx: CrashContext): InstalledCrashGuard {
  const write = ctx.write ?? ((t: string) => process.stderr.write(t));
  const exit = ctx.exit ?? ((code: number) => process.exit(code));
  const emphasize = ctx.emphasize ?? ((t: string) => t);

  // Re-entrancy guard. If the terminal restore or log write themselves throw,
  // the handler must not recurse into itself and spin — one crash, one report,
  // one exit.
  let handling = false;

  const handle = (origin: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
    if (handling) {return;}
    handling = true;

    // Terminal first, and defensively — everything after this wants a usable
    // screen, and this is the single most important thing to get done.
    try { ctx.restoreTerminal(); } catch { /* nothing more we can do about the terminal */ }

    let session: { id: string; path: string } | null = null;
    try { session = ctx.sessionInfo(); } catch { session = null; }

    let logPath: string | null = null;
    try {
      const stamp = new Date().toISOString();
      logPath = ctx.writeCrashLog(formatCrashReport(origin, err, session?.id ?? null, stamp));
    } catch { logPath = null; }

    try {
      write(formatUserMessage(err, session, logPath, emphasize));
    } catch { /* stderr itself is gone — nothing left to do */ }

    exit(1);
  };

  const onUncaught = (err: unknown): void => handle('uncaughtException', err);
  const onRejection = (reason: unknown): void => handle('unhandledRejection', reason);

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return {
    uninstall: () => {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
    },
    handle,
  };
}
