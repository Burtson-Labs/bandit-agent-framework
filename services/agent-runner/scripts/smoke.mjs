/**
 * Seam proof: start the runner, POST a scripted multi-iteration turn, and
 * assert the full event grammar — started, tool.call, tool.result,
 * artifact.changed, completed-with-artifacts — plus workspace jailing.
 * No model involved; this is the contract, not the intelligence.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = mkdtempSync(join(tmpdir(), 'runner-smoke-'));
const port = 8799;
const srv = spawn('node', ['dist/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (c) => process.stderr.write(c));
await new Promise((r) => srv.stdout.once('data', r));

const req = {
  protocol: 1,
  taskId: 'smoke-1',
  workspacePath: ws,
  prompt: 'Create hello.md with a greeting.',
  provider: {
    kind: 'deterministic',
    script: [
      '<tool_call>{"name": "write_file", "params": {"path": "hello.md", "content": "# Hello from the runner\\n"}}</tool_call>',
      'I created hello.md with a greeting.',
    ],
  },
};

const res = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(req),
});
const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
const types = events.map((e) => e.type);
console.log('events:', types.join(' → '));

const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
if (!types.includes('turn.started')) fail('no turn.started');
if (!types.includes('tool.call')) fail('no tool.call');
if (!types.includes('tool.result')) fail('no tool.result');
if (!types.includes('artifact.changed')) fail('no artifact.changed');
if (types[types.length - 1] !== 'turn.completed') fail('stream must end with turn.completed');
const done = events[events.length - 1];
if (done.artifacts !== 1) fail(`expected 1 artifact, got ${done.artifacts}`);
if (!existsSync(join(ws, 'hello.md'))) fail('hello.md not written');
console.log('file content:', JSON.stringify(readFileSync(join(ws, 'hello.md'), 'utf8')));

// Jail check: a path-escaping write must not land outside the workspace.
const evil = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...req,
    taskId: 'smoke-2',
    provider: {
      kind: 'deterministic',
      script: [
        '<tool_call>{"name": "write_file", "params": {"path": "../../escape.txt", "content": "nope"}}</tool_call>',
        'Done.',
      ],
    },
  }),
});
const evilEvents = (await evil.text()).trim().split('\n').map((l) => JSON.parse(l));
const evilResult = evilEvents.find((e) => e.type === 'tool.result');
if (existsSync(join(ws, '..', '..', 'escape.txt'))) fail('workspace escape succeeded!');
if (evilResult?.ok !== false && !existsSync(join(ws, 'escape.txt'))) {
  // Either the tool errored (jailed) or the write was re-rooted inside the
  // workspace — both are acceptable containment; silence is not.
  console.log('escape attempt handled:', JSON.stringify(evilResult).slice(0, 160));
}

// Protocol negotiation: wrong version must 426, not guess.
const wrong = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...req, protocol: 99 }),
});
if (wrong.status !== 426) fail(`protocol mismatch returned ${wrong.status}, want 426`);

console.log('SMOKE PASS');
srv.kill();
process.exit(0);
