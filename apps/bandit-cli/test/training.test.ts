import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { convertTranscript, parseAssistant, parseToolResults, stripBanditFences, stripTemplateLeaks } from '../src/training/protocol';
import { createScrubber, looksLikeSecretToken, parseDenylist, selfCheckText, SECRET, REDACTED_FILE } from '../src/training/scrub';
import {
  addCliSession,
  addStealthWebTurn,
  dropReasonForTools,
  joinSessionTurns,
  newAccumulator,
  splitTurns
} from '../src/training/build';
import { findTurnDirs, normalizeModel, parseHostTurn, parseSession, parseStealthWebTurn, readUniqueJsonl, type DiscoveredFile, type HostTurn } from '../src/training/sources';
import { buildRunTrace } from '../src/__eval__/traceOut';
import { emptyLabels, emptyRedactions, type CanonicalMessage, type TrainingExample } from '../src/training/types';

// All fixtures below are synthetic. Never paste real session content into this file.
// Secret-shaped strings are assembled at runtime so the repo itself holds no key-shaped literals.
const fake = {
  ghp: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END ' + 'RSA PRIVATE KEY-----',
  bai: 'bai_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2',
  entropy: 'q8Zr2Lm9Xv4Tn7Kp3Wb6Yc1Hd5Gf0Js8A'
};

function call(name: string, params: Record<string, string>): string {
  return `<tool_call>${JSON.stringify({ name, params })}</tool_call>`;
}
function result(name: string, body: string, error = false): string {
  return `<tool_result name="${name}"${error ? ' status="error"' : ''}>\n${body}\n</tool_result>`;
}
function file(name: string, text: string, mtimeMs = Date.now()): DiscoveredFile {
  return { path: `/tmp/x/.bandit/turns/${name}`, name, hash: name, text, mtimeMs };
}
function example(messages: CanonicalMessage[]): TrainingExample {
  return {
    id: '', source: 'cli-session', sourceRef: 'sessions/x#1', createdAt: new Date(0).toISOString(), model: null, status: 'completed',
    labels: emptyLabels(), tools: [], messages,
    scrub: { version: 'scrub-v1', redactions: emptyRedactions(), dropped: false }, split: null
  };
}

describe('protocol conversion', () => {
  it('turns inline tool calls and result envelopes into tool_calls + tool messages', () => {
    const { messages, stats } = convertTranscript([
      { role: 'user', content: 'read the readme' },
      { role: 'assistant', content: `Let me look.\n${call('read_file', { path: 'README.md' })}` },
      { role: 'user', content: result('read_file', '# Title') },
      { role: 'assistant', content: 'It is a title.' }
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'read the readme' },
      { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '# Title' },
      { role: 'assistant', content: 'It is a title.' }
    ]);
    expect(stats.toolCalls).toBe(1);
  });

  it('keeps error results with an ERROR: prefix and matches multiple results by name', () => {
    const { messages, stats } = convertTranscript([
      { role: 'user', content: 'do two things' },
      { role: 'assistant', content: call('list_files', { path: '.' }) + call('run_command', { command: 'npm test' }) },
      { role: 'user', content: result('run_command', 'exit 1', true) + '\n' + result('list_files', 'a.ts') }
    ]);
    const tools = messages.filter(m => m.role === 'tool') as Array<Extract<CanonicalMessage, { role: 'tool' }>>;
    expect(tools.map(t => [t.name, t.tool_call_id, t.content])).toEqual([
      ['run_command', 'call_2', 'ERROR: exit 1'],
      ['list_files', 'call_1', 'a.ts']
    ]);
    expect(stats.toolErrors).toBe(1);
  });

  it('keeps compacted tool results verbatim', () => {
    const compacted = '[earlier run, 120 lines elided…]\nlast lines';
    const { messages } = convertTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: call('run_command', { command: 'ls' }) },
      { role: 'user', content: result('run_command', compacted) }
    ]);
    expect(messages[2]).toMatchObject({ role: 'tool', content: compacted });
  });

  it('drops harness nudges unless asked to keep them', () => {
    const nudge = 'AUTOMATED HARNESS CHECK — this is NOT a message from the user. Use a tool.';
    expect(convertTranscript([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x' }, { role: 'user', content: nudge }]).messages).toHaveLength(2);
    expect(convertTranscript([{ role: 'user', content: nudge }], { keepNudges: true }).messages).toHaveLength(1);
  });

  it('counts malformed tool calls and leaves them out', () => {
    const parsed = parseAssistant('ok <tool_call>{not json}</tool_call>');
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedCalls).toBe(1);
    expect(parsed.content).toBe('ok');
  });

  it('leaves out tool results that have no open call', () => {
    const { messages, stats } = convertTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'no call here' },
      { role: 'user', content: result('run_command', 'stray output') }
    ]);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(stats.unmatchedResults).toBe(1);
  });

  it('returns null for user messages that are not tool-result carriers', () => {
    expect(parseToolResults('plain question')).toBeNull();
  });
});

describe('fence and template stripping', () => {
  it('removes host-emitted bandit-* fences and lifts bandit-reasoning out', () => {
    const text = 'Before\n```bandit-tl\n{"tool":"read_file"}\n```\nMiddle\n````bandit-reasoning\nthinking with ``` inside\n````\nAfter';
    const out = stripBanditFences(text);
    expect(out.text).not.toContain('bandit-tl');
    expect(out.text).toContain('Before');
    expect(out.text).toContain('Middle');
    expect(out.text).toContain('After');
    expect(out.reasoning).toEqual(['thinking with ``` inside']);
  });

  it('puts <think> and fenced reasoning into reasoning, not content', () => {
    const p = parseAssistant('<think>plan it</think>Answer');
    expect(p.reasoning).toBe('plan it');
    expect(p.content).toBe('Answer');
  });

  it('strips chat-template leaks', () => {
    expect(stripTemplateLeaks('done</start_of_turn><|im_end|><end_of_turn>')).toBe('done');
  });
});

describe('scrub-v1', () => {
  const scrub = createScrubber(parseDenylist('client: Example Client Co\nperson: Jane Placeholder\n# comment\n'));
  const counts = () => emptyRedactions();

  it('redacts token-shaped secrets, JWTs and PEM blocks', () => {
    const c = counts();
    const out = scrub.scrubText(`gh ${fake.ghp} aws ${fake.aws} jwt ${fake.jwt}\n${fake.pem}\nkey ${fake.bai}`, c);
    for (const v of [fake.ghp, fake.aws, fake.jwt, 'PRIVATE KEY', fake.bai]) expect(out).not.toContain(v);
    expect(out).toContain(SECRET);
    expect(c.secret).toBeGreaterThanOrEqual(5);
  });

  it('redacts connection strings but keeps the scheme', () => {
    const c = counts();
    const out = scrub.scrubText('url mongodb://admin:hunter2pass@db.internal:27017/app and Server=x;User Id=sa;Password=Sup3rS3cret!;', c);
    expect(out).toContain('mongodb://[SECRET]');
    expect(out).not.toContain('hunter2pass');
    expect(out).not.toContain('Sup3rS3cret');
  });

  it('redacts quoted secret literals but leaves code that references env vars alone', () => {
    const c = counts();
    const code = 'const token = process.env.GITHUB_TOKEN;\nconfig = { password: process.env.DB_PASSWORD }';
    expect(scrub.scrubText(code, c)).toBe(code);
    expect(scrub.scrubText('api_key: "abcd1234efgh5678"', counts())).toContain(SECRET);
  });

  it('redacts high-entropy mixed tokens but not git hashes or identifiers', () => {
    expect(looksLikeSecretToken(fake.entropy)).toBe(true);
    expect(looksLikeSecretToken('3f6e0797fad420a39bd33979eb6e840e30989e34')).toBe(false);
    expect(looksLikeSecretToken('createDefaultSkillRegistryWithMap')).toBe(false);
    const c = counts();
    expect(scrub.scrubText(`token ${fake.entropy}`, c)).toBe(`token ${SECRET}`);
    expect(c.entropy).toBe(1);
  });

  it('replaces emails, phones and home paths', () => {
    const c = counts();
    const out = scrub.scrubText('mail someone@acme-corp.io or call (555) 123-4567; file /Users/someone/Documents/x.ts; git@github.com:org/repo', c);
    expect(out).toContain('user@example.com');
    expect(out).toContain('[PHONE]');
    expect(out).toContain('~/Documents/x.ts');
    expect(out).toContain('git@github.com');
    expect(c.email).toBe(1);
    expect(c.phone).toBe(1);
    expect(c.path).toBe(1);
  });

  it('applies the denylist as [CLIENT] / [PERSON], whole words only', () => {
    const c = counts();
    const out = scrub.scrubText('Proposal for example client co, reviewed by Jane  Placeholder; JaneDoe stays.', c);
    expect(out).toBe('Proposal for [CLIENT], reviewed by [PERSON]; JaneDoe stays.');
    expect(c.client).toBe(1);
    expect(c.person).toBe(1);
  });

  it('replaces whole results of sensitive file reads and scrubs tool arguments', () => {
    const ex = scrub.scrubExample(example([
      { role: 'user', content: 'show env' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'api/.env' }) } },
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/Users/someone/app/appsettings.Production.json' }) } },
        { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) } }
      ] },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'DB=whatever' },
      { role: 'tool', tool_call_id: 'call_2', name: 'read_file', content: '{"x":1}' },
      { role: 'tool', tool_call_id: 'call_3', name: 'read_file', content: 'export const a = 1;' }
    ]));
    const tools = ex.messages.filter(m => m.role === 'tool') as Array<Extract<CanonicalMessage, { role: 'tool' }>>;
    expect(tools.map(t => t.content)).toEqual([REDACTED_FILE, REDACTED_FILE, 'export const a = 1;']);
    expect(ex.scrub.redactions.file).toBe(2);
    const args = (ex.messages[1] as Extract<CanonicalMessage, { role: 'assistant' }>).tool_calls![1].function.arguments;
    expect(JSON.parse(args).path).toBe('~/app/appsettings.Production.json');
  });

  it('redacts credentials embedded in any URL but keeps asset names like icon@2x.png', () => {
    const c = counts();
    const out = scrub.scrubText('remote https://someone:' + 'ghtoken12345@github.com/org/repo.git and icon@2x.png', c);
    expect(out).toContain('https://[SECRET]@github.com/org/repo.git');
    expect(out).toContain('icon@2x.png');
    expect(c.email).toBe(0);
  });

  it('self-check flags anything secret-looking that survived', () => {
    expect(selfCheckText('ex_1', `left ${fake.ghp}`).map(h => h.kind)).toContain('github-token');
    expect(selfCheckText('ex_1', 'clean text with user@example.com and ~/repo')).toEqual([]);
  });
});

describe('drop rules', () => {
  const withTool = (name: string, args = '{}') => [
    { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name, arguments: args } }] }
  ];
  it('drops email/calendar tools and client-document reads', () => {
    expect(dropReasonForTools(withTool('burtson-labs.gmail_modifyMessageLabels'))).toBe('email-or-calendar-tools');
    expect(dropReasonForTools(withTool('mail_search'))).toBe('email-or-calendar-tools');
    expect(dropReasonForTools(withTool('read_pdf', JSON.stringify({ path: '~/.bandit/artifacts/proposal.pdf' })))).toBe('client-document-tools');
    expect(dropReasonForTools(withTool('read_file'))).toBeNull();
  });

  it('drops imported Stealth web transcripts and too-secret examples', () => {
    const acc = newAccumulator();
    const scrub = createScrubber();
    const imported = parseStealthWebTurn(file('2026-07-01T00-00-00-000Z-abcde.jsonl', [
      JSON.stringify({ type: 'meta', model: 'x', goal: 'g', startedAt: '2026-07-01T00:00:00Z', provider: 'import' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'hi' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hello' })
    ].join('\n')))!;
    addStealthWebTurn(acc, imported, scrub, {});
    const leaky = parseStealthWebTurn(file('2026-07-02T00-00-00-000Z-fghij.jsonl', [
      JSON.stringify({ type: 'meta', model: 'x', goal: 'g', startedAt: '2026-07-02T00:00:00Z' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'keys' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: `${fake.ghp} ${fake.aws} ${fake.bai}` }),
      JSON.stringify({ type: 'end', durationMs: 1 })
    ].join('\n')))!;
    addStealthWebTurn(acc, leaky, scrub, { maxSecrets: 2 });
    expect(acc.examples).toHaveLength(0);
    expect(acc.dropped.map(d => d.reason)).toEqual(['imported-transcript', 'too-many-secrets']);
  });
});

describe('session taint', () => {
  it('drops every later turn of a session once a turn used mail tools', () => {
    const session = parseSession({
      path: '/tmp/sessions/20260702-100000-efgh.jsonl', name: '20260702-100000-efgh.jsonl', hash: 'h2', mtimeMs: new Date(2026, 6, 2, 10, 30).getTime(),
      text: [
        { role: 'user', content: 'triage my inbox' },
        { role: 'assistant', content: call('burtson-labs.gmail_search', { q: 'is:unread' }) },
        { role: 'user', content: result('burtson-labs.gmail_search', 'From: someone') },
        { role: 'assistant', content: 'You have 3 unread.' },
        { role: 'user', content: 'summarize the second one' },
        { role: 'assistant', content: 'It says hello.' }
      ].map(m => JSON.stringify(m)).join('\n')
    });
    const acc = newAccumulator();
    addCliSession(acc, session, [], new Set(), createScrubber(), {});
    expect(acc.examples).toHaveLength(0);
    expect(acc.dropped.map(d => d.reason)).toEqual(['email-or-calendar-tools', 'email-or-calendar-tools']);
  });
});

describe('stealth web turn logs', () => {
  it('rebuilds tool calls from tool_call events with outputs', () => {
    const acc = newAccumulator();
    const turn = parseStealthWebTurn(file('2026-07-03T00-00-00-000Z-klmno.jsonl', [
      JSON.stringify({ type: 'meta', model: 'bandit-logic-2', goal: 'read', startedAt: '2026-07-03T00:00:00Z' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'read a.ts' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Reading.' }),
      JSON.stringify({ type: 'tool_call', name: 'read_file', params: { path: 'a.ts' }, output: 'const a = 1;', isError: false }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'a is 1.' }),
      JSON.stringify({ type: 'end', durationMs: 5, finalResponse: 'a is 1.' })
    ].join('\n')))!;
    addStealthWebTurn(acc, turn, createScrubber(), {});
    expect(acc.examples).toHaveLength(1);
    const ex = acc.examples[0];
    expect(ex.model).toBe('bandit-logic-2');
    expect(ex.status).toBe('completed');
    expect(ex.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(ex.tools.map(t => t.function.name)).toEqual(['read_file']);
  });
});

describe('session ↔ turn-log join', () => {
  const session = parseSession({
    path: '/tmp/sessions/20260701-100000-abcd.jsonl', name: '20260701-100000-abcd.jsonl', hash: 'h', mtimeMs: new Date(2026, 6, 1, 10, 30, 0).getTime(),
    text: [
      { role: 'user', content: 'first question about the build' },
      { role: 'assistant', content: call('run_command', { command: 'npm run build' }) },
      { role: 'user', content: result('run_command', 'ok') },
      { role: 'assistant', content: 'Build passes.' },
      { role: 'user', content: 'second question with @file expanded differently' },
      { role: 'assistant', content: 'Done.' }
    ].map(m => JSON.stringify(m)).join('\n')
  });
  const turn = (name: string, at: Date, prompt: string, extra: object[] = []): HostTurn => parseHostTurn(file(name, [
    { t: at.toISOString(), type: 'user-prompt', prompt },
    { t: at.toISOString(), type: 'llm-start', model: 'bandit-core-2', iteration: 1 },
    ...extra,
    { t: at.toISOString(), type: 'final-response', response: 'x', iterations: 1 }
  ].map(e => JSON.stringify(e)).join('\n')))!;

  it('matches by prompt prefix first, then by order inside the window', () => {
    const t1 = turn('turn-a.jsonl', new Date(2026, 6, 1, 10, 1, 0), 'first question about the build');
    const t2 = turn('turn-b.jsonl', new Date(2026, 6, 1, 10, 5, 0), 'second question with src/a.ts expanded');
    const far = turn('turn-c.jsonl', new Date(2026, 6, 3, 10, 5, 0), 'second question with src/a.ts expanded');
    const used = new Set<string>();
    const join = joinSessionTurns(session, [far, t2, t1], used);
    expect(join.matchedByPrompt).toBe(1);
    expect(join.matchedByOrder).toBe(1);
    expect(join.matches.get(0)?.path).toBe(t1.path);
    expect(join.matches.get(1)?.path).toBe(t2.path);
  });

  it('labels examples from the joined turn and carries compact history', () => {
    const t1 = turn('turn-a.jsonl', new Date(2026, 6, 1, 10, 1, 0), 'first question about the build', [{ type: 'permission-denied' }]);
    const acc = newAccumulator();
    addCliSession(acc, session, [t1], new Set(), createScrubber(), {});
    expect(splitTurns(session.messages)).toHaveLength(2);
    expect(acc.examples).toHaveLength(2);
    expect(acc.examples[0].model).toBe('bandit-core-2');
    expect(acc.examples[0].labels.permissionDenials).toBe(1);
    expect(acc.examples[1].status).toBe('unknown');
    expect(acc.examples[1].labels.historyTurns).toBe(1);
    expect(acc.examples[1].messages.slice(1, 3)).toEqual([
      { role: 'user', content: 'first question about the build' },
      { role: 'assistant', content: 'Build passes.' }
    ]);
  });
});

describe('model names', () => {
  it('strips display prefixes', () => {
    expect(normalizeModel('Bandit Cloud · bandit-logic-2')).toBe('bandit-logic-2');
    expect(normalizeModel('gemma4:12b')).toBe('gemma4:12b');
  });
});

describe('discovery and dedupe', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bandit-train-'));
    for (const repo of ['one', 'two', 'node_modules/pkg']) {
      const dir = path.join(root, repo, '.bandit', 'turns');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'turn-same.jsonl'), '{"type":"user-prompt","prompt":"x"}\n');
    }
    await fs.promises.writeFile(path.join(root, 'two', '.bandit', 'turns', 'turn-other.jsonl'), '{"type":"user-prompt","prompt":"y"}\n');
  });
  afterAll(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('finds .bandit/turns dirs, skipping vendor dirs', async () => {
    const dirs = await findTurnDirs([root]);
    expect(dirs.map(d => path.relative(root, d))).toEqual([path.join('one', '.bandit', 'turns'), path.join('two', '.bandit', 'turns')]);
  });

  it('drops byte-identical copies of the same file', async () => {
    const { files, duplicates } = await readUniqueJsonl(await findTurnDirs([root]));
    expect(files.map(f => f.name).sort()).toEqual(['turn-other.jsonl', 'turn-same.jsonl']);
    expect(duplicates).toBe(1);
  });
});

describe('banditbench trace-out', () => {
  it('writes a canonical example with pass/fail labels', () => {
    const trace = buildRunTrace({
      fixtureId: 'read-then-answer', runNumber: 2, model: 'bandit-core-2', systemPrompt: 'SYS', tools: [],
      messages: [
        { role: 'user', content: 'what is in a.ts?' },
        { role: 'assistant', content: call('read_file', { path: 'a.ts' }) },
        { role: 'user', content: result('read_file', 'const a = 1;') },
        { role: 'assistant', content: 'a is 1' }
      ],
      hitLimit: false, passed: false, failureReasons: ['finalResponse did not match']
    });
    expect(trace.source).toBe('banditbench');
    expect(trace.labels).toMatchObject({ passed: false, failureReasons: ['finalResponse did not match'], fixtureId: 'read-then-answer', toolCalls: 1 });
    expect(trace.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(trace.id).toMatch(/^ex_[0-9a-f]{12}$/);
  });
});
