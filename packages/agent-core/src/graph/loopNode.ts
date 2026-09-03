/**
 * Phase 2 plumbing: run one ToolUseLoop turn as a graph node — the loop is
 * wrapped, never rewritten. Each execution builds a FRESH loop + conversation;
 * cross-node context flows explicitly through upstream outputs folded into the
 * node's prompt (no shared hidden state between nodes, which is what makes a
 * graph inspectable and retryable per-node later).
 */
import { createToolUseLoop, type ToolUseLoopOptions } from '../tools/tool-use-loop';
import type { ChatFn, ToolExecutionContext } from '../tools/tool-types';
import type { ToolRegistry } from '../tools/tool-registry';
import type { EvidenceItem, NodeExecutor, NodeRunContext } from './types';

export interface LoopNodeDeps {
  registry: ToolRegistry;
  ctx: ToolExecutionContext;
  /** ChatFn shared by every execution of this node. Provide exactly one of
   *  `chat` / `chatFactory`. */
  chat?: ChatFn;
  /** Builds a fresh ChatFn per node execution (per-node provider/model). */
  chatFactory?: () => ChatFn | Promise<ChatFn>;
  systemPrompt?: string;
  /** Forwarded into the loop (beforeToolExecute gate, emitEvent, budgets…).
   *  The graph run's AbortSignal is injected automatically. */
  loopOptions?: ToolUseLoopOptions;
}

/**
 * Build the node's prompt. Default folds each upstream node's summary/output
 * under a heading so the model sees exactly what earlier nodes produced.
 */
export type NodePromptBuilder = (ctx: NodeRunContext) => string;

export function defaultNodePrompt(base: string): NodePromptBuilder {
  return (ctx) => {
    const upstreamIds = Object.keys(ctx.upstream);
    if (upstreamIds.length === 0) return base;
    const sections = upstreamIds.map((id) => {
      const r = ctx.upstream[id];
      const body = r.summary ?? (typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? ''));
      return `### Result of "${id}"\n${(body ?? '').toString().slice(0, 4000)}`;
    });
    return `${base}\n\n## Upstream results\n\n${sections.join('\n\n')}`;
  };
}

/** Wrap one loop run as a NodeExecutor. */
export function wrapLoopAsNode(deps: LoopNodeDeps, buildPrompt: NodePromptBuilder): NodeExecutor {
  if (!deps.chat && !deps.chatFactory) {
    throw new Error('wrapLoopAsNode: provide chat or chatFactory');
  }
  return async (nodeCtx) => {
    const chat = deps.chatFactory ? await deps.chatFactory() : deps.chat!;
    // Auto-evidence: successful edit-tool results become 'file-changed'
    // evidence without the executor author doing anything — so a contract
    // like requireEvidence:[{kind:'file-changed'}] works out of the box.
    // The caller's own emitEvent (if any) still sees every event.
    const EDIT_TOOLS = new Set(['write_file', 'apply_edit', 'replace_range', 'apply_patch', 'delete_file']);
    const evidence: EvidenceItem[] = [];
    const lastPath = new Map<string, string>();
    const callerEmit = deps.loopOptions?.emitEvent;
    const emitEvent = (type: string, payload?: unknown): void => {
      const p = (payload ?? {}) as { name?: string; params?: Record<string, string>; isError?: boolean };
      if (type === 'tool_loop:tool_execute' && p.name && EDIT_TOOLS.has(p.name)) {
        lastPath.set(p.name, p.params?.path ?? '');
      } else if (type === 'tool_loop:tool_result' && p.name && EDIT_TOOLS.has(p.name) && !p.isError) {
        evidence.push({ kind: 'file-changed', detail: lastPath.get(p.name) || undefined });
      }
      callerEmit?.(type, payload);
    };
    const loop = createToolUseLoop(deps.registry, deps.ctx, {
      ...(deps.loopOptions ?? {}),
      emitEvent,
      signal: nodeCtx.signal,
    });
    const result = await loop.run(buildPrompt(nodeCtx), chat, deps.systemPrompt);
    if (result.cancelled) {
      throw new Error('node cancelled');
    }
    return {
      output: result.finalResponse,
      summary: result.finalResponse.slice(0, 200),
      evidence,
    };
  };
}
