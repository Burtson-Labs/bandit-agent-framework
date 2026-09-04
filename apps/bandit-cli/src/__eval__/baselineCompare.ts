/**
 * BanditBench baseline comparison — the "prove lift" instrument (Phase 10).
 *
 * A frozen baseline (benchmark --baseline) captures per-fixture success, wall
 * time, and approx tokens for a model set. `compareToBaseline` diffs a fresh
 * run's baseline object against it and reports, per model + per fixture, what
 * moved: newly passing, newly FAILING (a regression — the thing routing/model
 * changes must not silently introduce), and material shifts in wall time or
 * tokens. Pure and serializable so it unit-tests without running a model and
 * a CI job can gate on `regressions.length === 0`.
 */

export interface BaselineFixture {
  id: string;
  passRate: string;
  passed: boolean;
  skipped?: string;
  medianWallMs: number;
  medianApproxTokens: number;
  medianIterations: number;
}

export interface BaselineModel {
  label: string;
  variant?: string;
  fixtures: BaselineFixture[];
  totals: { passedFixtures: number; fixtures: number; totalWallTimeMs: number };
}

export interface Baseline {
  kind: string;
  version: number;
  frozenAt: string;
  runsPerFixture: number;
  models: BaselineModel[];
}

export interface FixtureDelta {
  id: string;
  /** 'gained' newly passes · 'regressed' newly fails · 'unchanged' · 'added' · 'removed'. */
  status: 'gained' | 'regressed' | 'unchanged' | 'added' | 'removed';
  wasPassed?: boolean;
  nowPassed?: boolean;
  wallMsDelta?: number;
  tokenDelta?: number;
  wallPct?: number;
  tokenPct?: number;
}

export interface ModelDelta {
  label: string;
  /** Present in both baselines? A label only in `current` is 'new'. */
  presence: 'both' | 'new' | 'dropped';
  passedBefore?: number;
  passedNow?: number;
  fixtures: FixtureDelta[];
  regressions: FixtureDelta[];
  gains: FixtureDelta[];
}

export interface BaselineComparison {
  models: ModelDelta[];
  /** Flat list across all models — CI gates on this being empty. */
  regressions: Array<{ model: string; id: string }>;
  gains: Array<{ model: string; id: string }>;
}

/** Material-change thresholds — smaller shifts are noise, not signal. */
const WALL_PCT = 0.2;   // 20% wall-time move
const TOKEN_PCT = 0.2;  // 20% token move

function pct(now: number, was: number): number {
  if (was === 0) return now === 0 ? 0 : 1;
  return (now - was) / was;
}

function diffModel(before: BaselineModel | undefined, after: BaselineModel): ModelDelta {
  const beforeById = new Map((before?.fixtures ?? []).map((f) => [f.id, f]));
  const afterById = new Map(after.fixtures.map((f) => [f.id, f]));
  const fixtures: FixtureDelta[] = [];

  for (const now of after.fixtures) {
    const was = beforeById.get(now.id);
    if (!was) {
      fixtures.push({ id: now.id, status: 'added', nowPassed: now.passed });
      continue;
    }
    const wallMsDelta = now.medianWallMs - was.medianWallMs;
    const tokenDelta = now.medianApproxTokens - was.medianApproxTokens;
    const base: FixtureDelta = {
      id: now.id,
      status: 'unchanged',
      wasPassed: was.passed,
      nowPassed: now.passed,
      wallMsDelta,
      tokenDelta,
      wallPct: pct(now.medianWallMs, was.medianWallMs),
      tokenPct: pct(now.medianApproxTokens, was.medianApproxTokens),
    };
    if (was.passed && !now.passed) base.status = 'regressed';
    else if (!was.passed && now.passed) base.status = 'gained';
    fixtures.push(base);
  }
  // Fixtures that existed before but are gone now.
  for (const was of before?.fixtures ?? []) {
    if (!afterById.has(was.id)) fixtures.push({ id: was.id, status: 'removed', wasPassed: was.passed });
  }

  return {
    label: after.label,
    presence: before ? 'both' : 'new',
    passedBefore: before?.totals.passedFixtures,
    passedNow: after.totals.passedFixtures,
    fixtures,
    regressions: fixtures.filter((f) => f.status === 'regressed'),
    gains: fixtures.filter((f) => f.status === 'gained'),
  };
}

export function compareToBaseline(baseline: Baseline, current: Baseline): BaselineComparison {
  const beforeByLabel = new Map(baseline.models.map((m) => [m.label, m]));
  const currentLabels = new Set(current.models.map((m) => m.label));
  const models: ModelDelta[] = current.models.map((m) => diffModel(beforeByLabel.get(m.label), m));

  // Models present in the baseline but absent now → flagged 'dropped'.
  for (const m of baseline.models) {
    if (!currentLabels.has(m.label)) {
      models.push({
        label: m.label,
        presence: 'dropped',
        passedBefore: m.totals.passedFixtures,
        fixtures: [],
        regressions: [],
        gains: [],
      });
    }
  }

  const regressions = models.flatMap((m) => m.regressions.map((r) => ({ model: m.label, id: r.id })));
  const gains = models.flatMap((m) => m.gains.map((g) => ({ model: m.label, id: g.id })));
  return { models, regressions, gains };
}

/** Render a comparison as a human report. `color` wraps status tokens. */
export function renderComparison(
  cmp: BaselineComparison,
  color?: { good: (s: string) => string; bad: (s: string) => string; dim: (s: string) => string }
): string {
  const good = color?.good ?? ((s: string) => s);
  const bad = color?.bad ?? ((s: string) => s);
  const dim = color?.dim ?? ((s: string) => s);
  const lines: string[] = ['# Baseline comparison', ''];
  for (const m of cmp.models) {
    if (m.presence === 'dropped') {
      lines.push(`## ${m.label} — ${bad('DROPPED (was in baseline, not in this run)')}`, '');
      continue;
    }
    const head = m.presence === 'new'
      ? `## ${m.label} — ${dim('new (not in baseline)')}`
      : `## ${m.label} — passed ${m.passedBefore} → ${m.passedNow}`;
    lines.push(head);
    if (m.regressions.length > 0) {
      lines.push(bad(`  ✗ ${m.regressions.length} regression(s): ${m.regressions.map((r) => r.id).join(', ')}`));
    }
    if (m.gains.length > 0) {
      lines.push(good(`  ✓ ${m.gains.length} gain(s): ${m.gains.map((g) => g.id).join(', ')}`));
    }
    const perf = m.fixtures.filter(
      (f) => (f.wallPct !== undefined && Math.abs(f.wallPct) >= WALL_PCT) ||
             (f.tokenPct !== undefined && Math.abs(f.tokenPct) >= TOKEN_PCT)
    );
    for (const f of perf) {
      const w = f.wallPct !== undefined && Math.abs(f.wallPct) >= WALL_PCT
        ? `wall ${f.wallPct > 0 ? '+' : ''}${Math.round(f.wallPct * 100)}%` : '';
      const t = f.tokenPct !== undefined && Math.abs(f.tokenPct) >= TOKEN_PCT
        ? `tokens ${f.tokenPct > 0 ? '+' : ''}${Math.round(f.tokenPct * 100)}%` : '';
      lines.push(dim(`  ~ ${f.id}: ${[w, t].filter(Boolean).join(', ')}`));
    }
    if (m.regressions.length === 0 && m.gains.length === 0 && perf.length === 0) {
      lines.push(dim('  no material changes'));
    }
    lines.push('');
  }
  lines.push(
    cmp.regressions.length === 0
      ? good(`Net: no regressions · ${cmp.gains.length} gain(s)`)
      : bad(`Net: ${cmp.regressions.length} regression(s) · ${cmp.gains.length} gain(s)`)
  );
  return lines.join('\n');
}
