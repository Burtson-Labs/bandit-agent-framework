/**
 * Give-up recovery (giveUp.ts) and smart-case search, driven end to end
 * through runTurn with a recording scripted model.
 *
 * The regression: on 2026-11-15 a cloud turn asked to add a comment "in the
 * file where the apple o auth and other provider logic is ... make a pull
 * request" ran `search_code apple`, then `ls .`, then answered in prose and
 * stopped — 7 s, no edit — and the run failed NO_CHANGES_FOR_MUTATION. The
 * runner now reminds the model, with what it found, and the edit lands.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatFn, ToolLoopMessage } from '@burtson-labs/agent-core';
import { grepArgs, runTurn } from '../src/turn';
import {
  buildNudgePrompt,
  candidateFiles,
  decideNudge,
  maxNudgesFromEnv,
  pathsFromSearchOutput,
  statesBlocker,
} from '../src/giveUp';
import type { RunnerEvent, TurnRequest } from '../src/contract';

const PROMPT =
  'Can you add a comment in the file where the apple o auth and other provider logic is I want to see a ninja emoji at the top of the file make a pull request please';

const SEARCH_APPLE = '<tool_call>{"name": "search_code", "params": {"pattern": "apple"}}</tool_call>';
const LS_ROOT = '<tool_call>{"name": "ls", "params": {"path": "."}}</tool_call>';
const GIVE_UP = 'I found references to Apple OAuth in the codebase. The provider logic appears to live in the Services folder.';
const READ_OAUTH =
  '<tool_call>{"name": "read_file", "params": {"path": "AuthApi/Services/OAuthService.cs"}}</tool_call>';
const EDIT_OAUTH =
  '<tool_call>{"name": "apply_edit", "params": {"path": "AuthApi/Services/OAuthService.cs", "old_string": "using System;", "new_string": "// 🥷 OAuth providers: Apple, Google, GitHub\\nusing System;"}}</tool_call>';
const DONE = 'Added the 🥷 comment to the top of AuthApi/Services/OAuthService.cs, where AppleAuth and the other providers live.';

const OAUTH_SOURCE = `using System;

namespace AuthApi.Services;

public class OAuthService
{
    public string AppleAuthUrl() => "https://appleid.apple.com/auth/authorize";
    public string GoogleAuthUrl() => "https://accounts.google.com/o/oauth2/v2/auth";
}
`;

let graphFlag: string | undefined;
const dirs: string[] = [];

beforeAll(() => {
  graphFlag = process.env.RUNNER_GRAPH;
  process.env.RUNNER_GRAPH = '0';
});

afterAll(() => {
  if (graphFlag === undefined) delete process.env.RUNNER_GRAPH;
  else process.env.RUNNER_GRAPH = graphFlag;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A clone shaped like Burtson-Labs/AuthApi, with build output that a
 *  search must skip. */
function authApiWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-giveup-')));
  dirs.push(ws);
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  };
  write('AuthApi/Services/OAuthService.cs', OAUTH_SOURCE);
  write('AuthApi/Controllers/AuthController.cs', 'public class AuthController { /* SignInWithApple */ }\n');
  write('AuthApi/appsettings.json', '{ "Apple": { "ClientId": "" } }\n');
  write('AuthApi/bin/Debug/AuthApi.deps.json', '{ "apple": "build output" }\n');
  write('README.md', '# AuthApi\n');
  return ws;
}

/** Scripted model that records every conversation it was shown. */
function recordingChat(script: string[]): { chat: ChatFn; seen: ToolLoopMessage[][] } {
  const seen: ToolLoopMessage[][] = [];
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  const chat: ChatFn = async function* scripted(messages) {
    seen.push(messages.map((m) => ({ ...m })));
    yield script[i] ?? 'Done.';
    i += 1;
  };
  return { chat, seen };
}

function request(ws: string, prompt = PROMPT): TurnRequest {
  return {
    protocol: 1,
    taskId: 'task-giveup',
    workspacePath: ws,
    prompt,
    provider: { kind: 'deterministic' },
    maxIterations: 8,
  };
}

async function collect(req: TurnRequest, chat: ChatFn, maxNudges?: number): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  await runTurn(req, (e) => events.push(e), {
    permissionMode: 'standard',
    chat,
    nativeTools: false,
    ...(maxNudges === undefined ? {} : { maxNudges }),
  });
  return events;
}

function lastUserText(messages: ToolLoopMessage[]): string {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
}

describe('regression: two exploratory calls, then stop (2026-11-15)', () => {
  it('reminds the model with what it found, and the edit lands', async () => {
    const ws = authApiWorkspace();
    const { chat, seen } = recordingChat([SEARCH_APPLE, LS_ROOT, GIVE_UP, READ_OAUTH, EDIT_OAUTH, DONE]);

    const events = await collect(request(ws), chat);
    const last = events[events.length - 1];

    expect(fs.readFileSync(path.join(ws, 'AuthApi/Services/OAuthService.cs'), 'utf8')).toMatch(/^\/\/ 🥷/);
    expect(events.filter((e) => e.type === 'turn.nudged')).toHaveLength(1);
    expect(events.some((e) => e.type === 'artifact.changed')).toBe(true);
    expect(last).toMatchObject({ type: 'turn.completed', artifacts: 1, nudges: 1 });

    // The reminder is specific: the request, what search_code found, the
    // likely file, and the make-it-or-say-BLOCKED rule.
    const nudge = lastUserText(seen[3]);
    expect(nudge).toContain('this is a change request and nothing has been edited yet');
    expect(nudge).toContain('ninja emoji at the top of the file');
    expect(nudge).toContain('search_code "apple"');
    expect(nudge).toContain('AuthApi/Services/OAuthService.cs');
    expect(nudge).toContain(GIVE_UP.slice(0, 40));
    expect(nudge).toContain('BLOCKED:');
    // Build output is not offered as an edit target.
    expect(nudge).not.toContain('bin/Debug');
  });

  it('still fails honestly once the reminders are spent, quoting the model', async () => {
    const ws = authApiWorkspace();
    const { chat } = recordingChat([SEARCH_APPLE, LS_ROOT, GIVE_UP, GIVE_UP, 'Which file would you like me to edit?']);

    const events = await collect(request(ws), chat, 2);
    const last = events[events.length - 1];

    expect(events.filter((e) => e.type === 'turn.nudged')).toHaveLength(2);
    expect(last).toMatchObject({ type: 'turn.error', code: 'NO_CHANGES_FOR_MUTATION', nudges: 2 });
    const message = (last as Extract<RunnerEvent, { type: 'turn.error' }>).message;
    expect(message).toContain('2 reminder(s)');
    expect(message).toContain('Which file would you like me to edit?');
  });

  it('accepts a stated blocker without nudging', async () => {
    const ws = authApiWorkspace();
    const { chat } = recordingChat([
      SEARCH_APPLE,
      'BLOCKED: the request says to add the comment and also to leave every file untouched.',
    ]);

    const events = await collect(request(ws), chat);
    const last = events[events.length - 1] as Extract<RunnerEvent, { type: 'turn.error' }>;

    expect(events.some((e) => e.type === 'turn.nudged')).toBe(false);
    expect(last.code).toBe('NO_CHANGES_FOR_MUTATION');
    expect(last.message).toContain('BLOCKED: the request says');
  });

  it('does not nudge when the gate refused the edit (read-only mode)', async () => {
    const ws = authApiWorkspace();
    const { chat } = recordingChat([SEARCH_APPLE, EDIT_OAUTH, 'The edit was refused in this mode.']);
    const events: RunnerEvent[] = [];
    await runTurn(request(ws), (e) => events.push(e), { permissionMode: 'read-only', chat, nativeTools: false });

    expect(events.some((e) => e.type === 'tool.result' && !e.ok && e.summary.startsWith('Blocked'))).toBe(true);
    expect(events.some((e) => e.type === 'turn.nudged')).toBe(false);
  });

  it('never nudges a question or an audit', async () => {
    const ws = authApiWorkspace();
    const { chat } = recordingChat([SEARCH_APPLE, 'Apple sign-in lives in OAuthService.cs.']);

    const events = await collect(request(ws, 'Where is the Apple OAuth logic?'), chat);

    expect(events.some((e) => e.type === 'turn.nudged')).toBe(false);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed', artifacts: 0 });
  });

  it('AGENT_RUNNER_MAX_NUDGES=0 restores the old immediate failure', async () => {
    const ws = authApiWorkspace();
    const { chat } = recordingChat([SEARCH_APPLE, LS_ROOT, GIVE_UP]);

    const events = await collect(request(ws), chat, 0);

    expect(events.some((e) => e.type === 'turn.nudged')).toBe(false);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.error', code: 'NO_CHANGES_FOR_MUTATION' });
  });
});

describe('search_code in the runner', () => {
  async function search(ws: string, pattern: string): Promise<string> {
    const { chat } = recordingChat([
      `<tool_call>{"name": "search_code", "params": {"pattern": ${JSON.stringify(pattern)}}}</tool_call>`,
      'ok',
    ]);
    const events = await collect(request(ws, 'Where is this?'), chat);
    const result = events.find((e) => e.type === 'tool.result') as Extract<RunnerEvent, { type: 'tool.result' }>;
    return result.summary;
  }

  it('is smart-case: a lowercase pattern matches AppleAuth and SignInWithApple', async () => {
    const ws = authApiWorkspace();
    const out = await search(ws, 'signinwithapple');
    expect(out).toContain('AuthApi/Controllers/AuthController.cs');
  });

  it('keeps a pattern with capitals exact', async () => {
    const ws = authApiWorkspace();
    const out = await search(ws, 'APPLEAUTH');
    expect(out).toMatch(/^No matches found for "APPLEAUTH"\. Try: .*"appleauth"/);
  });

  it('reads alternation as a regex and prints workspace-relative paths', async () => {
    const ws = authApiWorkspace();
    const out = await search(ws, 'signinwithapple|googleauth');
    expect(out).toContain('AuthApi/Controllers/AuthController.cs:');
    expect(out).toContain('AuthApi/Services/OAuthService.cs:');
    expect(out).not.toContain(ws);
  });

  it('skips build output and binaries', () => {
    const args = grepArgs('apple', '.');
    expect(args).toContain('-i');
    expect(args).toContain('--exclude-dir=bin');
    expect(args).toContain('--exclude-dir=obj');
    expect(args[0]).toBe('-rnIE');
    expect(grepArgs('Apple', '.')).not.toContain('-i');
    // An escape like \w is not a capital.
    expect(grepArgs('apple\\w+', '.')).toContain('-i');
  });

  it('refuses a search outside the workspace', async () => {
    const ws = authApiWorkspace();
    const { chat } = recordingChat([
      '<tool_call>{"name": "search_code", "params": {"pattern": "root", "cwd": "/etc"}}</tool_call>',
      'ok',
    ]);
    const events = await collect(request(ws, 'Where is this?'), chat);
    const result = events.find((e) => e.type === 'tool.result') as Extract<RunnerEvent, { type: 'tool.result' }>;
    expect(result.summary).toMatch(/escapes workspace/);
  });
});

describe('giveUp rules', () => {
  const base = {
    mutation: true,
    artifacts: 0,
    hitLimit: false,
    cancelled: false,
    finalResponse: 'I found it.',
    nudgesUsed: 0,
    maxNudges: 2,
  };

  it('nudges only an unfinished change request with budget left', () => {
    expect(decideNudge(base)).toEqual({ nudge: true });
    expect(decideNudge({ ...base, mutation: false })).toMatchObject({ reason: 'not-mutation' });
    expect(decideNudge({ ...base, artifacts: 1 })).toMatchObject({ reason: 'changed' });
    expect(decideNudge({ ...base, editBlocked: true })).toMatchObject({ reason: 'edit-blocked' });
    expect(decideNudge({ ...base, hitLimit: true })).toMatchObject({ reason: 'hit-limit' });
    expect(decideNudge({ ...base, cancelled: true })).toMatchObject({ reason: 'cancelled' });
    expect(decideNudge({ ...base, nudgesUsed: 2 })).toMatchObject({ reason: 'budget' });
    expect(decideNudge({ ...base, finalResponse: 'BLOCKED: no such file' })).toMatchObject({ reason: 'blocker' });
  });

  it('treats questions and "could not find" as give-ups, not blockers', () => {
    expect(statesBlocker('Which file should I edit?')).toBe(false);
    expect(statesBlocker('I could not find the Apple OAuth file.')).toBe(false);
    expect(statesBlocker('The write was blocked by the policy gate.')).toBe(true);
    expect(statesBlocker('**BLOCKED:** the repository is empty')).toBe(true);
  });

  it('reads paths off grep output and ranks unread files', () => {
    const out = 'AuthApi/Services/OAuthService.cs:7:Apple\nAuthApi/Services/OAuthService.cs:8:x\n./README.md:1:apple\n';
    expect(pathsFromSearchOutput(out)).toEqual(['AuthApi/Services/OAuthService.cs', 'README.md']);
    const findings = [
      { tool: 'search_code', params: { pattern: 'apple' }, ok: true, summary: out },
      { tool: 'read_file', params: { path: 'README.md' }, ok: true, summary: '# x' },
    ];
    expect(candidateFiles(findings)).toEqual(['AuthApi/Services/OAuthService.cs']);
  });

  it('suggests a better search when nothing was found', () => {
    const text = buildNudgePrompt({
      goal: 'Add a header comment to the apple auth file',
      findings: [{ tool: 'search_code', params: { pattern: 'apple auth' }, ok: true, summary: 'No matches found for "apple auth".' }],
      finalResponse: '',
      nudge: 1,
      maxNudges: 2,
    });
    expect(text).toContain('search_code "apple auth" — no matches');
    expect(text).toContain('case-insensitive for lowercase patterns');
  });

  it('reads the nudge budget from the environment', () => {
    expect(maxNudgesFromEnv({})).toBe(2);
    expect(maxNudgesFromEnv({ AGENT_RUNNER_MAX_NUDGES: '0' })).toBe(0);
    expect(maxNudgesFromEnv({ AGENT_RUNNER_MAX_NUDGES: 'lots' })).toBe(2);
    expect(maxNudgesFromEnv({ AGENT_RUNNER_MAX_NUDGES: '99' })).toBe(5);
  });
});
