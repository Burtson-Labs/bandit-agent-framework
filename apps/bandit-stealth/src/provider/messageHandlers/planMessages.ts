/**
 * Plan-step / undo / diff-preview message handlers — the four
 * webview messages that drive the plan-card UI:
 *
 * - `replayPlanStep` → re-execute a plan step verbatim
 * - `refinePlanStep` → re-execute with the user's refinement note
 * - `diffPreviewAction` → apply/explain/discard a queued diff card
 * - `undoAgentChange` → pop the last file-change snapshot off the
 *   undo stack (decoupled from the diff-preview lifecycle — works
 *   for ANY tool edit, not just those that produced a preview card)
 *
 * `replayStep` isn't on `ProviderContext` because the agent runtime
 * isn't a service the interface currently exposes — it lands here
 * as a deps callback rather than widening the interface for a
 * single-shot reach. The same is true for the `undoSnapshotsAvailable`
 * flag on the provider, which is set inside the undo `finally`.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { IncomingMessage } from '../../messages';
import type { ProviderContext } from '../context';
import type { FileChangeSnapshot } from '../../agent/agentRuntime';

export interface PlanMessageDeps {
  /** Re-execute a plan step. Mode='replay' runs it verbatim,
   *  'refine' lets the agent rewrite the step against the user's
   *  refinement note. Routes through the agent runtime. */
  replayPlanStep(stepId: string, mode: 'replay' | 'refine'): Promise<void>;
  /** Set provider's `undoSnapshotsAvailable` flag directly. The
   *  pre-extraction code sets this in a `finally` so the undo button
   *  re-disables itself the instant the stack drains, regardless of
   *  whether the undo itself succeeded. Preserve that
   *  finally-write semantic. */
  setUndoSnapshotsAvailable(value: boolean): void;
}

export async function handleReplayPlanStep(
  ctx: ProviderContext,
  id: string,
  deps: PlanMessageDeps
): Promise<void> {
  void ctx;
  await deps.replayPlanStep(id, 'replay');
}

export async function handleRefinePlanStep(
  ctx: ProviderContext,
  id: string,
  deps: PlanMessageDeps
): Promise<void> {
  void ctx;
  await deps.replayPlanStep(id, 'refine');
}

export async function handleDiffPreviewAction(
  message: Extract<IncomingMessage, { type: 'diffPreviewAction' }>,
  ctx: ProviderContext
): Promise<void> {
  await ctx.diffPreviews.handleAction(message);
}

/**
 * Topic dispatcher — returns `true` if the message belongs to the
 * plan / diff-preview / undo cluster (and was handled), `false`
 * otherwise. Collapses 4 if-blocks in the provider's `handleMessage`.
 */
export async function dispatchPlanMessage(
  ctx: ProviderContext,
  deps: PlanMessageDeps,
  message: IncomingMessage
): Promise<boolean> {
  switch (message.type) {
    case 'replayPlanStep':
      await handleReplayPlanStep(ctx, message.id, deps);
      return true;
    case 'refinePlanStep':
      await handleRefinePlanStep(ctx, message.id, deps);
      return true;
    case 'diffPreviewAction':
      await handleDiffPreviewAction(message, ctx);
      return true;
    case 'undoAgentChange':
      await handleUndoAgentChange(ctx, deps);
      return true;
    default:
      return false;
  }
}

export async function handleUndoAgentChange(
  ctx: ProviderContext,
  deps: PlanMessageDeps
): Promise<void> {
  let snapshot: FileChangeSnapshot | null = null;
  try {
    snapshot = await ctx.undo.undoLastChange();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Undo failed: ${detail}`);
    ctx.postMessage({ type: 'notification', message: `Undo failed: ${detail}` });
    return;
  } finally {
    deps.setUndoSnapshotsAvailable(ctx.undo.hasSnapshots());
  }

  if (!snapshot) {
    // silent — the undo button disables itself when nothing's restorable.
    await ctx.syncState();
    return;
  }

  const label = snapshot.path || path.basename(snapshot.absolutePath);
  const message = snapshot.existedBefore
    ? `Reverted changes in ${label}`
    : `Removed ${label}`;
  // silent success — the file in the editor already reflects the undo.
  void vscode.window.showInformationMessage(message);
  await ctx.syncState();
}
