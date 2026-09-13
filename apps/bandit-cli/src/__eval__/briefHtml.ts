/**
 * Deterministic nightly-brief renderer.
 *
 * The nightly bench's morning brief is normally authored by the agent itself.
 * That's the nicer output, but it needs a working model: on a cold start or a
 * rate-limit the brief step produces nothing and the whole email silently
 * disappears — exactly the night you most want to hear from it.
 *
 * This module is the floor under that: no model, no network, no template
 * engine. It turns the eval JSON and a baseline comparison into a small
 * self-contained HTML page. Pure and synchronous, so it unit-tests and can
 * never be the reason an email fails to go out.
 */

import type { EvalJson, EvalJsonFixture } from './evalJson';
import type { BaselineComparison, FixtureDelta } from './baselineCompare';

export interface BriefInput {
  /** Parsed `eval --json-out` output. Null when the eval never produced one. */
  evalJson?: EvalJson | null;
  /** Parsed comparison of this run's baseline against the frozen one. */
  comparison?: BaselineComparison | null;
  /** Problems encountered assembling the brief (missing/corrupt input files).
   *  Surfaced in the page so a degraded brief is never mistaken for a clean
   *  run — silence is the failure mode this whole file exists to prevent. */
  notes?: string[];
  /** ISO timestamp for the page header. Defaults to now. */
  generatedAt?: string;
}

export interface BriefSummary {
  /** One-line verdict, also used as the email subject. */
  subject: string;
  /** 'pass' · 'fail' · 'unknown' (no usable eval data). */
  verdict: 'pass' | 'fail' | 'unknown';
  failedFixtures: number;
  regressions: number;
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Verdict + subject line. Derived ONLY from the data present: a missing eval
 * file yields 'unknown' rather than a reassuring green, because "we couldn't
 * tell" and "everything passed" must never look alike in an inbox.
 */
export function summarizeBrief(input: BriefInput): BriefSummary {
  const totals = input.evalJson?.totals;
  const regressions = input.comparison?.regressions.length ?? 0;
  const failedFixtures = totals?.failed ?? 0;

  if (!totals) {
    return {
      subject: 'BanditBench nightly — NO RESULTS (eval output missing)',
      verdict: 'unknown',
      failedFixtures: 0,
      regressions
    };
  }

  const passedLabel = `${totals.passed}/${totals.fixtures} fixtures passed`;
  if (failedFixtures === 0 && regressions === 0) {
    return { subject: `BanditBench nightly — green · ${passedLabel}`, verdict: 'pass', failedFixtures, regressions };
  }

  const parts: string[] = [];
  if (failedFixtures > 0) parts.push(`${failedFixtures} failing`);
  if (regressions > 0) parts.push(`${regressions} regression${regressions === 1 ? '' : 's'}`);
  return {
    subject: `BanditBench nightly — ${parts.join(' · ')} · ${passedLabel}`,
    verdict: 'fail',
    failedFixtures,
    regressions
  };
}

function statTile(label: string, value: string, tone: 'good' | 'bad' | 'neutral'): string {
  return `<div class="tile ${tone}"><div class="tile-v">${escapeHtml(value)}</div><div class="tile-l">${escapeHtml(label)}</div></div>`;
}

/** How many failures get a full detail block before the rest are listed by id.
 *  A total-wipeout night (every fixture down) should stay one screen of
 *  signal, but no failing fixture name is ever dropped. */
const DETAIL_LIMIT = 12;

/** The runner already writes errors as `runner error: …`; don't say it twice. */
function formatRunnerError(error: string): string {
  const trimmed = error.trim();
  return /^runner error\s*:/i.test(trimmed) ? trimmed : `runner error: ${trimmed}`;
}

function renderFailingFixtures(fixtures: EvalJsonFixture[]): string {
  if (fixtures.length === 0) {
    return '<p class="ok">No fixture failures.</p>';
  }

  const rows = fixtures.slice(0, DETAIL_LIMIT).map((f) => {
    const reasons = f.failureReasons.length > 0
      ? `<ul class="reasons">${f.failureReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
      : '<p class="reasons dim">No assertion reason recorded.</p>';
    const crash = f.error ? `<p class="crash">${escapeHtml(formatRunnerError(f.error))}</p>` : '';
    const limit = f.hitLimit ? ' <span class="badge">hit iteration cap</span>' : '';
    return `<div class="fx">
  <div class="fx-h"><code>${escapeHtml(f.id)}</code> <span class="rate">${escapeHtml(f.passRate)}</span>${limit}</div>
  <div class="fx-d">${escapeHtml(f.description)}</div>
  ${reasons}
  ${crash}
</div>`;
  });

  const overflow = fixtures.slice(DETAIL_LIMIT);
  if (overflow.length > 0) {
    rows.push(
      `<p class="dim">…and ${overflow.length} more failing: ` +
      `${overflow.map((f) => `<code>${escapeHtml(f.id)}</code>`).join(', ')}</p>`
    );
  }

  return rows.join('\n');
}

function renderRegressions(comparison: BaselineComparison | null | undefined): string {
  if (!comparison) {
    return '<p class="dim">No baseline comparison available for this run.</p>';
  }
  if (comparison.regressions.length === 0) {
    const gains = comparison.gains.length;
    return `<p class="ok">No regressions vs the frozen baseline${gains > 0 ? ` · ${gains} gain${gains === 1 ? '' : 's'}` : ''}.</p>`;
  }

  const items = comparison.regressions
    .map((r) => `<li><code>${escapeHtml(r.id)}</code> <span class="dim">(${escapeHtml(r.model)})</span></li>`)
    .join('');
  return `<p class="bad">${comparison.regressions.length} fixture(s) that passed in the baseline now fail:</p><ul class="reasons">${items}</ul>`;
}

/** Material wall-time / token shifts, if the comparison carried any. */
function renderDrift(comparison: BaselineComparison | null | undefined): string {
  if (!comparison) return '';
  const moved: Array<{ model: string; delta: FixtureDelta }> = [];
  for (const model of comparison.models) {
    for (const delta of model.fixtures) {
      const wall = delta.wallPct !== undefined && Math.abs(delta.wallPct) >= 0.2;
      const tokens = delta.tokenPct !== undefined && Math.abs(delta.tokenPct) >= 0.2;
      if (wall || tokens) moved.push({ model: model.label, delta });
    }
  }
  if (moved.length === 0) return '';

  const rows = moved.slice(0, 15).map(({ delta }) => {
    const bits: string[] = [];
    if (delta.wallPct !== undefined && Math.abs(delta.wallPct) >= 0.2) {
      bits.push(`wall ${delta.wallPct > 0 ? '+' : ''}${Math.round(delta.wallPct * 100)}%`);
    }
    if (delta.tokenPct !== undefined && Math.abs(delta.tokenPct) >= 0.2) {
      bits.push(`tokens ${delta.tokenPct > 0 ? '+' : ''}${Math.round(delta.tokenPct * 100)}%`);
    }
    return `<li><code>${escapeHtml(delta.id)}</code> — ${escapeHtml(bits.join(', '))}</li>`;
  }).join('');

  const more = moved.length > 15 ? `<li class="dim">…and ${moved.length - 15} more</li>` : '';
  return `<h2>Score drift</h2><ul class="reasons">${rows}${more}</ul>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px 16px 48px; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  color: #16181d; background: #f7f8fa; }
.wrap { max-width: 760px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: #5b6472; margin: 28px 0 10px; }
.meta { color: #5b6472; font-size: 13px; margin: 0 0 20px; }
.tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 8px; }
.tile { flex: 1 1 120px; background: #fff; border: 1px solid #e3e6ec; border-radius: 10px; padding: 12px 14px; }
.tile-v { font-size: 22px; font-weight: 600; }
.tile-l { font-size: 12px; color: #5b6472; margin-top: 2px; }
.tile.good .tile-v { color: #11734b; }
.tile.bad .tile-v { color: #b3261e; }
.fx { background: #fff; border: 1px solid #e3e6ec; border-left: 3px solid #b3261e; border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; }
.fx-h { font-size: 14px; }
.fx-h code { font-size: 13px; font-weight: 600; }
.fx-d { color: #5b6472; font-size: 13px; margin: 2px 0 8px; }
.rate { color: #b3261e; font-weight: 600; font-size: 13px; }
.badge { background: #fff3e0; color: #8a4b00; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.reasons { margin: 0; padding-left: 20px; font-size: 13px; }
.reasons li { margin: 2px 0; word-break: break-word; }
.crash { font-size: 13px; color: #b3261e; margin: 8px 0 0; word-break: break-word; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #eef0f4; border-radius: 4px; padding: 1px 5px; }
.ok { color: #11734b; }
.bad { color: #b3261e; font-weight: 600; }
.dim { color: #5b6472; }
.notes { background: #fff8e1; border: 1px solid #f0dca8; border-radius: 8px; padding: 10px 14px; font-size: 13px; }
.foot { margin-top: 32px; font-size: 12px; color: #737c8a; border-top: 1px solid #e3e6ec; padding-top: 12px; }
@media (prefers-color-scheme: dark) {
  body { background: #13151a; color: #e7e9ee; }
  .tile, .fx { background: #1b1e25; border-color: #2c313b; }
  h2, .meta, .tile-l, .fx-d, .dim { color: #9aa4b2; }
  code { background: #262b34; }
  .notes { background: #2a2416; border-color: #4a3f22; }
  .foot { border-color: #2c313b; color: #8b95a3; }
}
`;

export function renderBriefHtml(input: BriefInput): string {
  const summary = summarizeBrief(input);
  const evalJson: EvalJson | null = input.evalJson ?? null;
  const totals = evalJson?.totals;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const failing = (evalJson?.fixtures ?? []).filter((f) => !f.passed && !f.skipped);

  const tiles = totals
    ? [
        statTile('fixtures passed', `${totals.passed}/${totals.fixtures}`, totals.failed === 0 ? 'good' : 'neutral'),
        statTile('failing', String(totals.failed), totals.failed === 0 ? 'good' : 'bad'),
        statTile('regressions', String(summary.regressions), summary.regressions === 0 ? 'good' : 'bad'),
        statTile('skipped', String(totals.skipped), 'neutral'),
        statTile('wall time', formatDuration(evalJson?.totalWallTimeMs ?? 0), 'neutral')
      ].join('')
    : statTile('results', 'none', 'bad');

  const notes = (input.notes ?? []).filter((n) => n && n.trim().length > 0);
  const notesBlock = notes.length > 0
    ? `<h2>Brief notes</h2><div class="notes"><ul class="reasons">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`
    : '';

  const runLabel = evalJson
    ? `${evalJson.provider}/${evalJson.model} · variant ${evalJson.variant}` +
      (evalJson.runsPerFixture ? ` · ${evalJson.runsPerFixture} run(s)/fixture` : '')
    : 'run metadata unavailable';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(summary.subject)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(summary.subject)}</h1>
  <p class="meta">${escapeHtml(runLabel)}<br>generated ${escapeHtml(generatedAt)}</p>

  <div class="tiles">${tiles}</div>

  ${notesBlock}

  <h2>Fixture failures</h2>
  ${renderFailingFixtures(failing)}

  <h2>Regressions vs baseline</h2>
  ${renderRegressions(input.comparison)}

  ${renderDrift(input.comparison)}

  <p class="foot">Generated without a model by the nightly bench's fallback brief — the
  model-authored version either failed or produced nothing. Full detail lives in the
  job logs and <code>.bandit/eval-report.md</code>.</p>
</div>
</body>
</html>
`;
}
