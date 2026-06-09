/**
 * Trace-viewer message handlers — `requestTraceList`,
 * `requestTraceDetail`, `openTraceFile`. Each posts back one of
 * `traceList` / `traceDetail` / `traceError` (or `notification` for
 * the empty-path guard on `openTraceFile`).
 *
 * The handlers are intentionally read-only — they call into the
 * `host-kit` trace store (`listTurnTraces` / `readTurnTraceById` /
 * `formatTurnTraceMarkdown`) and serialize what they get back. No
 * provider-side mutation. `openTraceFile` opens the on-disk JSONL
 * trace in a side-by-side VS Code editor for hand-inspection.
 *
 * Why this lives outside the provider class: the trace payloads are
 * a stable contract between the webview viewer and the host-kit
 * trace format. Trapping the serialization here keeps the wire
 * shape pinned to one file (tests can pin the field set without
 * pulling in the rest of the provider).
 */
import * as vscode from 'vscode';
import type {
  TurnLogEvent,
  TurnTrace
} from '@burtson-labs/host-kit';
import {
  listTurnTraces,
  readTurnTraceById,
  formatTurnTraceMarkdown,
  previewText
} from '@burtson-labs/host-kit';
import type {
  IncomingMessage,
  TraceEventPayload,
  TraceListMode,
  TraceSummaryPayload
} from '../../messages';
import type { ProviderContext } from '../context';

export interface TraceMessageDeps {
  /** Workspace root used as the trace search base. The
   *  pre-extraction code derived this from
   *  `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()`
   *  inline; the deps hook lets tests pass a temp dir without
   *  faking the whole `vscode.workspace` surface. */
  getWorkspaceRoot(): string;
}

const defaultDeps: TraceMessageDeps = {
  getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
};

export async function handleRequestTraceList(
  ctx: ProviderContext,
  mode: TraceListMode = 'all',
  selectedId?: string | null,
  deps: TraceMessageDeps = defaultDeps
): Promise<void> {
  const workspaceRoot = deps.getWorkspaceRoot();
  try {
    const traces = await listTurnTraces(workspaceRoot, {
      limit: mode === 'failed' ? 50 : 30,
      includeGlobal: true,
      status: mode === 'failed' ? ['failed', 'blocked', 'cancelled'] : undefined
    });
    ctx.postMessage({
      type: 'traceList',
      mode,
      selectedId: selectedId ?? null,
      traces: traces.map((trace) => serializeTraceSummary(trace))
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: 'traceError', message: `Unable to read traces: ${msg}` });
  }
}

export async function handleRequestTraceDetail(
  ctx: ProviderContext,
  id: string,
  deps: TraceMessageDeps = defaultDeps
): Promise<void> {
  const workspaceRoot = deps.getWorkspaceRoot();
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) {
    ctx.postMessage({ type: 'traceError', message: 'Trace id is empty.' });
    return;
  }
  try {
    const trace = await readTurnTraceById(workspaceRoot, trimmed, { limit: 1000, includeGlobal: true });
    if (!trace) {
      ctx.postMessage({ type: 'traceError', message: `Trace not found: ${trimmed}` });
      return;
    }
    ctx.postMessage({
      type: 'traceDetail',
      trace: {
        summary: serializeTraceSummary(trace),
        events: trace.events.map((event) => serializeTraceEvent(event)),
        markdown: formatTurnTraceMarkdown(trace, { maxEvents: 120 })
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: 'traceError', message: `Unable to open trace: ${msg}` });
  }
}

export async function handleOpenTraceFile(
  ctx: ProviderContext,
  filePath: string
): Promise<void> {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : '';
  if (!trimmed) {
    ctx.postMessage({ type: 'notification', message: 'Trace file path unavailable.' });
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(trimmed));
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: 'traceError', message: `Unable to open trace file: ${msg}` });
  }
}

/**
 * Topic dispatcher — returns `true` if the message belongs to the
 * trace-viewer cluster (and was handled), `false` otherwise.
 * Collapses 3 if-blocks in the provider's `handleMessage`.
 */
export async function dispatchTraceMessage(
  ctx: ProviderContext,
  message: IncomingMessage
): Promise<boolean> {
  switch (message.type) {
    case 'requestTraceList':
      await handleRequestTraceList(ctx, message.mode === 'failed' ? 'failed' : 'all');
      return true;
    case 'requestTraceDetail':
      await handleRequestTraceDetail(ctx, message.id);
      return true;
    case 'openTraceFile':
      await handleOpenTraceFile(ctx, message.path);
      return true;
    default:
      return false;
  }
}

export function serializeTraceSummary(trace: TurnTrace): TraceSummaryPayload {
  const summary = trace.summary;
  return {
    id: summary.id,
    filePath: summary.filePath,
    scope: summary.scope,
    workspace: summary.workspace,
    startedAt: summary.startedAt,
    prompt: summary.prompt ? previewText(summary.prompt).slice(0, 1200) : undefined,
    finalPreview: summary.finalPreview ? previewText(summary.finalPreview).slice(0, 1200) : undefined,
    iterations: summary.iterations,
    hitLimit: summary.hitLimit,
    toolCalls: summary.toolCalls,
    tools: summary.tools,
    blockedTools: summary.blockedTools,
    errors: summary.errors,
    retries: summary.retries,
    nativeFallbacks: summary.nativeFallbacks,
    permissionRequests: summary.permissionRequests,
    permissionDecisions: summary.permissionDecisions,
    permissionDenials: summary.permissionDenials,
    compactions: summary.compactions,
    checkpoints: summary.checkpoints,
    status: summary.status
  };
}

export function serializeTraceEvent(event: TurnLogEvent): TraceEventPayload {
  const details: string[] = [];
  const add = (value: unknown): void => {
    if (value === undefined || value === null) {return;}
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {details.push(trimmed);}
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      details.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ');
      if (joined) {details.push(joined);}
      return;
    }
    details.push(previewText(value));
  };
  add(event.choice);
  add(event.name);
  add(event.displayPrimary ?? event.primary);
  add(event.risk);
  add(event.reason ?? event.error);
  if (typeof event.attempt === 'number') {details.push(`attempt ${event.attempt}`);}
  if (Array.isArray(event.tools)) {add(event.tools);}
  if (details.length === 0) {
    add(event.outputPreview ?? event.outputSnippet ?? event.textPreview ?? event.finalPreview ?? event.responsePreview);
  }
  return {
    t: typeof event.t === 'string' ? event.t : undefined,
    type: event.type,
    iteration: typeof event.iteration === 'number' ? event.iteration : undefined,
    name: typeof event.name === 'string' ? event.name : undefined,
    detail: details.length > 0 ? previewText(details.join(' · ')).slice(0, 900) : undefined,
    isError: event.type.includes('error') || event.type === 'tool-not-found' || event.isError === true
  };
}
