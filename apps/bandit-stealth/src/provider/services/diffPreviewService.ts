/**
 * `DiffPreviewService` owns the agent-edit diff-preview surface:
 * extract preview records from an `AgentReport`, queue them as
 * pending, open inline + side-by-side editor tabs the user can
 * approve / explain / discard, and restore originals from backup on
 * discard.
 *
 * Pre-extraction (≤ v1.7.349) this was 14 private methods + 2 fields
 * (~340 LOC) tangled into `BanditStealthViewProvider`. Pulling it out
 * lets the apply / discard / restore lifecycle be reasoned about in
 * one place, leaves the provider to handle dispatch + lifecycle, and
 * keeps file-backup state with its consumer.
 *
 * NOT in this service: `handleUndoAgentChange`. That handler is
 * about the general file-change undo manager (any tool-edit can be
 * undone), not about the diff-preview lifecycle this service owns.
 * Stays on the provider with the `undo` accessor.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentReport } from '@burtson-labs/stealth-core-runtime';
import type { AgentDiffPreview, DiffPreviewSession, FeedbackRequest } from '../../agentTypes';
import { truncateDiff } from '../../helpers/formatting';
import type { ProviderContext } from '../context';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

export interface DiffPreviewServiceDeps {
  /** Provider-side hook that POSTs feedback to the bandit endpoint
   *  with a completions fallback. Lives on the provider because the
   *  feedback pipeline (which depends on it) hasn't been extracted
   *  yet; once that service lands, this can move to `ctx`. */
  sendFeedback(payload: FeedbackRequest, configuration: vscode.WorkspaceConfiguration): Promise<void>;
}

export class DiffPreviewService {
  private pending: AgentDiffPreview[] = [];
  private readonly sessions = new Map<string, DiffPreviewSession>();

  constructor(private readonly ctx: ProviderContext, private readonly deps: DiffPreviewServiceDeps) {}

  /** Active session count — used by tests and diagnostics. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Pending preview list snapshot — used by tests. */
  get pendingPreviews(): AgentDiffPreview[] {
    return [...this.pending];
  }

  /**
   * Build diff previews from an `AgentReport`, replace the pending
   * list, dispose existing sessions, and post a `diffPreviewCard`
   * event per preview so the webview renders the apply/explain/
   * discard chips.
   *
   * No-ops when no workspace is open (no place to anchor backups) or
   * the report carries no diffs. Called from the agent's success
   * path in `startAgentGoal`.
   */
  async presentFromReport(report: AgentReport): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolder) {
      return;
    }
    const previews = this.extractDiffPreviews(report);
    if (previews.length === 0) {
      return;
    }
    this.pending = previews;
    await this.clearSessions();

    for (const preview of previews) {
      this.sessions.set(preview.path, { preview, workspaceFolder });
      this.ctx.postMessage({
        type: 'diffPreviewCard',
        preview: {
          path: preview.path,
          hasBackup: Boolean(preview.backupPath)
        }
      });
    }
  }

  /**
   * Webview bridge — user clicked apply / explain / discard on a
   * diff card.
   *
   * - `apply`: keep the edited file as-is, post feedback, clean up
   *   the backup blob.
   * - `explain`: prime the composer with "Explain the proposed
   *   updates made to <path>" and post feedback. The user still has
   *   to send the prompt; the edited file isn't reverted.
   * - `discard`: restore the file from backup (if one exists), then
   *   post feedback. After restore the backup file is deleted.
   *
   * Posts a `diffPreviewResult` event in every terminal state — the
   * webview consumes it to remove the card from the chat.
   */
  async handleAction(message: { path: string; action: 'apply' | 'explain' | 'discard' }): Promise<void> {
    const session = this.sessions.get(message.path);
    if (!session) {
      this.ctx.postMessage({
        type: 'diffPreviewResult',
        path: message.path,
        status: 'error',
        message: 'Change preview is no longer available.'
      });
      return;
    }
    const { preview, workspaceFolder } = session;
    try {
      switch (message.action) {
        case 'apply':
          await this.submitFeedback(preview, 'apply');
          await this.cleanupBackup(preview, workspaceFolder);
          this.ctx.postMessage({ type: 'diffPreviewResult', path: message.path, status: 'apply' });
          this.sessions.delete(message.path);
          await this.disposeSession(session);
          break;
        case 'explain':
          await this.ctx.setPendingPrompt(`Explain the proposed updates made to ${preview.path}.`);
          await this.submitFeedback(preview, 'explain');
          await this.cleanupBackup(preview, workspaceFolder);
          this.ctx.postMessage({ type: 'diffPreviewResult', path: message.path, status: 'explain' });
          this.sessions.delete(message.path);
          await this.disposeSession(session);
          break;
        case 'discard':
          if (preview.backupPath) {
            await this.restoreFromBackup(preview, workspaceFolder);
          }
          await this.submitFeedback(preview, 'discard');
          this.ctx.postMessage({ type: 'diffPreviewResult', path: message.path, status: 'discard' });
          this.sessions.delete(message.path);
          await this.disposeSession(session);
          break;
        default:
          this.ctx.postMessage({
            type: 'diffPreviewResult',
            path: message.path,
            status: 'error',
            message: 'Unsupported action.'
          });
          return;
      }
    } catch (error) {
      this.ctx.postMessage({
        type: 'diffPreviewResult',
        path: message.path,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Close and release every active diff-preview session. Called from
   * the conversation-clear flows (clearCurrent, clearAll, history
   * switch) so opening a fresh chat doesn't carry orphan editor tabs.
   * Posts `diffPreviewClear` so the webview drops any remaining
   * cards.
   */
  async clearSessions(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.disposeSession(session)));
    this.ctx.postMessage({ type: 'diffPreviewClear' });
  }

  /**
   * Open the diff preview tabs for a single preview: an inline
   * markdown view of the unified diff plus (when a backup exists)
   * a side-by-side editor diff against the backup. Returns the URIs
   * the session record needs to track so `disposeSession` can close
   * them later.
   */
  async openPreview(
    preview: AgentDiffPreview,
    workspaceFolder: vscode.Uri
  ): Promise<{ inlineUri?: vscode.Uri; diffInput?: { original: vscode.Uri; modified: vscode.Uri } }> {
    const inlineUri = this.ctx.diffContentProvider.registerDiff(preview.path, preview.diff);
    const inlineDocument = await vscode.workspace.openTextDocument(inlineUri);
    await vscode.languages.setTextDocumentLanguage(inlineDocument, 'markdown');
    await vscode.window.showTextDocument(inlineDocument, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside
    });

    if (!preview.backupPath) {
      return { inlineUri };
    }

    const originalUri = this.resolveWorkspacePath(workspaceFolder, preview.backupPath);
    const currentUri = this.resolveWorkspacePath(workspaceFolder, preview.path);
    try {
      await vscode.workspace.fs.stat(originalUri);
    } catch {
      throw new Error('Original backup not found.');
    }
    await vscode.commands.executeCommand('vscode.diff', originalUri, currentUri, `${preview.path} — Bandit changes`);
    return {
      inlineUri,
      diffInput: {
        original: originalUri,
        modified: currentUri
      }
    };
  }

  // ── private helpers ────────────────────────────────────────────────

  private extractPathFromOutput(output: string | undefined): string | undefined {
    if (!output) {
      return undefined;
    }
    const match = output.match(/Wrote\s+(.+)/i);
    return match ? match[1].trim() : undefined;
  }

  private extractDiffPreviews(report: AgentReport): AgentDiffPreview[] {
    if (!Array.isArray(report.results)) {
      return [];
    }
    const previews: AgentDiffPreview[] = [];
    for (const result of report.results) {
      const data = result.data as { diff?: unknown; backupPath?: unknown; backupContent?: unknown; path?: unknown } | undefined;
      const diff = typeof data?.diff === 'string' ? data.diff : undefined;
      const path = typeof data?.path === 'string' ? data.path : this.extractPathFromOutput(result.output);
      if (!diff || !path) {
        continue;
      }
      const backupPath = typeof data?.backupPath === 'string' ? data.backupPath : undefined;
      const backupContent = typeof data?.backupContent === 'string' ? data.backupContent : undefined;
      previews.push({ path, diff, backupPath, backupContent });
      const extras = Array.isArray((data as { additionalWrites?: unknown })?.additionalWrites)
        ? (data as { additionalWrites?: unknown }).additionalWrites
        : [];
      for (const extra of extras as Array<{ path?: unknown; diff?: unknown }>) {
        if (!extra || typeof extra.path !== 'string' || typeof extra.diff !== 'string') {
          continue;
        }
        previews.push({ path: extra.path, diff: extra.diff, backupPath: undefined, backupContent: undefined });
      }
    }
    return previews;
  }

  private async disposeSession(session: DiffPreviewSession): Promise<void> {
    const tabsToClose: vscode.Tab[] = [];
    const inlineUri = session.inlineUri?.toString();
    const diffOriginal = session.diffInput?.original.toString();
    const diffModified = session.diffInput?.modified.toString();

    if (inlineUri || (diffOriginal && diffModified)) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (inlineUri && input instanceof vscode.TabInputText && input.uri.toString() === inlineUri) {
            tabsToClose.push(tab);
            continue;
          }
          if (
            diffOriginal &&
            diffModified &&
            input instanceof vscode.TabInputTextDiff &&
            input.original.toString() === diffOriginal &&
            input.modified.toString() === diffModified
          ) {
            tabsToClose.push(tab);
          }
        }
      }
    }

    for (const tab of tabsToClose) {
      try {
        await vscode.window.tabGroups.close(tab);
      } catch {
        // ignore failures closing editors
      }
    }

    if (session.inlineUri) {
      this.ctx.diffContentProvider.release(session.inlineUri);
    }
  }

  private async submitFeedback(preview: AgentDiffPreview, decision: 'apply' | 'explain' | 'discard'): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const description = [
      `File: ${preview.path}`,
      `Decision: ${decision}`,
      'Diff snippet:',
      truncateDiff(preview.diff, 120)
    ].join('\n\n');

    const payload: FeedbackRequest = {
      title: `Diff review — ${decision}`,
      description,
      category: decision === 'apply' ? 'feature' : decision === 'discard' ? 'bug' : 'improvement',
      priority: decision === 'discard' ? 'critical' : decision === 'explain' ? 'medium' : 'medium',
      annoyanceLevel: decision === 'discard' ? 10 : decision === 'explain' ? 4 : 3,
      sessionInfo: { conversationId: this.ctx.conversations.currentId }
    };

    await this.deps.sendFeedback(payload, configuration);
  }

  private async restoreFromBackup(preview: AgentDiffPreview, workspaceFolder: vscode.Uri): Promise<void> {
    if (!preview.backupPath && typeof preview.backupContent !== 'string') {
      void vscode.window.showWarningMessage(`No backup available for ${preview.path}.`);
      return;
    }
    const targetUri = this.resolveWorkspacePath(workspaceFolder, preview.path);
    const backupUri = preview.backupPath ? this.resolveWorkspacePath(workspaceFolder, preview.backupPath) : undefined;
    try {
      const contentBuffer =
        backupUri
          ? await vscode.workspace.fs.readFile(backupUri)
          : utf8Encoder.encode(preview.backupContent ?? '');
      const restoredViaEditor = await this.replaceDocumentContents(targetUri, contentBuffer);
      if (!restoredViaEditor) {
        await vscode.workspace.fs.writeFile(targetUri, contentBuffer);
      }
      const current = await vscode.workspace.fs.readFile(targetUri);
      if (!Buffer.from(current).equals(Buffer.from(contentBuffer))) {
        throw new Error('Unable to restore original file contents.');
      }
      if (backupUri) {
        await this.deleteBackupFile(backupUri);
      }
      void vscode.window.showInformationMessage(`Restored ${preview.path} from backup.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to restore ${preview.path}: ${message}`);
      throw error;
    }
  }

  private async replaceDocumentContents(targetUri: vscode.Uri, content: Uint8Array): Promise<boolean> {
    try {
      const document = await vscode.workspace.openTextDocument(targetUri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange =
        document.lineCount > 0
          ? new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end)
          : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
      edit.replace(targetUri, fullRange, utf8Decoder.decode(content));
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        const saved = await document.save();
        if (!saved) {
          await vscode.workspace.fs.writeFile(targetUri, content);
        }
        return true;
      }
    } catch {
      // fall through to filesystem write
    }
    try {
      await vscode.workspace.fs.writeFile(targetUri, content);
      await this.revertVisibleEditors(targetUri);
    } catch {
      return false;
    }
    return true;
  }

  private async deleteBackupFile(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
    } catch {
      // ignore cleanup failures
    }
  }

  private async cleanupBackup(preview: AgentDiffPreview, workspaceFolder: vscode.Uri): Promise<void> {
    if (!preview.backupPath) {
      return;
    }
    const backupUri = this.resolveWorkspacePath(workspaceFolder, preview.backupPath);
    await this.deleteBackupFile(backupUri);
  }

  private resolveWorkspacePath(workspaceFolder: vscode.Uri, relativePath: string): vscode.Uri {
    if (path.isAbsolute(relativePath)) {
      return vscode.Uri.file(relativePath);
    }
    const resolved = path.resolve(workspaceFolder.fsPath, relativePath);
    return vscode.Uri.file(resolved);
  }

  private async revertVisibleEditors(targetUri: vscode.Uri): Promise<void> {
    const targetKey = targetUri.toString();
    const matchingEditors = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === targetKey
    );
    if (!matchingEditors.length) {
      return;
    }
    const previous = vscode.window.activeTextEditor;
    for (const editor of matchingEditors) {
      await vscode.window.showTextDocument(editor.document, { preview: false, preserveFocus: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    if (previous && !matchingEditors.includes(previous)) {
      await vscode.window.showTextDocument(previous.document, { preview: false, preserveFocus: true });
    }
  }
}
