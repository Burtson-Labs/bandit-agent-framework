/**
 * The nightly bench's deterministic brief — the path that must still send an
 * email when the model is unavailable. Covers the pure renderer, the input
 * collection (including degraded inputs), and the publish/email orchestration
 * with both network seams stubbed.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderBriefHtml, summarizeBrief, escapeHtml } from '../src/__eval__/briefHtml';
import { buildEvalJson } from '../src/__eval__/evalJson';
import {
  parseBriefArgs,
  collectBriefInput,
  runBrief,
  DEFAULT_RECIPIENTS,
  type BriefDeps
} from '../src/__eval__/briefRun';
import { compareToBaseline, type Baseline } from '../src/__eval__/baselineCompare';
import type { EvalJson } from '../src/__eval__/evalJson';
import type { EvalReport } from '../src/__eval__/types';

// ---- helpers ----

function evalJson(overrides: Partial<EvalJson> = {}): EvalJson {
  return {
    kind: 'bandit-eval-report',
    version: 1,
    provider: 'bandit',
    model: 'bandit-core-2',
    variant: 'cli',
    startedAt: '2026-09-12T09:00:00.000Z',
    totalWallTimeMs: 1_200_000,
    runsPerFixture: 1,
    totals: { fixtures: 3, passed: 2, failed: 1, skipped: 0 },
    fixtures: [
      {
        id: 'apply_edit.small_comment', description: 'edits a single line', passed: true,
        passRate: '1/1', runs: 1, failureReasons: [], medianWallMs: 19_000,
        medianIterations: 5, hitLimit: false
      },
      {
        id: 'restraint.no_tools_needed', description: 'answers without tools', passed: true,
        passRate: '1/1', runs: 1, failureReasons: [], medianWallMs: 4_000,
        medianIterations: 1, hitLimit: false
      },
      {
        id: 'native_tools.multi_file_doc_add', description: 'adds a doc across files', passed: false,
        passRate: '0/1', runs: 1,
        failureReasons: ['expected call matching write_file was never made'],
        medianWallMs: 171_000, medianIterations: 14, hitLimit: true
      }
    ],
    ...overrides
  };
}

function baseline(fixtures: Array<{ id: string; passed: boolean; wall?: number; tokens?: number }>): Baseline {
  return {
    kind: 'bandit-bench-baseline',
    version: 1,
    frozenAt: '2026-09-04T04:09:44.785Z',
    runsPerFixture: 3,
    models: [{
      label: 'bandit/bandit-core-2',
      variant: 'cli',
      fixtures: fixtures.map((f) => ({
        id: f.id,
        passRate: f.passed ? '3/3' : '0/3',
        passed: f.passed,
        medianWallMs: f.wall ?? 10_000,
        medianApproxTokens: f.tokens ?? 400,
        medianIterations: 4
      })),
      totals: {
        passedFixtures: fixtures.filter((f) => f.passed).length,
        fixtures: fixtures.length,
        totalWallTimeMs: 100_000
      }
    }]
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-brief-'));
}

function stubDeps(overrides: Partial<BriefDeps> = {}) {
  const published: Array<{ filename: string; content: string; contentType: string }> = [];
  const emails: Array<{ to: string; keyOrUrl: string; message: string }> = [];
  const deps: BriefDeps = {
    publish: async (opts) => {
      published.push({ filename: opts.filename, content: opts.content, contentType: opts.contentType });
      return { url: 'https://s3.burtson.ai/api/artifact/owner-1/brief.html' };
    },
    email: async (opts) => {
      emails.push({ to: opts.to, keyOrUrl: opts.keyOrUrl, message: opts.message });
      return { url: 'https://s3.burtson.ai/share/tok', emailed: true };
    },
    ...overrides
  };
  return { deps, published, emails };
}

// ---- summary / verdict ----

describe('summarizeBrief', () => {
  it('reports green only when nothing failed and nothing regressed', () => {
    const s = summarizeBrief({
      evalJson: evalJson({ totals: { fixtures: 3, passed: 3, failed: 0, skipped: 0 } }),
      comparison: { models: [], regressions: [], gains: [] }
    });
    expect(s.verdict).toBe('pass');
    expect(s.subject).toContain('green');
    expect(s.subject).toContain('3/3');
  });

  it('names failures and regressions in the subject', () => {
    const s = summarizeBrief({
      evalJson: evalJson(),
      comparison: { models: [], regressions: [{ model: 'bandit/bandit-core-2', id: 'a.b' }], gains: [] }
    });
    expect(s.verdict).toBe('fail');
    expect(s.failedFixtures).toBe(1);
    expect(s.regressions).toBe(1);
    expect(s.subject).toContain('1 failing');
    expect(s.subject).toContain('1 regression');
  });

  it('says NO RESULTS rather than green when the eval produced nothing', () => {
    // The whole point of the fallback: "we could not tell" must never read as
    // "everything passed".
    const s = summarizeBrief({ evalJson: null, comparison: null });
    expect(s.verdict).toBe('unknown');
    expect(s.subject).toContain('NO RESULTS');
    expect(s.subject).not.toContain('green');
  });

  it('counts a regression as failure even when every fixture passes', () => {
    const s = summarizeBrief({
      evalJson: evalJson({ totals: { fixtures: 3, passed: 3, failed: 0, skipped: 0 } }),
      comparison: { models: [], regressions: [{ model: 'm', id: 'x' }], gains: [] }
    });
    expect(s.verdict).toBe('fail');
  });
});

// ---- HTML ----

describe('renderBriefHtml', () => {
  it('is self-contained: no external scripts, styles, fonts or images', () => {
    const html = renderBriefHtml({ evalJson: evalJson(), comparison: null });
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css|woff2?|png|jpg|svg)/i);
    expect(html).toContain('name="viewport"');
  });

  it('shows pass/fail counts and names every failing fixture with its reason', () => {
    const html = renderBriefHtml({ evalJson: evalJson(), comparison: null });
    expect(html).toContain('2/3');
    expect(html).toContain('native_tools.multi_file_doc_add');
    expect(html).toContain('expected call matching write_file was never made');
    expect(html).toContain('hit iteration cap');
    // Passing fixtures are not listed individually — the brief is a one-screen
    // exception report, not a full matrix.
    expect(html).not.toContain('restraint.no_tools_needed');
  });

  it('lists regressions vs the frozen baseline', () => {
    const frozen = baseline([{ id: 'a.kept', passed: true }, { id: 'b.broke', passed: true }]);
    const current = baseline([{ id: 'a.kept', passed: true }, { id: 'b.broke', passed: false }]);
    const html = renderBriefHtml({ evalJson: evalJson(), comparison: compareToBaseline(frozen, current) });
    expect(html).toContain('b.broke');
    expect(html).toContain('now fail');
  });

  it('states plainly when there are no failures and no regressions', () => {
    const html = renderBriefHtml({
      evalJson: evalJson({
        totals: { fixtures: 3, passed: 3, failed: 0, skipped: 0 },
        fixtures: evalJson().fixtures.map((f) => ({ ...f, passed: true, passRate: '1/1', failureReasons: [] }))
      }),
      comparison: { models: [], regressions: [], gains: [] }
    });
    expect(html).toContain('No fixture failures');
    expect(html).toContain('No regressions');
  });

  it('surfaces brief notes so a degraded brief is visibly degraded', () => {
    const html = renderBriefHtml({ evalJson: null, comparison: null, notes: ['eval JSON report not found at /tmp/x.json — omitted from this brief.'] });
    expect(html).toContain('Brief notes');
    expect(html).toContain('not found at /tmp/x.json');
  });

  it('escapes HTML in fixture data so a failure message cannot break the page', () => {
    const nasty = evalJson({
      fixtures: [{
        id: '<img src=x onerror=alert(1)>', description: 'a & b', passed: false, passRate: '0/1',
        runs: 1, failureReasons: ['expected "<script>evil</script>"'], medianWallMs: 1, medianIterations: 1, hitLimit: false
      }],
      totals: { fixtures: 1, passed: 0, failed: 1, skipped: 0 }
    });
    const html = renderBriefHtml({ evalJson: nasty, comparison: null });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>evil');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('a &amp; b');
  });

  it('does not double the "runner error:" prefix the runner already wrote', () => {
    const json = evalJson({
      totals: { fixtures: 1, passed: 0, failed: 1, skipped: 0 },
      fixtures: [{
        id: 'x.y', description: 'd', passed: false, passRate: '0/1', runs: 1,
        failureReasons: [],
        error: 'runner error: Frontier (advanced model) session limit reached (250 / 5 hours).',
        medianWallMs: 1, medianIterations: 1, hitLimit: false
      }]
    });
    const html = renderBriefHtml({ evalJson: json, comparison: null });
    expect(html).not.toContain('runner error: runner error:');
    expect(html).toContain('runner error: Frontier (advanced model) session limit reached');
  });

  it('adds the prefix when the error lacks one', () => {
    const json = evalJson({
      totals: { fixtures: 1, passed: 0, failed: 1, skipped: 0 },
      fixtures: [{
        id: 'x.y', description: 'd', passed: false, passRate: '0/1', runs: 1,
        failureReasons: [], error: 'socket hang up',
        medianWallMs: 1, medianIterations: 1, hitLimit: false
      }]
    });
    expect(renderBriefHtml({ evalJson: json, comparison: null })).toContain('runner error: socket hang up');
  });

  it('keeps a total-wipeout night to one screen but names every failing fixture', () => {
    // 23 of 25 down (the frontier rate-limit night): detail blocks are capped,
    // yet no id is dropped — a name you never see is a bug you never fix.
    const fixtures = Array.from({ length: 23 }, (_, i) => ({
      id: `wipe.fixture_${i}`, description: 'd', passed: false, passRate: '0/1', runs: 1,
      failureReasons: ['expected agent to call a tool — got: (no tool calls)'],
      medianWallMs: 1200, medianIterations: 1, hitLimit: false
    }));
    const html = renderBriefHtml({
      evalJson: evalJson({ fixtures, totals: { fixtures: 25, passed: 2, failed: 23, skipped: 0 } }),
      comparison: null
    });

    expect(html).toContain('…and 11 more failing');
    for (const f of fixtures) expect(html).toContain(f.id);
  });

  it('escapeHtml covers the five dangerous characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

// ---- arg parsing ----

describe('parseBriefArgs', () => {
  it('defaults to both team recipients', () => {
    expect(parseBriefArgs([]).to).toEqual(DEFAULT_RECIPIENTS);
    expect(DEFAULT_RECIPIENTS).toEqual(['mark@burtson.ai', 'brett@burtson.com']);
  });

  it('accepts repeated --to and overrides the defaults', () => {
    expect(parseBriefArgs(['--to', 'a@x.com', '--to', 'b@y.com']).to).toEqual(['a@x.com', 'b@y.com']);
  });

  it('reads the input paths and the dry-run switch', () => {
    const a = parseBriefArgs(['--eval-json', 'e.json', '--bench-json', 'b.json', '--baseline', 'f.json', '--out', 'o.html', '--dry-run']);
    expect(a).toMatchObject({ evalJson: 'e.json', benchJson: 'b.json', baseline: 'f.json', out: 'o.html', dryRun: true });
  });
});

// ---- input collection ----

describe('collectBriefInput', () => {
  it('loads eval json and computes the baseline comparison', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(evalJson()));
    fs.writeFileSync(path.join(dir, 'frozen.json'), JSON.stringify(baseline([{ id: 'x', passed: true }])));
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(baseline([{ id: 'x', passed: false }])));

    const input = collectBriefInput({
      evalJson: path.join(dir, 'eval.json'),
      baseline: path.join(dir, 'frozen.json'),
      benchJson: path.join(dir, 'current.json'),
      out: path.join(dir, 'o.html'), to: ['a@b.c'], dryRun: true
    });

    expect(input.evalJson?.totals.failed).toBe(1);
    expect(input.comparison?.regressions.map((r) => r.id)).toEqual(['x']);
    expect(input.notes).toEqual([]);
  });

  it('degrades with a note instead of throwing when inputs are missing', () => {
    const dir = tmpdir();
    const input = collectBriefInput({
      evalJson: path.join(dir, 'nope.json'), out: path.join(dir, 'o.html'), to: ['a@b.c'], dryRun: true
    });
    expect(input.evalJson).toBeNull();
    expect(input.notes?.join(' ')).toContain('not found');
    expect(input.notes?.join(' ')).toContain('No eval results');
  });

  it('degrades with a note instead of throwing when an input is corrupt', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'eval.json'), '{ not json');
    const input = collectBriefInput({
      evalJson: path.join(dir, 'eval.json'), out: path.join(dir, 'o.html'), to: ['a@b.c'], dryRun: true
    });
    expect(input.evalJson).toBeNull();
    expect(input.notes?.join(' ')).toContain('could not be parsed');
  });
});

// ---- publish + email orchestration ----

describe('runBrief', () => {
  const env = { token: 'bai_test', s3ApiBaseUrl: 'https://s3.test', authBaseUrl: 'https://auth.test' };

  function args(dir: string, extra: Partial<ReturnType<typeof parseBriefArgs>> = {}) {
    fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(evalJson()));
    return {
      evalJson: path.join(dir, 'eval.json'),
      out: path.join(dir, 'brief.html'),
      to: [...DEFAULT_RECIPIENTS],
      dryRun: false,
      ...extra
    };
  }

  it('publishes the HTML once and emails BOTH recipients', async () => {
    const dir = tmpdir();
    const { deps, published, emails } = stubDeps();

    const result = await runBrief(args(dir), deps, env);

    expect(published).toHaveLength(1);
    expect(published[0].contentType).toBe('text/html');
    expect(published[0].filename).toMatch(/\.html$/);
    expect(published[0].content).toContain('<!doctype html>');

    expect(emails.map((e) => e.to)).toEqual(['mark@burtson.ai', 'brett@burtson.com']);
    // Both emails point at the SAME published artifact.
    expect(new Set(emails.map((e) => e.keyOrUrl)).size).toBe(1);
    expect(emails[0].keyOrUrl).toBe(result.url);
    expect(emails[0].message).toBe(result.subject);
    expect(result.emailed).toEqual(DEFAULT_RECIPIENTS);
    expect(result.failed).toEqual([]);
  });

  it('writes the rendered HTML to disk', async () => {
    const dir = tmpdir();
    const { deps } = stubDeps();
    const a = args(dir);
    await runBrief(a, deps, env);
    expect(fs.readFileSync(a.out, 'utf8')).toContain('native_tools.multi_file_doc_add');
  });

  it('still emails the second recipient when the first send throws', async () => {
    const dir = tmpdir();
    const seen: string[] = [];
    const { deps } = stubDeps({
      email: async (opts) => {
        seen.push(opts.to);
        if (opts.to === 'mark@burtson.ai') throw new Error('postmark 500');
        return { url: 'https://s3/share', emailed: true };
      }
    });

    const result = await runBrief(args(dir), deps, env);

    expect(seen).toEqual(['mark@burtson.ai', 'brett@burtson.com']);
    expect(result.failed).toEqual(['mark@burtson.ai']);
    expect(result.emailed).toEqual(['brett@burtson.com']);
    expect(result.notes.join(' ')).toContain('postmark 500');
  });

  it('treats emailed:false (mail unconfigured) as a failed send, not a success', async () => {
    const dir = tmpdir();
    const { deps } = stubDeps({ email: async () => ({ url: 'https://s3/share', emailed: false }) });
    const result = await runBrief(args(dir), deps, env);
    expect(result.emailed).toEqual([]);
    expect(result.failed).toEqual(DEFAULT_RECIPIENTS);
  });

  it('reports a publish failure without throwing, and skips the emails', async () => {
    const dir = tmpdir();
    const emails: string[] = [];
    const { deps } = stubDeps({
      publish: async () => { throw new Error('s3 503'); },
      email: async (o) => { emails.push(o.to); return { url: '', emailed: true }; }
    });

    const result = await runBrief(args(dir), deps, env);

    expect(result.url).toBeNull();
    expect(emails).toEqual([]);
    expect(result.failed).toEqual(DEFAULT_RECIPIENTS);
    expect(result.notes.join(' ')).toContain('s3 503');
  });

  it('still produces a brief when the eval output is missing entirely', async () => {
    const dir = tmpdir();
    const { deps, published } = stubDeps();
    const result = await runBrief(
      { evalJson: path.join(dir, 'absent.json'), out: path.join(dir, 'b.html'), to: ['mark@burtson.ai'], dryRun: false },
      deps, env
    );
    expect(published).toHaveLength(1);
    expect(result.subject).toContain('NO RESULTS');
    expect(result.emailed).toEqual(['mark@burtson.ai']);
  });

  it('--dry-run renders and writes but makes no network calls', async () => {
    const dir = tmpdir();
    const { deps, published, emails } = stubDeps();
    const a = args(dir, { dryRun: true });

    const result = await runBrief(a, deps, env);

    expect(published).toEqual([]);
    expect(emails).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.url).toBeNull();
    expect(fs.existsSync(a.out)).toBe(true);
  });
});

// ---- the eval JSON the brief consumes ----

describe('buildEvalJson', () => {
  function report(): EvalReport {
    return {
      provider: 'bandit',
      model: 'bandit-core-2',
      variant: 'cli',
      startedAt: '2026-09-12T09:00:00.000Z',
      totalWallTimeMs: 5000,
      fixtureResults: [
        {
          fixture: { id: 'ok.one', description: 'passes', prompt: 'p', assertions: {} },
          passed: true, passRate: '1/1',
          runs: [{ runNumber: 1, passed: true, failureReasons: [], toolCalls: [], iterations: 2, hitLimit: false, finalResponse: 'done', wallTimeMs: 100 }]
        },
        {
          fixture: { id: 'bad.one', description: 'fails', prompt: 'p', assertions: {} },
          passed: false, passRate: '0/2',
          runs: [
            { runNumber: 1, passed: false, failureReasons: ['expected agent to call write_file — got: read_file'], toolCalls: [], iterations: 8, hitLimit: true, finalResponse: '', wallTimeMs: 300 },
            { runNumber: 2, passed: false, failureReasons: ['expected agent to call write_file — got: read_file'], toolCalls: [], iterations: 4, hitLimit: false, finalResponse: '', wallTimeMs: 500, error: 'runner error:\n  boom' }
          ]
        },
        {
          fixture: { id: 'skip.one', description: 'skipped', prompt: 'p', assertions: {} },
          passed: false, passRate: '0/0', skipped: 'ollama only', runs: []
        }
      ]
    };
  }

  it('counts passed/failed/skipped the way the harness exit code does', () => {
    const json = buildEvalJson(report());
    expect(json.totals).toEqual({ fixtures: 3, passed: 1, failed: 1, skipped: 1 });
    expect(json.kind).toBe('bandit-eval-report');
  });

  it('dedupes repeated failure reasons and flattens them to one line', () => {
    const json = buildEvalJson(report());
    const failing = json.fixtures.find((f) => f.id === 'bad.one')!;
    expect(failing.failureReasons).toEqual(['expected agent to call write_file — got: read_file']);
    expect(failing.error).toBe('runner error: boom');
    expect(failing.hitLimit).toBe(true);
  });

  it('records runsPerFixture only when every fixture agreed', () => {
    expect(buildEvalJson(report()).runsPerFixture).toBeNull();  // 1, 2 and 0 runs
    const uniform = report();
    uniform.fixtureResults = [uniform.fixtureResults[0]];
    expect(buildEvalJson(uniform).runsPerFixture).toBe(1);
  });

  it('is JSON round-trippable (no RegExp or functions leak from Fixture)', () => {
    const json = buildEvalJson(report());
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('selectExpiredBriefs — the emailed briefs must not grow forever', () => {
  it('picks only brief/self-improve HTML artifacts older than the window', async () => {
    const { selectExpiredBriefs } = await import('../src/__eval__/briefRun');
    const now = new Date('2026-09-22T09:00:00Z');
    const day = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();
    const items = [
      { key: 'owner-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-banditbench-red-2026-09-01.html', lastModified: day(21) },
      { key: 'owner-1/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-banditbench-green-2026-09-20.html', lastModified: day(2) },
      { key: 'owner-1/cccccccccccccccccccccccccccccccc-self-improve-pr.html', lastModified: day(30) },
      { key: 'owner-1/dddddddddddddddddddddddddddddddd-RWT-Proposal-Draft.pdf', lastModified: day(90) },
      { key: 'owner-1/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-my-report.html', lastModified: day(90) },
      { key: 'owner-1/ffffffffffffffffffffffffffffffff-banditbench-brief-2026-08-01.html', lastModified: 'not a date' },
    ];
    expect(selectExpiredBriefs(items, now)).toEqual([
      'owner-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-banditbench-red-2026-09-01.html',
      'owner-1/cccccccccccccccccccccccccccccccc-self-improve-pr.html',
    ]);
    expect(selectExpiredBriefs(items, now, 60)).toEqual([]);
  });
});
