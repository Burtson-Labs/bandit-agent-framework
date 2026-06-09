/**
 * Bridge / utility message handlers — the grab-bag of webview
 * messages that don't fit any other category but share a shape
 * (mostly thin delegates over vscode API + a couple of services).
 *
 * - `runVscodeCommand` — invoke a `banditStealth.*` VS Code command
 *   from the webview. Strict allowlist: only commands whose id
 *   starts with `banditStealth.` are forwarded; everything else is
 *   silently dropped because the broader command surface
 *   (workbench.action.*, editor.action.*, etc.) is too dangerous to
 *   hand to the webview.
 * - `runShellCommand` — `!cmd` shell escape from the composer.
 *   Forwards to the integrated terminal. Reuses a named
 *   "Bandit · shell" terminal so successive `!` calls stack in the
 *   same scrollback rather than spawning a fresh terminal per call.
 *   Catastrophic patterns are refused inline (rm -rf, mkfs, dd if=)
 *   so a mistyped paste like `rm -rf /` won't run.
 * - `openFileFromDiff` / `openContextFile` — both routes through
 *   the same `openFileFromWorkspacePath` helper: workspace-relative
 *   path, leading slash strip, open in preview mode.
 * - `submitFeedback` — delegates to the provider's
 *   `handleFeedbackSubmission` because the feedback pipeline
 *   (conversation lookup, optimistic-then-finalize flow, network
 *   submit, fallback) is too coupled to the provider's chat state
 *   to extract into a service yet. Lands as a deps callback.
 * - `dismissIntent` / `dismissIntentSuggestions` — intent-card
 *   dismissal (one-shot vs "stop showing these"). The
 *   suggestions toggle writes the global config and re-syncs.
 * - `dismissBackgroundTask` / `cancelBackgroundTask` — thin
 *   delegates over `ctx.backgroundTasks`. Kept here because the
 *   message-side wiring is the same shape as the rest of this
 *   module; the actual lifecycle lives in the coordinator service.
 */
import * as vscode from 'vscode';
import type { IncomingMessage } from '../../messages';
import type { ProviderContext } from '../context';
import type { FeedbackRating } from '../../services/conversationTypes';

export interface BridgeMessageDeps {
  /** Submit a feedback rating for an assistant message. The
   *  pipeline (conversation lookup, optimistic-then-finalize flow,
   *  network submit + fallback) lives on the provider; this is a
   *  deps callback rather than a ProviderContext slot because the
   *  feedback service hasn't been extracted yet. */
  submitFeedback(messageId: string, rating: FeedbackRating): Promise<void>;
}

const SHELL_BLOCKED_PATTERNS = [
  /rm\s+-rf/,
  /rmdir\s+\//,
  /\bmkfs\b/,
  /dd\s+if=/
];
const SHELL_TERMINAL_NAME = 'Bandit · shell';

export function handleRunVscodeCommand(
  message: Extract<IncomingMessage, { type: 'runVscodeCommand' }>
): void {
  // Allowlist: only banditStealth.* commands. The webview can't
  // invoke arbitrary VS Code commands (workbench.action.*,
  // editor.action.*, etc.) — that surface is too broad.
  if (typeof message.command === 'string' && message.command.startsWith('banditStealth.')) {
    void vscode.commands.executeCommand(message.command);
  }
}

export function handleRunShellCommand(
  message: Extract<IncomingMessage, { type: 'runShellCommand' }>
): void {
  // !-prefix shell escape — user typed `!cmd` in the composer to
  // run something straight in the integrated terminal (interactive
  // scaffolders, ad-hoc commands, anything the agent's allow-list
  // would block). Catastrophic patterns mirror the CLI's blocked
  // set so a mistyped paste like `rm -rf /` still gets refused
  // here. The agent does not see the output; this is purely a
  // user-invoked command.
  if (typeof message.command !== 'string') {return;}
  const bashCmd = message.command.trim();
  if (!bashCmd) {return;}
  const blocked = SHELL_BLOCKED_PATTERNS.find((re) => re.test(bashCmd));
  if (blocked) {
    void vscode.window.showErrorMessage(
      `Refusing to run \`${bashCmd}\` — matches blocked pattern \`${blocked.source}\`. Run it from a terminal directly if you really mean it.`
    );
    return;
  }
  try {
    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
    // Reuse our named terminal so successive `!` calls stack in
    // the same scrollback rather than spawning a fresh terminal
    // per call. Created on first use.
    let terminal = vscode.window.terminals.find((t) => t.name === SHELL_TERMINAL_NAME);
    if (!terminal) {
      terminal = vscode.window.createTerminal({ name: SHELL_TERMINAL_NAME, cwd });
    }
    terminal.show(false);
    terminal.sendText(bashCmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Shell command failed to launch: ${msg}`);
  }
}

export async function handleOpenFileFromDiff(
  ctx: ProviderContext,
  relativePath: string
): Promise<void> {
  await openFileFromWorkspacePath(ctx, relativePath);
}

export async function handleOpenContextFile(
  ctx: ProviderContext,
  relativePath: string
): Promise<void> {
  await openFileFromWorkspacePath(ctx, relativePath);
}

async function openFileFromWorkspacePath(
  ctx: ProviderContext,
  relativePath: string
): Promise<void> {
  const normalized = typeof relativePath === 'string' ? relativePath.trim() : '';
  if (!normalized) {
    ctx.postMessage({ type: 'notification', message: 'Diff path unavailable.' });
    return;
  }
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    ctx.postMessage({ type: 'notification', message: 'Open a workspace to preview diffs.' });
    return;
  }
  const cleaned = normalized.replace(/^[\\/]+/, '');
  const target = vscode.Uri.joinPath(workspace.uri, cleaned);
  try {
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: true });
  } catch (error) {
    console.warn('Unable to open diff path', cleaned, error);
    ctx.postMessage({ type: 'notification', message: `Unable to open ${normalized}.` });
  }
}

export async function handleSubmitFeedback(
  ctx: ProviderContext,
  deps: BridgeMessageDeps,
  messageId: string,
  rating: FeedbackRating
): Promise<void> {
  void ctx;
  await deps.submitFeedback(messageId, rating);
}

export async function handleDismissIntent(ctx: ProviderContext): Promise<void> {
  await ctx.intent.dismiss();
}

export async function handleDismissIntentSuggestions(ctx: ProviderContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  await configuration.update('intent.showSuggestions', false, vscode.ConfigurationTarget.Global);
  // silent — toggling visibility is self-evident in the UI.
  await ctx.syncState();
}

export function handleCancelBackgroundTask(ctx: ProviderContext, taskId: string): void {
  ctx.backgroundTasks.cancel(taskId);
}

export function handleDismissBackgroundTask(ctx: ProviderContext, taskId: string): void {
  ctx.backgroundTasks.dismiss(taskId);
}

/**
 * Topic dispatcher — returns `true` if the message belongs to the
 * bridge / utility cluster (and was handled), `false` otherwise.
 * Collapses 10 if-blocks in the provider's `handleMessage`.
 */
export async function dispatchBridgeMessage(
  ctx: ProviderContext,
  deps: BridgeMessageDeps,
  message: IncomingMessage
): Promise<boolean> {
  switch (message.type) {
    case 'runVscodeCommand':
      handleRunVscodeCommand(message);
      return true;
    case 'runShellCommand':
      handleRunShellCommand(message);
      return true;
    case 'openFileFromDiff':
      await handleOpenFileFromDiff(ctx, message.path);
      return true;
    case 'openContextFile':
      await handleOpenContextFile(ctx, message.path);
      return true;
    case 'submitFeedback':
      await handleSubmitFeedback(ctx, deps, message.messageId, message.rating);
      return true;
    case 'dismissIntent':
      await handleDismissIntent(ctx);
      return true;
    case 'dismissIntentSuggestions':
      await handleDismissIntentSuggestions(ctx);
      return true;
    case 'cancelBackgroundTask':
      handleCancelBackgroundTask(ctx, message.taskId);
      return true;
    case 'dismissBackgroundTask':
      handleDismissBackgroundTask(ctx, message.taskId);
      return true;
    default:
      return false;
  }
}
