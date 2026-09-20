/**
 * One cloud turn = the framework's own ToolUseLoop, hosted server-side.
 *
 * This is the point of the service: the gateway's bespoke plan→diff
 * pipeline is replaced by the SAME loop the CLI and IDE run, so a turn
 * behaves identically everywhere. The runner is deliberately "just
 * another host" — a ToolExecutionContext rooted at the prepared
 * workspace, a provider, and the loop.
 *
 * Sandboxing posture (v1): tools are jailed to workspacePath by path
 * checks here; process isolation comes from deployment (one runner per
 * pod). Per-turn jailing is the roadmap, and is WHY the runner is a
 * separate service in the first place — see the ADR.
 *
 * Cancellation (COMP-004): the caller passes the request's AbortSignal and
 * the turn honours it cooperatively — the loop and the graph scheduler both
 * take the same signal, the planner call bails between chunks, and the tool
 * gate denies everything once it fires. A client that hangs up therefore
 * stops costing model calls and, more importantly, stops writing files into
 * a workspace nobody is watching any more.
 */
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildPlannerPrompt,
  classifyGraphShaped,
  createCoreToolRegistry,
  createToolUseLoop,
  defaultNodePrompt,
  materializeProposal,
  parseGraphProposal,
  runGraph,
  wrapLoopAsNode,
  type ToolExecutionContext,
} from '@burtson-labs/agent-core';
import { chatFnFor } from './providers.js';
import { buildToolGate, parsePermissionMode, type PermissionMode } from './toolGate.js';
import type { RunnerEvent, TurnRequest } from './contract.js';

const RUNNER_VERSION = '1.0.0';

/**
 * Base system prompt for cloud turns.
 *
 * The loop previously ran with NO system prompt — bare tool definitions —
 * so models fell back to chat-assistant timidity: asked to "bump the chart
 * version", one found Chart.yaml, read the version, and then ASKED which
 * version to use instead of doing the obvious patch bump. Twice. A cloud
 * turn has nobody at the keyboard and its review surface is the pull
 * request, so decisiveness is the correct default and this prompt says so.
 */
const RUNNER_SYSTEM_PROMPT = `You are Bandit, an autonomous coding agent working inside a cloned repository. Nobody is at the keyboard during your turn, and everything you change is reviewed later as a pull request — so act, don't ask.

Be decisive:
- When a detail is unambiguous or has a strong convention, choose it, do it, and state the choice you made. "Bump the version" means increment the patch number (0.9.40 → 0.9.41) unless told otherwise.
- Prefer completing the requested change over describing what you could do or asking which variant is wanted.
- For implementation requests, make a first focused edit as soon as you have enough evidence. Do not spend the entire turn auditing unrelated files.
- A change request is complete only after at least one edit succeeds and you run the most relevant available verification. Never replace the requested work with a report titled "What I didn't get to."
- If the same operation fails twice for the same reason, stop retrying it, choose another route, and continue the goal.
- If something genuinely blocks you (missing file, contradictory instructions), finish everything you can, then say exactly what was blocked and why.

Ground every statement in files you actually read with your tools. Keep edits minimal, correct, and consistent with the surrounding code.`;

/** A read-only answer can satisfy an audit or explanation. These verbs mean
 * the user instead asked for a workspace mutation, so zero artifacts cannot
 * truthfully be called completion. */
export function requiresWorkspaceMutation(prompt: string): boolean {
  const text = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/\b(audit|review|explain|investigate|diagnose|find out|why|what|where|how)\b/.test(text) &&
      !/\b(fix|implement|change|edit|update|add|remove|refactor|make|build|create|write)\b/.test(text)) {
    return false;
  }
  return /\b(fix|implement|edit|update|add|remove|refactor|build|create|write|apply|make)\b/.test(text) ||
    /\b(code changes?|mobile improvements?|changes? please)\b/.test(text);
}

function emitTerminal(
  req: TurnRequest,
  artifacts: number,
  assistantText: string,
  hitLimit: boolean,
  emit: (e: RunnerEvent) => void,
  stats: { iterations: number; toolCalls: number } = { iterations: 0, toolCalls: 0 },
): void {
  if (artifacts === 0 && requiresWorkspaceMutation(req.prompt)) {
    emit({
      type: 'turn.error',
      taskId: req.taskId,
      code: 'NO_CHANGES_FOR_MUTATION',
      message: hitLimit
        ? 'The iteration/tool budget was exhausted before any requested file change landed.'
        : 'The model ended an implementation request without changing any files.',
      hitLimit,
    });
    return;
  }
  emit({
    type: 'turn.completed',
    taskId: req.taskId,
    artifacts,
    noChangeReason:
      artifacts === 0
        ? hitLimit
          ? 'Iteration limit reached before any file changed.'
          : 'The agent answered without needing to change files.'
        : undefined,
    assistantText,
    hitLimit,
    iterations: stats.iterations,
    toolCalls: stats.toolCalls,
  });
}

/**
 * Absolute path inside the workspace, or a thrown error — never a path
 * outside, and never a silent re-root.
 *
 * Two realities this must respect:
 *  - Core tools resolve relative paths against workspaceRoot BEFORE calling
 *    the context, so absolute paths inside the root are the common case and
 *    must pass through untouched (the first version re-rooted them, sending
 *    /tmp/ws/hello.md to /tmp/ws/tmp/ws/hello.md).
 *  - macOS tmpdirs arrive as /var/... which is a symlink of /private/var/...;
 *    containment is checked against both spellings.
 */
function resolveInWorkspace(root: string, p: string): string {
  const roots = new Set<string>([path.resolve(root)]);
  try {
    roots.add(realpathSync(path.resolve(root)));
  } catch {
    /* root vanished — the check below will throw with a clear message */
  }
  const primary = [...roots][0];
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(primary, p);
  for (const r of roots) {
    if (abs === r || abs.startsWith(r + path.sep)) return abs;
  }
  throw new Error(`path escapes workspace: ${p}`);
}

function makeContext(
  workspaceRoot: string,
  onArtifact: (p: string, kind: 'created' | 'modified' | 'deleted') => void,
): ToolExecutionContext {
  return {
    workspaceRoot,
    readFile: async (p) => fs.readFile(resolveInWorkspace(workspaceRoot, p), 'utf8'),
    writeFile: async (p, content) => {
      const abs = resolveInWorkspace(workspaceRoot, p);
      let existed = true;
      try {
        await fs.stat(abs);
      } catch {
        existed = false;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      onArtifact(path.relative(workspaceRoot, abs), existed ? 'modified' : 'created');
    },
    deleteFile: async (p) => {
      const abs = resolveInWorkspace(workspaceRoot, p);
      await fs.rm(abs, { force: true });
      onArtifact(path.relative(workspaceRoot, abs), 'deleted');
    },
    listFiles: async (pattern, cwd) => {
      // Glob-lite: the loop's core tools pass simple patterns; full glob
      // support arrives with the stealth-runtime fs adapter.
      const base = resolveInWorkspace(workspaceRoot, cwd ?? '.');
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(abs);
          else out.push(path.relative(workspaceRoot, abs));
        }
      };
      await walk(base);
      const star = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const rx = new RegExp(`^${star}$`);
      return pattern === '*' || pattern === '**' ? out : out.filter((f) => rx.test(f) || rx.test(path.basename(f)));
    },
    listDirectoryEntries: async (cwd) => {
      const base = resolveInWorkspace(workspaceRoot, cwd || '.');
      return (await fs.readdir(base, { withFileTypes: true })).map((e) =>
        e.isDirectory() ? `${e.name}/` : e.name,
      );
    },
    searchCode: async (pattern, cwd, fileGlob) => {
      const args = ['-rn', '--include', fileGlob ?? '*', pattern, cwd ?? '.'];
      const res = await run('grep', args, workspaceRoot);
      return res.stdout.slice(0, 20_000);
    },
    runCommand: async (cmd, args, cwd) => {
      // v1 allowlist: the gateway has no per-turn permission UI a human is
      // watching, so arbitrary commands stay off until the policy layer
      // exists. Read-only inspection commands are enough for most turns.
      const allow = new Set(['ls', 'cat', 'grep', 'git', 'find', 'wc', 'head', 'tail']);
      if (!allow.has(cmd)) {
        return { stdout: '', stderr: `command '${cmd}' not permitted in cloud turns (v1 allowlist)`, exitCode: 126 };
      }
      return run(cmd, args, cwd ? resolveInWorkspace(workspaceRoot, cwd) : workspaceRoot);
    },
  };
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.on('error', (err) => resolve({ stdout: '', stderr: String(err), exitCode: 127 }));
  });
}

/** Human-readable cancellation cause, defaulting to the common one. */
function cancellationReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason as unknown;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'turn cancelled';
}

export async function runTurn(
  req: TurnRequest,
  emit: (e: RunnerEvent) => void,
  deps?: {
    /** Test seam: inject a scripted ChatFn instead of a live provider. */
    chat?: Awaited<ReturnType<typeof chatFnFor>>;
    /** Permission mode for the tool gate (SEC-005). Defaults to
     *  AGENT_RUNNER_PERMISSION_MODE, then `standard`. */
    permissionMode?: PermissionMode;
    /** Cancellation from the HTTP request (COMP-004). Aborting it stops the
     *  loop, the graph, and every subsequent tool call. */
    signal?: AbortSignal;
  },
): Promise<void> {
  const { taskId } = req;
  const signal = deps?.signal;
  const cancelledEvent = (): RunnerEvent => ({
    type: 'turn.error',
    taskId,
    code: 'TURN_CANCELLED',
    message: cancellationReason(signal),
  });

  emit({ type: 'turn.started', taskId, protocol: 1, runnerVersion: RUNNER_VERSION });
  if (signal?.aborted) {
    emit(cancelledEvent());
    return;
  }

  let artifacts = 0;
  let toolCalls = 0;
  const ctx = makeContext(req.workspacePath, (p, kind) => {
    artifacts += 1;
    emit({ type: 'artifact.changed', taskId, path: p, kind });
  });

  // SEC-005: every tool call — plain loop and graph nodes alike — passes the
  // host-kit-backed gate before it executes. Denials surface to the model as
  // the tool result and to the gateway as a failed tool.result event.
  const permissionMode =
    deps?.permissionMode ?? parsePermissionMode(process.env.AGENT_RUNNER_PERMISSION_MODE);
  const policyGate = buildToolGate(permissionMode, req.workspacePath);
  // COMP-004: once the turn is cancelled nothing else executes. The loop
  // also checks the signal at its own boundaries, but a tool call already
  // in flight when the client vanished must not be the one that writes.
  const toolGate: typeof policyGate = (call) =>
    signal?.aborted ? { allow: false, reason: cancellationReason(signal) } : policyGate(call);

  const registry = createCoreToolRegistry();
  const maxIterations = req.maxIterations ?? 10;
  const loop = createToolUseLoop(registry, ctx, {
    maxIterations,
    // The tool budget scales with the iteration budget: a 40-iteration turn
    // that reads a few files per round hit the flat 120 cap long before its
    // iterations ran out, and the cap ends the turn with hitLimit just like
    // the iteration cap does.
    maxTotalTools: Math.max(120, maxIterations * 8),
    messageTokenBudget: 24_000,
    // Serialise any batch that writes. Two apply_edits to one file in one
    // batch race on read-modify-write under Promise.all and the first edit
    // is lost while both report success (caught by the Stealth soak,
    // 2026-09-20). A zero budget trips the loop's serial gate for batches
    // carrying file content; read-only batches stay parallel.
    outputBudgetTokens: 0,
    beforeToolExecute: toolGate,
    signal,
    emitEvent: (type, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      // Loop event names verified against tool-use-loop.ts — it emits
      // tool_loop:tool_execute / tool_loop:tool_result (snippets already
      // secret-redacted by the loop).
      if (type === 'tool_loop:tool_execute') {
        toolCalls += 1;
        emit({
          type: 'tool.call',
          taskId,
          tool: String(p.name ?? 'unknown'),
          params: (p.params as Record<string, string>) ?? {},
        });
      } else if (type === 'tool_loop:tool_result') {
        emit({
          type: 'tool.result',
          taskId,
          tool: String(p.name ?? 'unknown'),
          ok: !p.isError,
          summary: String(p.outputSnippet ?? '').slice(0, 400),
        });
      } else if (type === 'tool_loop:tool_error') {
        emit({
          type: 'tool.result',
          taskId,
          tool: String(p.name ?? 'unknown'),
          ok: false,
          summary: String(p.error ?? p.message ?? 'tool error').slice(0, 400),
        });
      } else if (type === 'tool_loop:tool_blocked') {
        // Gate denial (SEC-005): the loop emits tool_blocked instead of
        // tool_result, so map it here or denials are invisible upstream.
        emit({
          type: 'tool.result',
          taskId,
          tool: String(p.name ?? 'unknown'),
          ok: false,
          summary: `Blocked: ${String(p.reason ?? 'denied by policy')}`.slice(0, 400),
        });
      }
    },
  });

  const chat = deps?.chat ?? (await chatFnFor(req.provider));

  // ── Graph route ────────────────────────────────────────────────────
  // Decomposable prompts run as a DAG: planner proposes nodes (one extra
  // completion), each node is its own small tool loop with a completion
  // contract, independent nodes run concurrently, and every lifecycle
  // transition streams up as graph.plan / graph.node events. Anything
  // that fails BEFORE the graph starts falls back to the plain loop —
  // routing must never cost the user a turn. Kill switch: RUNNER_GRAPH=0.
  if (!/^(0|false)$/i.test(process.env.RUNNER_GRAPH ?? '') && classifyGraphShaped(req.prompt).suggestsGraph) {
    let planned: ReturnType<typeof materializeProposal> | null = null;
    let proposalNodes: Array<{ id: string; label?: string; dependsOn?: string[]; prompt: string; readOnly?: boolean }> = [];
    try {
      let plannerText = '';
      for await (const chunk of chat([{ role: 'user', content: buildPlannerPrompt(req.prompt) }])) {
        // Leaving the for-await closes the provider stream (its generator's
        // return path runs), so a cancelled turn stops reading the model
        // instead of finishing the planner call it no longer needs.
        if (signal?.aborted) break;
        plannerText += chunk;
      }
      if (signal?.aborted) {
        emit(cancelledEvent());
        return;
      }
      const parsed = parseGraphProposal(plannerText);
      if (parsed.ok && parsed.proposal?.kind === 'graph' && (parsed.proposal.nodes?.length ?? 0) > 1) {
        proposalNodes = parsed.proposal.nodes!;
        planned = materializeProposal(parsed.proposal, {
          makeExecutor: (node) =>
            wrapLoopAsNode(
              {
                registry,
                ctx,
                chat,
                systemPrompt: RUNNER_SYSTEM_PROMPT,
                loopOptions: {
                  maxIterations: Math.max(4, Math.floor((req.maxIterations ?? 10) / 2)),
                  // wrapLoopAsNode composes this with the node's envelope
                  // gate — envelope first, runner policy second.
                  beforeToolExecute: toolGate,
                },
              },
              defaultNodePrompt(node.prompt),
            ),
          // readOnly hint honored as a tool envelope: read/search only.
          envelopeFor: (node) =>
            node.readOnly
              ? { allowTools: ['read_file', 'list_files', 'ls', 'find_directory', 'search_code'] }
              : undefined,
        });
      }
    } catch {
      planned = null; // planner unavailable/rejected — plain loop below
    }

    if (planned) {
      emit({
        type: 'graph.plan',
        taskId,
        nodes: planned.spec.nodes.map((n) => ({ id: n.id, label: n.label ?? n.id, dependsOn: n.dependsOn })),
      });
      const graphResult = await runGraph(planned.spec, planned.executors, {
        maxConcurrency: 2,
        // The scheduler stops launching nodes and hands the same signal to
        // every running executor, so cancellation reaches the node loops.
        signal,
        emitEvent: (type, payload) => {
          const p = (payload ?? {}) as Record<string, unknown>;
          const nodeId = String(p.nodeId ?? p.id ?? '');
          if (type === 'graph:node_start') {
            emit({ type: 'graph.node', taskId, node: nodeId, status: 'running' });
          } else if (type === 'graph:node_done') {
            emit({ type: 'graph.node', taskId, node: nodeId, status: 'done', summary: String(p.summary ?? '').slice(0, 200) });
          } else if (type === 'graph:node_failed') {
            emit({ type: 'graph.node', taskId, node: nodeId, status: 'failed', summary: String(p.error ?? p.violations ?? '').slice(0, 200) });
          } else if (type === 'graph:node_skipped' || type === 'graph:node_cancelled') {
            emit({ type: 'graph.node', taskId, node: nodeId, status: 'skipped' });
          }
        },
      });

      const parts: string[] = [];
      for (const node of planned.spec.nodes) {
        const r = graphResult.nodes[node.id];
        if (!r) continue;
        const body = r.summary ?? (typeof r.output === 'string' ? r.output : '');
        parts.push(`### ${node.label ?? node.id} — ${r.state}
${(body ?? '').toString().slice(0, 2000)}`);
      }
      const finalText = parts.join('\n\n') || '(graph produced no output)';
      if (signal?.aborted) {
        emit(cancelledEvent());
        return;
      }
      emit({ type: 'assistant.delta', taskId, text: finalText });

      const failed = Object.values(graphResult.nodes).filter((r) => r.state === 'failed').length;
      if (graphResult.status === 'failed' && failed === planned.spec.nodes.length) {
        emit({ type: 'turn.error', taskId, code: 'GRAPH_ALL_NODES_FAILED', message: `all ${failed} nodes failed` });
        return;
      }
      emitTerminal(req, artifacts, finalText, false, emit, { iterations: 0, toolCalls });
      return;
    }
  }

  const result = await loop.run(req.prompt, chat, RUNNER_SYSTEM_PROMPT);
  if (result.cancelled || signal?.aborted) {
    // Terminal line even though nobody may be listening: the stream
    // contract says the last line is always completed or error, and a
    // cancelled turn is NOT a completed one.
    emit(cancelledEvent());
    return;
  }
  emit({ type: 'assistant.delta', taskId, text: result.finalResponse });
  emitTerminal(req, artifacts, result.finalResponse, result.hitLimit, emit, {
    iterations: result.iterations,
    toolCalls,
  });
}
