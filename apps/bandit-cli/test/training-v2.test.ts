import { describe, it, expect } from 'vitest';
import { addCliSession, addStealthWebTurn, newAccumulator, type BuildOptions } from '../src/training/build';
import { detectHandBack, editVerifyLabels, normalizedHash, passesMinQuality, qualityWeight } from '../src/training/quality';
import { createScrubber, totalSecrets } from '../src/training/scrub';
import { parseSession, parseStealthWebTurn, type DiscoveredFile } from '../src/training/sources';
import { emptyLabels, emptyRedactions, type CanonicalMessage } from '../src/training/types';
import { clipToolOutput, exampleTokens, messageTokens, windowExample } from '../src/training/window';

// Synthetic fixtures only. Secret-shaped strings are assembled at runtime.
const ghp = (n: number): string => 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6' + String(n).padStart(4, '0');

function call(name: string, params: Record<string, string>): string {
  return `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
}
function result(name: string, body: string): string {
  return `<tool_result name="${name}">\n${body}\n</tool_result>`;
}
function sessionFile(name: string, messages: Array<{ role: string; content: string }>): DiscoveredFile {
  return { path: `/tmp/sessions/${name}`, name, hash: name, text: messages.map(m => JSON.stringify(m)).join('\n'), mtimeMs: new Date(2026, 9, 3, 12).getTime() };
}
function stealthFile(name: string, events: object[]): DiscoveredFile {
  return { path: `/tmp/x/.bandit/turns/${name}`, name, hash: name, text: events.map(e => JSON.stringify(e)).join('\n'), mtimeMs: Date.now() };
}

/** A long agent trajectory in canonical form: task, N read steps, an edit, a test run, a final answer. */
function longTrajectory(steps: number, outputChars = 1600): CanonicalMessage[] {
  const msgs: CanonicalMessage[] = [{ role: 'system', content: 'You are Bandit.' }, { role: 'user', content: 'Fix the scoring bug in src/scoring.ts' }];
  for (let i = 0; i < steps; i++) {
    msgs.push({ role: 'assistant', content: `Step ${i}`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, name: 'read_file', content: `export const v${i} = ${i};\n`.repeat(Math.ceil(outputChars / 24)) });
  }
  msgs.push({ role: 'assistant', content: 'Editing.', tool_calls: [{ id: 'ce', type: 'function', function: { name: 'apply_edit', arguments: JSON.stringify({ path: 'src/scoring.ts', find: 'a', replace: 'b' }) } }] });
  msgs.push({ role: 'tool', tool_call_id: 'ce', name: 'apply_edit', content: 'ok' });
  msgs.push({ role: 'assistant', content: 'Testing.', tool_calls: [{ id: 'ct', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) } }] });
  msgs.push({ role: 'tool', tool_call_id: 'ct', name: 'run_command', content: 'PASS 12 tests' });
  msgs.push({ role: 'assistant', content: 'Fixed the off-by-one in scoring; tests pass.' });
  return msgs;
}

function assertWellFormed(messages: CanonicalMessage[]): void {
  expect(messages[0].role).toBe('system');
  expect(messages.at(-1)?.role).toBe('assistant');
  expect(messages[1].role).not.toBe('tool');
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {for (const c of m.tool_calls ?? []) {callIds.add(c.id);}}
    if (m.role === 'tool') {expect(callIds.has(m.tool_call_id)).toBe(true);}
  }
}

describe('context windowing', () => {
  it('keeps a trajectory that fits as one unchanged window', () => {
    const msgs = longTrajectory(1, 100);
    const r = windowExample(msgs, [], { budgetTokens: 7600, mode: 'chunks' });
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].messages).toEqual(msgs);
  });

  it('splits a long trajectory into budget-sized chunks that cover every assistant message exactly once', () => {
    const msgs = longTrajectory(12);
    const budget = 1400;
    const r = windowExample(msgs, [], { budgetTokens: budget, mode: 'chunks' });
    expect(r.rawTokens).toBeGreaterThan(budget);
    expect(r.windows.length).toBeGreaterThan(2);
    const seen: string[] = [];
    for (const w of r.windows) {
      expect(exampleTokens(w.messages)).toBeLessThanOrEqual(budget);
      assertWellFormed(w.messages);
      for (const m of w.messages) {if (m.role === 'assistant') {seen.push(m.content);}}
      if (w.droppedBefore > 0) {
        // The session's first task comes back with a compaction notice.
        expect(w.messages[1]).toMatchObject({ role: 'user' });
        expect(w.messages[1].content).toContain('Fix the scoring bug');
        expect(w.messages[1].content).toContain('Earlier conversation compacted');
      }
    }
    const allAssistant = msgs.filter(m => m.role === 'assistant').map(m => m.content);
    expect([...seen].sort()).toEqual([...allAssistant].sort());
    expect(r.windows.at(-1)!.messages.at(-1)!.content).toContain('tests pass');
  });

  it('tail mode keeps only the final window', () => {
    const r = windowExample(longTrajectory(12), [], { budgetTokens: 1400, mode: 'tail' });
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].messages.at(-1)!.content).toContain('tests pass');
  });

  it('counts tool schemas against the budget', () => {
    const msgs = longTrajectory(6, 400);
    const tools = Array.from({ length: 6 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `tool_${i}`, description: 'x'.repeat(300), parameters: { type: 'object' as const, properties: {}, required: [] } }
    }));
    const budget = 1500;
    for (const w of windowExample(msgs, tools, { budgetTokens: budget, mode: 'chunks' }).windows) {
      expect(exampleTokens(w.messages, tools)).toBeLessThanOrEqual(budget);
    }
  });

  it('only ends windows inside the example\'s own turn when targetFrom is set', () => {
    const history: CanonicalMessage[] = Array.from({ length: 6 }, (_, i) => [
      { role: 'user' as const, content: `earlier question ${i} ${'q'.repeat(400)}` },
      { role: 'assistant' as const, content: `earlier answer ${i} ${'a'.repeat(400)}` }
    ]).flat();
    const turn = longTrajectory(4).slice(1);
    const msgs: CanonicalMessage[] = [{ role: 'system', content: 'S' }, ...history, ...turn];
    const r = windowExample(msgs, [], { budgetTokens: 1400, mode: 'chunks', targetFrom: 1 + history.length });
    for (const w of r.windows) {expect(w.messages.at(-1)!.content).not.toMatch(/earlier answer/);}
  });

  it('clips long tool outputs head + tail with an elision marker', () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const c = clipToolOutput(body, 200);
    expect(c.clipped).toBe(true);
    expect(c.content.startsWith('line 0')).toBe(true);
    expect(c.content.endsWith('line 499')).toBe(true);
    expect(c.content).toMatch(/\[… \d+ lines elided …\]/);
    expect(messageTokens({ role: 'tool', tool_call_id: 'x', name: 'n', content: c.content })).toBeLessThan(400);
  });
});

describe('secrets: counted per window, not per session', () => {
  it('ignores entropy, email and path redactions in the drop threshold', () => {
    const counts = { ...emptyRedactions(), entropy: 40, email: 10, path: 30, secret: 2, file: 1 };
    expect(totalSecrets(counts)).toBe(3);
  });

  it('drops the secret-heavy turn but keeps later clean turns of the same session', () => {
    const leak = Array.from({ length: 30 }, (_, i) => ghp(i)).join('\n');
    const session = parseSession(sessionFile('20261003-120000-sec1.jsonl', [
      { role: 'user', content: 'show me the tokens file' },
      { role: 'assistant', content: call('run_command', { command: 'cat tokens.txt' }) },
      { role: 'user', content: result('run_command', leak) },
      { role: 'assistant', content: 'Those are GitHub tokens; rotate them.' },
      { role: 'user', content: 'now fix the readme typo' },
      { role: 'assistant', content: call('apply_edit', { path: 'README.md', find: 'teh', replace: 'the' }) },
      { role: 'user', content: result('apply_edit', 'ok') },
      { role: 'assistant', content: 'Fixed the typo.' }
    ]));
    const acc = newAccumulator();
    addCliSession(acc, session, [], new Set(), createScrubber(), { maxSecrets: 25, minQuality: 'none' });
    expect(acc.dropped.map(d => d.reason)).toContain('too-many-secrets');
    expect(acc.examples).toHaveLength(1);
    expect(acc.examples[0].messages.at(-1)!.content).toBe('Fixed the typo.');
  });
});

describe('hand-back filter', () => {
  const handback = (reply: string, extra: Array<{ role: string; content: string }> = []) => parseSession(sessionFile(`20261003-1300${String(reply.length).padStart(2, '0')}-hb.jsonl`, [
    { role: 'user', content: 'deploy the app to the cluster' },
    ...extra,
    { role: 'assistant', content: reply }
  ]));

  it('detects shell blocks, hand-back phrases and false capability claims when no command ran', () => {
    const turn = (reply: string, ran = false): CanonicalMessage[] => [
      { role: 'user', content: 'deploy it' },
      ...(ran ? [
        { role: 'assistant' as const, content: '', tool_calls: [{ id: 'r', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"kubectl get pods"}' } }] },
        { role: 'tool' as const, tool_call_id: 'r', name: 'run_command', content: 'pod/a Running' }
      ] : []),
      { role: 'assistant', content: reply }
    ];
    expect(detectHandBack(turn('Run this:\n```bash\nkubectl apply -f deploy.yaml\n```'))).toBe('shell-block-without-command');
    expect(detectHandBack(turn('```\nkubectl rollout status deploy/app\n```'))).toBe('shell-block-without-command');
    expect(detectHandBack(turn('You\'ll need to run the migration and paste the output.'))).toBe('handback-phrase');
    expect(detectHandBack(turn('I genuinely don\'t have access to your cluster, so check it yourself.'))).toBe('false-capability-claim');
    // A report of a command it already ran is not a hand-back.
    expect(detectHandBack(turn('Ran it:\n```bash\nkubectl get pods\n```\nAll pods are Running.', true))).toBeNull();
    expect(detectHandBack(turn('The build passes and the fix is in src/a.ts.'))).toBeNull();
  });

  it('excludes hand-backs from SFT by default and writes them as negatives', () => {
    const acc = newAccumulator();
    addCliSession(acc, handback('Run this:\n```bash\nkubectl apply -f k8s/\n```'), [], new Set(), createScrubber(), { minQuality: 'none' });
    expect(acc.examples).toHaveLength(0);
    expect(acc.dropped.map(d => d.reason)).toEqual(['hand-back']);
    expect(acc.negatives).toHaveLength(1);
    expect(acc.negatives[0].rejectedReason).toBe('shell-block-without-command');
    expect(acc.negatives[0].labels.handBack).toBe(true);
    expect(acc.handBacks['shell-block-without-command']).toBe(1);
  });

  it('keeps them, labelled, with includeHandbacks', () => {
    const acc = newAccumulator();
    addCliSession(acc, handback('I don\'t have access to your cluster.'), [], new Set(), createScrubber(), { minQuality: 'none', includeHandbacks: true });
    expect(acc.examples).toHaveLength(1);
    expect(acc.examples[0].labels.handBackReason).toBe('false-capability-claim');
  });

  it('leaves hand-back answers out of later turns\' history', () => {
    const session = parseSession(sessionFile('20261003-140000-hist.jsonl', [
      { role: 'user', content: 'check the deployment' },
      { role: 'assistant', content: 'Run this:\n```bash\nkubectl get pods\n```' },
      { role: 'user', content: 'fix the readme' },
      { role: 'assistant', content: call('apply_edit', { path: 'README.md', find: 'a', replace: 'b' }) },
      { role: 'user', content: result('apply_edit', 'ok') },
      { role: 'assistant', content: 'Done.' }
    ]));
    const acc = newAccumulator();
    addCliSession(acc, session, [], new Set(), createScrubber(), { minQuality: 'none' });
    expect(acc.examples).toHaveLength(1);
    expect(JSON.stringify(acc.examples[0].messages)).not.toContain('kubectl get pods');
  });
});

describe('quality labels and gate', () => {
  it('labels edited and verified turns and weights them higher', () => {
    const msgs = longTrajectory(1, 50).slice(1);
    const { edited, verified } = editVerifyLabels(msgs);
    expect(edited).toBe(true);
    expect(verified).toBe(true);
    expect(qualityWeight('completed', { edited, verified })).toBe(2);
    expect(qualityWeight('unknown', { edited: false, verified: false })).toBe(0.75);
    const readOnly = msgs.filter(m => !(m.role === 'assistant' && m.tool_calls?.some(c => c.function.name !== 'read_file')) && !(m.role === 'tool' && m.name !== 'read_file'));
    expect(editVerifyLabels(readOnly)).toEqual({ edited: false, verified: false });
  });

  it('applies the min-quality gate', () => {
    const labels = { ...emptyLabels(), toolCalls: 3, edited: false };
    expect(passesMinQuality('completed-or-unknown-with-tools', 'unknown', labels)).toBe(true);
    expect(passesMinQuality('completed-or-unknown-with-tools', 'unknown', { ...labels, toolCalls: 0 })).toBe(false);
    expect(passesMinQuality('completed-or-unknown-with-tools', 'failed', labels)).toBe(false);
    expect(passesMinQuality('completed', 'unknown', labels)).toBe(false);
    expect(passesMinQuality('edited', 'completed', labels)).toBe(false);
    expect(passesMinQuality('edited', 'completed', { ...labels, edited: true })).toBe(true);
    expect(passesMinQuality('none', 'failed', labels)).toBe(true);
  });

  it('drops tool-less unknown turns and failed turns by default', () => {
    const session = parseSession(sessionFile('20261003-150000-q.jsonl', [
      { role: 'user', content: 'what is a monad' },
      { role: 'assistant', content: 'A monoid in the category of endofunctors.' }
    ]));
    const acc = newAccumulator();
    addCliSession(acc, session, [], new Set(), createScrubber(), {});
    expect(acc.examples).toHaveLength(0);
    expect(acc.dropped.map(d => d.reason)).toEqual(['below-min-quality']);
  });
});

describe('near-duplicate windows', () => {
  it('hashes away ids, whitespace, case and digits', () => {
    const a: CanonicalMessage[] = [{ role: 'user', content: 'Bump to 1.2.3' }, { role: 'assistant', content: 'Done  in   v1.2.3' }];
    const b: CanonicalMessage[] = [{ role: 'user', content: 'bump to 4.5.6' }, { role: 'assistant', content: 'done in v4.5.6' }];
    expect(normalizedHash(a)).toBe(normalizedHash(b));
    expect(normalizedHash(a)).not.toBe(normalizedHash([{ role: 'user', content: 'something else' }]));
  });

  it('keeps the first of two near-identical stealth turns', () => {
    const turn = (name: string, version: string) => parseStealthWebTurn(stealthFile(name, [
      { type: 'meta', model: 'bandit-logic-2', goal: 'bump', startedAt: '2026-10-03T00:00:00Z' },
      { type: 'message', role: 'user', content: `bump the version to ${version}` },
      { type: 'message', role: 'assistant', content: 'Bumping.' },
      { type: 'tool_call', name: 'apply_edit', params: { path: 'package.json', find: '"version"', replace: `"version": "${version}"` }, output: 'ok', isError: false },
      { type: 'message', role: 'assistant', content: `Bumped to ${version}.` },
      { type: 'end', durationMs: 5, finalResponse: `Bumped to ${version}.` }
    ]))!;
    const acc = newAccumulator();
    const opts: BuildOptions = {};
    addStealthWebTurn(acc, turn('2026-10-03T00-00-00-000Z-aaaaa.jsonl', '1.2.3'), createScrubber(), opts);
    addStealthWebTurn(acc, turn('2026-10-03T00-00-01-000Z-bbbbb.jsonl', '1.2.4'), createScrubber(), opts);
    expect(acc.examples).toHaveLength(1);
    expect(acc.dropped.map(d => d.reason)).toEqual(['near-duplicate']);
  });
});
