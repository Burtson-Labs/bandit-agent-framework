/**
 * Contract tests for skill-loader `command:` substitution.
 *
 * Before 2026-05-26 the substitution shape was: substitute params into
 * the template string, THEN split on `/\s+/` to derive base + args.
 * That let a param value containing whitespace explode into multiple
 * argv entries — e.g. command="git {{op}}" with op="log; touch /tmp/x"
 * resolved to ['git', 'log;', 'touch', '/tmp/x']. ctx.runCommand uses
 * spawn() under the hood so no shell interpretation occurred, but the
 * injected tokens still reached the binary as extra arguments. For
 * commands that accept --exec / --upload-pack / --bundle-uri flags
 * (find, git, ssh, scp), that's privilege escalation through a skill
 * template a user might consider benign.
 *
 * The fix: split the template FIRST, then substitute per-token. Each
 * param value becomes exactly one argv element regardless of contents.
 *
 * These tests pin the new shape so a future "let me simplify the
 * substitution" refactor can't silently reintroduce the hole.
 */
import { describe, expect, it } from 'vitest';
import { buildToolFromManifest } from '../src/tools/skill-loader';
import type { ToolExecutionContext } from '../src/index';

interface CapturedCall {
  base: string;
  args: string[];
  cwd: string;
}

function makeCtx(captured: CapturedCall[]): ToolExecutionContext {
  return {
    workspaceRoot: '/tmp/test',
    async readFile() { return ''; },
    async writeFile() { return; },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand(base, args, cwd) {
      captured.push({ base, args, cwd });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
  };
}

describe('skill-loader buildToolFromManifest — argv safety', () => {
  it('keeps a whitespace-containing param value as a SINGLE argv element', async () => {
    const captured: CapturedCall[] = [];
    const tool = buildToolFromManifest({
      name: 'git_log',
      description: 'show log',
      command: 'git log {{ref}}',
      parameters: [{ name: 'ref', description: 'branch or sha', required: true }]
    });
    // Malicious-shaped value: shell metacharacters + spaces. Before the
    // fix, this split into ['log;', 'touch', '/tmp/pwn'] and reached git
    // as four args. After the fix, it stays one arg.
    await tool.execute({ ref: 'log; touch /tmp/pwn' }, makeCtx(captured));
    expect(captured).toHaveLength(1);
    expect(captured[0].base).toBe('git');
    expect(captured[0].args).toEqual(['log', 'log; touch /tmp/pwn']);
  });

  it('preserves quoted-shaped values without re-parsing them', async () => {
    const captured: CapturedCall[] = [];
    const tool = buildToolFromManifest({
      name: 'echo',
      description: 'echo text',
      command: 'echo {{msg}}',
      parameters: [{ name: 'msg', description: 'the message', required: true }]
    });
    await tool.execute({ msg: '"hello world"' }, makeCtx(captured));
    expect(captured[0].args).toEqual(['"hello world"']);
  });

  it('substitutes multiple placeholders independently (each stays one arg)', async () => {
    const captured: CapturedCall[] = [];
    const tool = buildToolFromManifest({
      name: 'two_args',
      description: '',
      command: 'tool {{a}} {{b}}',
      parameters: [
        { name: 'a', description: '', required: true },
        { name: 'b', description: '', required: true }
      ]
    });
    await tool.execute({ a: 'first value', b: 'second value' }, makeCtx(captured));
    expect(captured[0].args).toEqual(['first value', 'second value']);
  });

  it('normalizes an explicitly-undefined param value to "" (not the string "undefined")', async () => {
    const captured: CapturedCall[] = [];
    const tool = buildToolFromManifest({
      name: 'maybe',
      description: '',
      command: 'tool --flag {{maybe}}',
      parameters: [{ name: 'maybe', description: '', required: false }]
    });
    // Some providers pass the key through with an undefined value when the
    // model omits it. Without (value ?? ''), .replace() coerces undefined
    // to the string "undefined" which then reaches the binary as an arg.
    await tool.execute({ maybe: undefined as unknown as string }, makeCtx(captured));
    expect(captured[0].args).toEqual(['--flag', '']);
  });

  it('leaves the placeholder literal when the key is entirely missing (model gets a clear failure signal)', async () => {
    const captured: CapturedCall[] = [];
    const tool = buildToolFromManifest({
      name: 'maybe',
      description: '',
      command: 'tool --flag {{ref}}',
      parameters: [{ name: 'ref', description: '', required: true }]
    });
    await tool.execute({}, makeCtx(captured));
    // Better than silently substituting "" — the downstream binary will
    // error on "{{ref}}" and the model will see what went wrong.
    expect(captured[0].args).toEqual(['--flag', '{{ref}}']);
  });

  it('replaces every occurrence when the same placeholder appears multiple times', async () => {
    const captured: CapturedCall[] = [];
    const tool = buildToolFromManifest({
      name: 'twice',
      description: '',
      command: 'tool --from {{x}} --to {{x}}',
      parameters: [{ name: 'x', description: '', required: true }]
    });
    await tool.execute({ x: 'main' }, makeCtx(captured));
    expect(captured[0].args).toEqual(['--from', 'main', '--to', 'main']);
  });

  it('returns a placeholder error when no command is configured', async () => {
    const tool = buildToolFromManifest({
      name: 'no_cmd',
      description: 'nothing to run'
    });
    const r = await tool.execute({}, makeCtx([]));
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/no command configured/);
  });

  it('surfaces non-zero exit code as isError=true', async () => {
    const captured: CapturedCall[] = [];
    const ctx: ToolExecutionContext = {
      ...makeCtx(captured),
      async runCommand() { return { stdout: '', stderr: 'boom', exitCode: 1 }; }
    };
    const tool = buildToolFromManifest({
      name: 'fails',
      description: '',
      command: 'tool'
    });
    const r = await tool.execute({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('boom');
  });
});
