/**
 * `ToolCallDetailService` owns the per-runId tool-call detail cache
 * surfaced by click-to-open on bandit-tl / bandit-run cards.
 *
 * Two-tier storage: an in-memory LRU-style Map (bounded by `cap`) for
 * the hot path, plus a fire-and-forget disk write per capture so the
 * detail survives a VS Code reload. Disk reads are awaited only on
 * cache miss in `openInEditor`. Disk persistence lives in
 * `helpers/toolDetailStore.ts`; this service composes those shims
 * instead of re-implementing them.
 *
 * Pre-extraction (≤ v1.7.349) all of this lived as a Map field plus a
 * private method on `BanditStealthViewProvider`. Pulling it out trims
 * the provider by ~50 lines and lets the eviction policy + the
 * markdown render path be unit-tested without spinning up a webview.
 */
import * as vscode from 'vscode';
import { formatToolDetailMarkdown, type ToolCallDetail } from '../../helpers/toolDetail';
import { loadToolDetail, saveToolDetail, scheduleEvictionOnce } from '../../helpers/toolDetailStore';

export interface ToolCallDetailServiceOptions {
  /** Override the default 1000-entry in-memory cap. Tests use this to
   *  trigger eviction with only a handful of inserts; production
   *  always uses the default. Memory ceiling: cap × 64 KB worst case
   *  (each detail caps at 64 KB of output). */
  cap?: number;
}

export class ToolCallDetailService {
  /** The 200-entry default that shipped in v1.7.0 was hitting users in
   *  long agent sessions (60+ tool calls per turn × 5 turns = 300
   *  calls, so anything from the first turn was already expired);
   *  v1.7.339 bumped it to 1000. Cards from prior sessions recover via
   *  the disk store in `openInEditor`. */
  static readonly DEFAULT_CAP = 1000;

  private readonly details = new Map<string, ToolCallDetail>();
  private readonly cap: number;

  constructor(options: ToolCallDetailServiceOptions = {}) {
    this.cap = options.cap ?? ToolCallDetailService.DEFAULT_CAP;
  }

  /**
   * Record a tool-call detail captured at tool_result time. Inserts
   * into the in-memory Map (evicting the oldest entry if at cap) and
   * fires a best-effort disk write. The disk write is intentionally
   * not awaited — tool results must reach the chat panel without disk
   * I/O on the critical path; the store catches its own errors so a
   * write failure can't break the turn.
   *
   * No-ops if `runId` is empty (avoids polluting the Map with the
   * empty-string key, which would always be the eviction target on
   * the next insert).
   */
  capture(runId: string, detail: ToolCallDetail, workspaceRoot: string): void {
    if (!runId) {return;}
    if (this.details.size >= this.cap) {
      const oldestKey = this.details.keys().next().value;
      if (oldestKey !== undefined) {this.details.delete(oldestKey);}
    }
    this.details.set(runId, detail);
    if (workspaceRoot) {saveToolDetail(workspaceRoot, runId, detail);}
  }

  /** Direct accessor — primarily used by tests. */
  get(runId: string): ToolCallDetail | undefined {
    return this.details.get(runId);
  }

  /** Current Map size — primarily used by tests. */
  get size(): number {
    return this.details.size;
  }

  /**
   * Webview click handler: open the full IN/OUT for a runId in a
   * virtual markdown editor tab. Looks up the in-memory Map first,
   * then falls back to the on-disk store (which survives reloads and
   * in-memory eviction). On total miss, surfaces an info toast so the
   * user knows the detail genuinely expired rather than the click
   * silently failing.
   */
  async openInEditor(runId: string): Promise<void> {
    let detail = this.details.get(runId);
    if (!detail) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const fromDisk = await loadToolDetail(workspaceRoot, runId);
        if (fromDisk) {
          detail = fromDisk;
          this.details.set(runId, fromDisk);
          // Lazy disk-eviction sweep so the on-disk store stays
          // bounded. Guard inside the helper ensures only one sweep
          // per process, so a click storm doesn't trigger N sweeps.
          scheduleEvictionOnce(workspaceRoot);
        }
      }
    }
    if (!detail) {
      void vscode.window.showInformationMessage(
        'This tool-call detail has expired. The on-disk cache (up to 5000 entries) and in-memory cache (1000) didn\'t have it — likely from a much older session.'
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: formatToolDetailMarkdown(detail)
    });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
  }
}
