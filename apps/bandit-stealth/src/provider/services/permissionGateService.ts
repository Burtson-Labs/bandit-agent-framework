/**
 * `PermissionGateService` owns the in-chat permission card lifecycle:
 * inject the card into the assistant entry, post the
 * `permissionRequest` event to the webview, hold the resolver until
 * the user clicks, and replace the live card with a resolved summary
 * once they do.
 *
 * Pre-extraction (≤ v1.7.349) this was `requestPermissionInChat` on
 * `BanditStealthViewProvider` plus a `pendingPermissions` Map field.
 * Pulling it out lets the card injection + resolution flow be unit-
 * tested without instantiating the provider, and removes another ~50
 * lines from the class.
 *
 * NOT in this service: the `SessionPermissionStore` allow-list
 * (`ctx.permissions`) and the `grant()` calls that promote a one-time
 * approval into a session/saved policy. That logic stays at the
 * decision site in `performToolUseCompletion` because it's coupled
 * to the choice-handling branch inside the tool loop, not to the
 * card-injection mechanic this service owns.
 */
import * as vscode from 'vscode';
import {
  buildPermissionCardPayload,
  buildResolvedPermissionMarker,
  stripLiveStatusMarkers,
  type PermissionChoice,
  type PermissionRequestInfo
} from '../../helpers/permission';
import type { ConversationEntry } from '../../services/conversationTypes';
import type { ProviderContext } from '../context';

type PermissionResolver = (choice: PermissionChoice, notes?: string) => void;

export interface PermissionGateRequest extends PermissionRequestInfo {
  /** The assistant entry the card gets injected into. The service
   *  mutates `content` and `payload` in-place — both at injection
   *  time (append the card fence) and at resolution time (replace
   *  the fence with the resolved-summary marker). The caller is
   *  responsible for `syncState()` propagation outside the
   *  inject/resolve windows. */
  assistantEntry: ConversationEntry;
}

export interface PermissionGateResult {
  choice: PermissionChoice;
  notes?: string;
}

export class PermissionGateService {
  private readonly pending = new Map<string, PermissionResolver>();

  constructor(private readonly ctx: ProviderContext) {}

  /** In-flight request count. Primarily used by tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Inject a permission card into `req.assistantEntry`, fire the
   * `permissionRequest` event to the webview, and return a Promise
   * that resolves once the webview posts back via `respond()`. On
   * resolution the card fence is replaced in-place with a resolved-
   * summary marker so the conversation history stays clean.
   *
   * Each request gets a unique `perm-{base36ts}-{rand4}` id; two
   * concurrent requests for the same tool+primary still produce two
   * independent pending entries. Per-turn dedup (so a model asking
   * twice in one iteration shares one card) lives at the call site,
   * not here — this service is the mechanism, not the policy.
   */
  request(req: PermissionGateRequest): Promise<PermissionGateResult> {
    const id = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = buildPermissionCardPayload(id, req);

    req.assistantEntry.content = stripLiveStatusMarkers(req.assistantEntry.content);
    const marker = `\n\n\`\`\`bandit-permission\n${JSON.stringify(payload)}\n\`\`\`\n`;
    req.assistantEntry.content += marker;
    req.assistantEntry.payload = req.assistantEntry.content;
    console.info(`[bandit] permission card injected: id=${id} tool=${req.tool} primary=${req.primary}`);
    void this.ctx.syncState();
    this.ctx.postMessage({
      type: 'permissionRequest',
      id,
      tool: req.tool,
      primary: req.primary,
      description: req.description,
      bodyPreview: req.bodyPreview,
      risk: req.risk,
      warning: req.warning,
      diffStats: req.diffStats,
      command: req.command,
      paramsPreview: req.paramsPreview
    });

    return new Promise<PermissionGateResult>((resolvePromise) => {
      this.pending.set(id, (choice, notes) => {
        this.pending.delete(id);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const resolvedMarker = buildResolvedPermissionMarker(req.tool, req.primary, choice, notes, workspaceRoot);
        req.assistantEntry.content = req.assistantEntry.content.replace(marker, resolvedMarker);
        req.assistantEntry.payload = req.assistantEntry.content;
        void this.ctx.syncState();
        resolvePromise({ choice, notes });
      });
    });
  }

  /**
   * Webview bridge — called by `handleMessage` on `permissionResponse`.
   * Looks up the pending resolver for `id` and fires it. No-op if the
   * id has no pending request (already resolved, or the webview
   * posted a stale id after a reload). The resolver itself removes
   * the entry from `pending` before settling the Promise.
   */
  respond(id: string, choice: PermissionChoice, notes?: string): void {
    const resolver = this.pending.get(id);
    if (resolver) {resolver(choice, notes);}
  }
}
