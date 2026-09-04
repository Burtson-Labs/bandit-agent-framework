/**
 * Baseline comparison — the "prove lift" instrument. Properties: a
 * pass→fail flip is a regression (the CI-gating signal), fail→pass is a gain,
 * material wall/token shifts surface while noise stays quiet, and added /
 * removed / dropped-model cases are all named rather than silently ignored.
 */
import { describe, it, expect } from 'vitest';
import { compareToBaseline, renderComparison, type Baseline, type BaselineModel } from '../src/__eval__/baselineCompare';

function model(label: string, fixtures: BaselineModel['fixtures']): BaselineModel {
  return {
    label,
    variant: 'cli',
    fixtures,
    totals: { passedFixtures: fixtures.filter((f) => f.passed).length, fixtures: fixtures.length, totalWallTimeMs: 0 },
  };
}
function fx(id: string, passed: boolean, wallMs = 1000, tokens = 400) {
  return { id, passed, passRate: passed ? '3/3' : '0/3', medianWallMs: wallMs, medianApproxTokens: tokens, medianIterations: 2 };
}
function baseline(models: BaselineModel[]): Baseline {
  return { kind: 'bandit-bench-baseline', version: 1, frozenAt: '2026-09-01T00:00:00Z', runsPerFixture: 3, models };
}

describe('compareToBaseline — pass/fail transitions', () => {
  const before = baseline([model('m', [fx('a', true), fx('b', true), fx('c', false)])]);

  it('flags a pass→fail as a regression and fail→pass as a gain', () => {
    const after = baseline([model('m', [fx('a', true), fx('b', false), fx('c', true)])]);
    const cmp = compareToBaseline(before, after);
    expect(cmp.regressions).toEqual([{ model: 'm', id: 'b' }]);
    expect(cmp.gains).toEqual([{ model: 'm', id: 'c' }]);
    expect(cmp.models[0].passedBefore).toBe(2);
    expect(cmp.models[0].passedNow).toBe(2);
  });

  it('identical run has zero regressions and zero gains (CI-clean)', () => {
    const cmp = compareToBaseline(before, before);
    expect(cmp.regressions).toHaveLength(0);
    expect(cmp.gains).toHaveLength(0);
  });
});

describe('compareToBaseline — performance deltas', () => {
  it('computes wall/token percentage moves', () => {
    const before = baseline([model('m', [fx('a', true, 1000, 400)])]);
    const after = baseline([model('m', [fx('a', true, 1500, 300)])]);
    const d = compareToBaseline(before, after).models[0].fixtures[0];
    expect(d.wallPct).toBeCloseTo(0.5);      // +50% slower
    expect(d.tokenPct).toBeCloseTo(-0.25);   // -25% tokens
    expect(d.status).toBe('unchanged');       // still passing
  });

  it('render surfaces material shifts and stays quiet on noise', () => {
    const before = baseline([model('m', [fx('a', true, 1000, 400), fx('b', true, 1000, 400)])]);
    const after = baseline([model('m', [fx('a', true, 1400, 400), fx('b', true, 1050, 400)])]); // a +40%, b +5%
    const out = renderComparison(compareToBaseline(before, after));
    expect(out).toMatch(/a: wall \+40%/);
    expect(out).not.toMatch(/\bb:/);         // 5% is below the 20% floor
    expect(out).toMatch(/no regressions/);
  });
});

describe('compareToBaseline — set changes', () => {
  it('names added fixtures, removed fixtures, and dropped models', () => {
    const before = baseline([
      model('m', [fx('a', true), fx('gone', true)]),
      model('retired', [fx('a', true)]),
    ]);
    const after = baseline([model('m', [fx('a', true), fx('brand-new', true)])]);
    const cmp = compareToBaseline(before, after);
    const m = cmp.models.find((x) => x.label === 'm')!;
    expect(m.fixtures.find((f) => f.id === 'brand-new')?.status).toBe('added');
    expect(m.fixtures.find((f) => f.id === 'gone')?.status).toBe('removed');
    expect(cmp.models.find((x) => x.label === 'retired')?.presence).toBe('dropped');
  });

  it('a model only in the current run is "new", not a regression', () => {
    const before = baseline([model('m', [fx('a', true)])]);
    const after = baseline([model('m', [fx('a', true)]), model('candidate', [fx('a', true)])]);
    const cmp = compareToBaseline(before, after);
    expect(cmp.models.find((x) => x.label === 'candidate')?.presence).toBe('new');
    expect(cmp.regressions).toHaveLength(0);
  });
});
