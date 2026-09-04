// Offline graph-route smoke: scripted provider, real planner parse +
// scheduler + loop nodes. Proves: proposal → graph.plan → node lifecycle
// events → synthesized final → turn.completed. Run: node scripts/graph-smoke.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../dist/turn.js';

const ws = mkdtempSync(join(tmpdir(), 'graph-smoke-'));
writeFileSync(join(ws, 'README.md'), '# smoke\n');

const proposal = JSON.stringify({
  kind: 'graph',
  nodes: [
    { id: 'inspect', label: 'Inspect the README', prompt: 'Read README.md and summarize it.', readOnly: true },
    { id: 'report', label: 'Write the report', prompt: 'Produce a one-line report.', dependsOn: ['inspect'] },
  ],
});

let calls = 0;
// Scripted chat: call 1 = planner proposal; later calls = plain answers
// (no tool syntax → the loop treats them as the final response).
const chat = async function* () {
  calls += 1;
  yield calls === 1 ? proposal : `answer #${calls} from the scripted model`;
};

const events = [];
await runTurn(
  {
    protocol: 1,
    taskId: 'smoke-graph-1',
    workspacePath: ws,
    prompt: 'First inspect README.md, src/a.ts and src/b.ts separately, then summarize each one, and finally combine the findings into a single report in REPORT.md.',
    provider: { kind: 'ollama', baseUrl: 'http://unused.invalid', model: 'scripted' },
  },
  (e) => events.push(e),
  { chat },
);

const types = events.map((e) => e.type);
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg, '\nevents:', JSON.stringify(events, null, 2)); process.exit(1); } };
assert(types.includes('graph.plan'), 'graph.plan emitted');
assert(events.filter((e) => e.type === 'graph.node' && e.status === 'running').length === 2, 'both nodes ran');
assert(events.filter((e) => e.type === 'graph.node' && e.status === 'done').length === 2, 'both nodes done');
assert(types.indexOf('graph.plan') < types.indexOf('graph.node'), 'plan precedes nodes');
assert(types.includes('turn.completed'), 'turn completed');
const final = events.find((e) => e.type === 'turn.completed');
assert(final.assistantText.includes('Inspect the README'), 'final folds node labels');
console.log('graph-smoke OK —', events.length, 'events, plan + 2 nodes + completion');
