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
 */
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createCoreToolRegistry,
  createToolUseLoop,
  type ChatFn,
  type ProviderChatOptions,
  type ProviderClient,
  type ToolExecutionContext,
} from '@burtson-labs/agent-core';
import { DeterministicProviderClient } from '@burtson-labs/agent-core';
import type { RunnerEvent, TurnProvider, TurnRequest } from './contract.js';

const RUNNER_VERSION = '1.0.0';

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

/**
 * Scripted provider for seam proofs and load tests: each chat() call pops
 * the next scripted response. Lets CI drive a full multi-iteration tool
 * turn — tool call, result fed back, final answer — with no model.
 */
class ScriptedProvider implements ProviderClient {
  name = 'scripted';
  private i = 0;
  constructor(private script: string[]) {}
  // eslint-disable-next-line require-yield
  async *chat(_prompt: string, _options?: ProviderChatOptions): AsyncIterable<string> {
    const next = this.script[this.i] ?? 'Done.';
    this.i += 1;
    yield next;
  }
}

function providerFor(spec: TurnProvider): { client: ProviderClient; chatViaMessages: boolean } {
  switch (spec.kind) {
    case 'deterministic':
      return spec.script?.length
        ? { client: new ScriptedProvider(spec.script), chatViaMessages: false }
        : { client: new DeterministicProviderClient(), chatViaMessages: false };
    case 'ollama':
    case 'openai-compat':
      // Wired in the next increment — the contract accepts them now so the
      // gateway integration does not need a protocol bump to use them.
      throw new Error(`provider kind '${spec.kind}' not wired yet (contract-ready)`);
  }
}

export async function runTurn(
  req: TurnRequest,
  emit: (e: RunnerEvent) => void,
): Promise<void> {
  const { taskId } = req;
  emit({ type: 'turn.started', taskId, protocol: 1, runnerVersion: RUNNER_VERSION });

  let artifacts = 0;
  const ctx = makeContext(req.workspacePath, (p, kind) => {
    artifacts += 1;
    emit({ type: 'artifact.changed', taskId, path: p, kind });
  });

  const registry = createCoreToolRegistry();
  const loop = createToolUseLoop(registry, ctx, {
    maxIterations: req.maxIterations ?? 10,
    emitEvent: (type, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      // Loop event names verified against tool-use-loop.ts — it emits
      // tool_loop:tool_execute / tool_loop:tool_result (snippets already
      // secret-redacted by the loop).
      if (type === 'tool_loop:tool_execute') {
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
      }
    },
  });

  const { client } = providerFor(req.provider);
  const chat: ChatFn = (messages) => {
    // The loop hands us the whole conversation; providers in this service
    // speak prompt-shaped chat, so flatten. The native-tools channel lands
    // with the real model providers.
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
    return client.chat(prompt);
  };

  const result = await loop.run(req.prompt, chat);
  emit({ type: 'assistant.delta', taskId, text: result.finalResponse });
  emit({
    type: 'turn.completed',
    taskId,
    artifacts,
    // Terminal honesty: zero artifacts must carry a reason a human can read.
    noChangeReason:
      artifacts === 0
        ? result.hitLimit
          ? 'Iteration limit reached before any file changed.'
          : 'The agent answered without needing to change files.'
        : undefined,
    assistantText: result.finalResponse,
  });
}
