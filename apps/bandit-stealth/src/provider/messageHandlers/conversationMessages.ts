/**
 * Conversation lifecycle message handlers — select / delete / archive
 * / clear / clear-all / start-new / show-history / request-clear-all.
 *
 * These all share the same loop-side cleanup (cancel any active
 * stream + reset busy state immediately without firing events) and
 * then dispatch into `ctx.conversations`. The eight `handleX`
 * functions map 1:1 to the `IncomingMessage` types that drive them;
 * `openHistoryView` is the shared cleanup primitive that several of
 * them invoke when the current conversation goes away.
 *
 * Why `resetBusyImmediate` is a deps callback: the existing provider
 * code sets `isBusy = false` + `statusText = 'Ready'` *without* going
 * through `setBusy()`, which intentionally skips the
 * `onDidChangeStatus` emit + `syncState` round-trip. The handlers
 * preserve that behavior to avoid an unnecessary status-bar tick on
 * every conversation switch. Phase E can audit whether the round-trip
 * is actually wanted.
 */
import * as vscode from 'vscode';
import type { IncomingMessage } from '../../messages';
import type { ProviderContext } from '../context';

export interface ConversationMessageDeps {
  /** Abort any in-flight stream / tool-loop turn before swapping
   *  conversations. */
  cancelActiveStream(): void;
  /** Set provider's busy=false + statusText='Ready' WITHOUT firing
   *  `onDidChangeStatus` (preserves pre-extraction behavior — see
   *  module doc-comment). */
  resetBusyImmediate(): void;
  /** Set provider's `historyVisible` flag directly (no event). */
  setHistoryVisibleImmediate(value: boolean): void;
  /** Read `historyVisible` from the provider. */
  isHistoryVisible(): boolean;
  /** Clear the active-conversation pointer without creating a new
   *  one. Preserves the pre-extraction behavior of "show the history
   *  list, don't open a conversation". `ctx.conversations.updateMessages([])`
   *  would inadvertently create a new conversation via `ensureActive`. */
  clearActiveConversationPointer(): void;
}

export async function handleClearConversation(
  ctx: ProviderContext,
  deps: ConversationMessageDeps
): Promise<void> {
  deps.cancelActiveStream();
  deps.resetBusyImmediate();
  ctx.intent.reset();
  await ctx.diffPreviews.clearSessions();
  if (!ctx.conversations.currentId) {
    await openHistoryView(ctx, deps, { clearActive: true });
    return;
  }
  const current = ctx.conversations.ensureActive();
  current.archived = false;
  await ctx.conversations.updateMessages([]);
  await ctx.syncState();
}

export async function handleClearAllConversations(
  ctx: ProviderContext,
  deps: ConversationMessageDeps
): Promise<void> {
  deps.cancelActiveStream();
  deps.resetBusyImmediate();
  ctx.intent.reset();
  await ctx.diffPreviews.clearSessions();
  await ctx.conversations.clearAll();
  await ctx.syncState();
  // silent — the chat feed visibly empties.
}

export async function handleRequestClearAll(
  ctx: ProviderContext,
  deps: ConversationMessageDeps
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Clear all Bandit Stealth conversations? This action cannot be undone.',
    { modal: true },
    'Clear conversations'
  );
  if (choice === 'Clear conversations') {
    await handleClearAllConversations(ctx, deps);
  }
}

export async function handleStartNewConversation(
  ctx: ProviderContext,
  deps: ConversationMessageDeps
): Promise<void> {
  deps.cancelActiveStream();
  deps.resetBusyImmediate();
  await ctx.conversations.startNew();
  await ctx.syncState();
}

export async function handleSelectConversation(
  ctx: ProviderContext,
  deps: ConversationMessageDeps,
  id: string
): Promise<void> {
  if (ctx.conversations.currentId === id) {
    await ctx.syncState();
    return;
  }
  deps.cancelActiveStream();
  deps.resetBusyImmediate();
  await ctx.conversations.select(id);
  await ctx.syncState();
}

export async function handleDeleteConversation(
  ctx: ProviderContext,
  deps: ConversationMessageDeps,
  id: string
): Promise<void> {
  const wasCurrent = ctx.conversations.currentId === id;
  await ctx.conversations.remove(id);
  if (wasCurrent) {
    await openHistoryView(ctx, deps, { clearActive: true });
    return;
  }
  // Sets statusText only — preserves the pre-extraction behavior of
  // updating the text without firing the busy event.
  deps.resetBusyImmediate();
  await ctx.syncState();
}

export async function handleArchiveConversation(
  ctx: ProviderContext,
  deps: ConversationMessageDeps,
  id: string,
  archived: boolean
): Promise<void> {
  await ctx.conversations.setArchived(id, archived);

  if (archived && ctx.conversations.currentId === id) {
    await openHistoryView(ctx, deps, { skipPersist: true, clearActive: true });
    return;
  }

  if (!archived && ctx.conversations.currentId === id) {
    deps.setHistoryVisibleImmediate(false);
  }

  await ctx.syncState();
}

export async function handleShowHistory(
  ctx: ProviderContext,
  deps: ConversationMessageDeps,
  value: boolean
): Promise<void> {
  if (value) {
    await openHistoryView(ctx, deps);
    return;
  }
  if (deps.isHistoryVisible()) {
    deps.setHistoryVisibleImmediate(false);
    await ctx.syncState();
  }
}

/**
 * Topic dispatcher — returns `true` if the message was a conversation
 * lifecycle message (and was handled), `false` otherwise. Lets the
 * provider's `handleMessage` collapse 8 if-blocks into one chain link.
 */
export async function dispatchConversationMessage(
  ctx: ProviderContext,
  deps: ConversationMessageDeps,
  message: IncomingMessage
): Promise<boolean> {
  switch (message.type) {
    case 'clearConversation':
      await handleClearConversation(ctx, deps);
      return true;
    case 'startNewConversation':
      await handleStartNewConversation(ctx, deps);
      return true;
    case 'selectConversation':
      await handleSelectConversation(ctx, deps, message.id);
      return true;
    case 'deleteConversation':
      await handleDeleteConversation(ctx, deps, message.id);
      return true;
    case 'archiveConversation':
      await handleArchiveConversation(ctx, deps, message.id, message.archived);
      return true;
    case 'showHistory':
      await handleShowHistory(ctx, deps, message.value);
      return true;
    case 'clearAllConversations':
      await handleClearAllConversations(ctx, deps);
      return true;
    case 'requestClearAll':
      await handleRequestClearAll(ctx, deps);
      return true;
    default:
      return false;
  }
}

export async function openHistoryView(
  ctx: ProviderContext,
  deps: ConversationMessageDeps,
  options?: { skipPersist?: boolean; clearActive?: boolean }
): Promise<void> {
  deps.cancelActiveStream();
  deps.resetBusyImmediate();
  deps.setHistoryVisibleImmediate(true);
  await ctx.diffPreviews.clearSessions();
  if (options?.clearActive) {
    deps.clearActiveConversationPointer();
  }
  // `skipPersist` branch is preserved for parity with the
  // pre-extraction signature even though `persistConversationHistory`
  // on the provider is now a no-op stub (ConversationService persists
  // internally). When the legacy stub is finally removed we can drop
  // the skipPersist option too.
  void options?.skipPersist;
  await ctx.syncState();
}
