/**
 * Arc W2c — contract tests for the pure-function state helpers
 * extracted from App.tsx in Arc W1a.
 *
 * Goal: pin the load-bearing behavior so Arc W3's hook extractions
 * (useLiveDiffEntries, usePlanStateSync, useAudioPlayback, etc.) can
 * refactor the consumers without silently breaking the wire-format
 * contracts these helpers encode.
 *
 * Mirrors the test list in `docs/app-tsx-decomposition-plan.md` §W2c.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentPlan, AgentStep } from '@burtson-labs/agent-core';

import {
  LIVE_DIFF_STORAGE_PREFIX,
  persistStoredDiffEntries,
  readStoredDiffEntries
} from '../src/state/diffStorage';
import {
  buildCandidatePriorities,
  computeDiffPriority,
  sortEntriesByCandidates
} from '../src/state/diffPriority';
import {
  LIVE_UPDATE_LIMIT,
  extractLiveUpdates
} from '../src/state/liveUpdates';
import {
  buildPlanActivityEntries,
  findActivePlanRun,
  mapPlanUpdateStateToTaskStatus
} from '../src/state/planSync';
import { toAgentSummaryData } from '../src/state/agentSummary';
import { readBootConfig } from '../src/state/bootConfig';

// ─── readStoredDiffEntries / persistStoredDiffEntries ────────────────
describe('diffStorage', () => {
  const conversationId = 'conv-1';
  const storageKey = `${LIVE_DIFF_STORAGE_PREFIX}${conversationId}`;

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns {} when the conversation has no stored entries', () => {
    expect(readStoredDiffEntries(conversationId)).toEqual({});
  });

  it('returns {} when conversation id is null/undefined (no key to look up)', () => {
    window.localStorage.setItem(storageKey, '{"foo":{"path":"foo"}}');
    expect(readStoredDiffEntries(null)).toEqual({});
    expect(readStoredDiffEntries(undefined)).toEqual({});
  });

  it('falls back to {} when the stored payload is corrupt JSON', () => {
    window.localStorage.setItem(storageKey, 'this is not json');
    expect(readStoredDiffEntries(conversationId)).toEqual({});
  });

  it('round-trips entries through persist → read', () => {
    persistStoredDiffEntries(conversationId, {
      'src/foo.ts': { path: 'src/foo.ts', diffText: '@@ patch', added: 3, removed: 1 }
    });
    const round = readStoredDiffEntries(conversationId);
    expect(round['src/foo.ts']).toEqual({
      path: 'src/foo.ts',
      diffText: '@@ patch',
      added: 3,
      removed: 1
    });
  });

  it('filters out stored entries whose shape does not match (defense in depth)', () => {
    // Captured 2026 — a defensive check against stale or hand-edited
    // localStorage from earlier extension versions. Bad shapes are dropped
    // silently, never crash the panel.
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        'src/ok.ts': { path: 'src/ok.ts', diffText: 'good', added: 1, removed: 0 },
        'src/badPath': 'not-an-object',
        'src/badNumber': { path: 'src/badNumber', added: 'three', removed: 'one' }
      })
    );
    const result = readStoredDiffEntries(conversationId);
    expect(result['src/ok.ts']).toEqual({
      path: 'src/ok.ts',
      diffText: 'good',
      added: 1,
      removed: 0
    });
    expect(result['src/badPath']).toBeUndefined();
    // Bad numeric fields get stripped to undefined, but the entry itself
    // survives so the path is still tracked in the completed-changes view.
    expect(result['src/badNumber']).toEqual({
      path: 'src/badNumber',
      diffText: undefined,
      added: undefined,
      removed: undefined
    });
  });

  it('persistStoredDiffEntries no-ops when conversation id is missing', () => {
    persistStoredDiffEntries(null, { 'x': { path: 'x' } });
    persistStoredDiffEntries(undefined, { 'x': { path: 'x' } });
    expect(window.localStorage.length).toBe(0);
  });
});

// ─── computeDiffPriority / sortEntriesByCandidates ───────────────────
describe('diffPriority', () => {
  it('computeDiffPriority returns POSITIVE_INFINITY when no candidates were extracted', () => {
    expect(computeDiffPriority('src/foo.ts', [])).toBe(Number.POSITIVE_INFINITY);
  });

  it('computeDiffPriority returns the candidate index on exact match', () => {
    const candidates = buildCandidatePriorities(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(computeDiffPriority('src/b.ts', candidates)).toBe(1);
    expect(computeDiffPriority('src/c.ts', candidates)).toBe(2);
  });

  it('computeDiffPriority falls back to fuzzy match (length + index) when only the basename overlaps', () => {
    const candidates = buildCandidatePriorities(['src/a.ts', 'src/b.ts']);
    // Different directory but same basename — fuzzy match band.
    expect(computeDiffPriority('packages/foo/src/a.ts', candidates)).toBe(candidates.length + 0);
    expect(computeDiffPriority('packages/foo/src/b.ts', candidates)).toBe(candidates.length + 1);
  });

  it('computeDiffPriority returns the unknown-fallback score for paths nobody mentioned', () => {
    const candidates = buildCandidatePriorities(['src/a.ts']);
    expect(computeDiffPriority('totally/unrelated.ts', candidates)).toBe(candidates.length * 2 + 1);
  });

  it('sortEntriesByCandidates sorts by score asc and preserves input order on ties', () => {
    const candidates = buildCandidatePriorities(['src/b.ts', 'src/a.ts']);
    const entries = [
      { path: 'src/a.ts' },
      { path: 'src/b.ts' },
      { path: 'unrelated.ts' },
      { path: 'src/a.ts' } // duplicate to test stability — should follow first occurrence
    ];
    const sorted = sortEntriesByCandidates(entries, candidates);
    // 'src/b.ts' has index 0 → score 0; 'src/a.ts' has index 1 → score 1.
    expect(sorted.map((e) => e.path)).toEqual([
      'src/b.ts',
      'src/a.ts',
      'src/a.ts', // duplicate, original ordering preserved on tie
      'unrelated.ts'
    ]);
  });

  it('sortEntriesByCandidates returns input unchanged when there are no candidates', () => {
    const entries = [{ path: 'b' }, { path: 'a' }];
    expect(sortEntriesByCandidates(entries, [])).toBe(entries);
  });
});

// ─── extractLiveUpdates ──────────────────────────────────────────────
describe('extractLiveUpdates', () => {
  const buildPlan = (stepIds: string[]): AgentPlan => ({
    id: 'run-1',
    goal: 'Demo',
    summary: 'Demo',
    steps: stepIds.map((id, index) => ({
      id,
      title: `Step ${index + 1}`,
      description: '',
      status: 'pending'
    })),
    createdAt: 0,
    version: 'test'
  });

  const stepStart = (step: AgentStep, runId = 'run-1'): AgentEvent => ({
    type: 'step:start',
    timestamp: Date.now(),
    payload: { step, runId }
  });

  const stepComplete = (
    step: AgentStep,
    runId = 'run-1',
    resultStatus: 'completed' | 'failed' = 'completed'
  ): AgentEvent => ({
    type: 'step:complete',
    timestamp: Date.now(),
    payload: { step, runId, result: { status: resultStatus, logs: undefined } }
  });

  it('returns [] when there is no plan', () => {
    expect(extractLiveUpdates([], null)).toEqual([]);
  });

  it('returns [] when there are no events even with a plan', () => {
    expect(extractLiveUpdates([], buildPlan(['s1']))).toEqual([]);
  });

  it('builds an entry per started step in the order they fire', () => {
    const plan = buildPlan(['s1', 's2']);
    const entries = extractLiveUpdates(
      [stepStart(plan.steps[0]), stepStart(plan.steps[1])],
      plan
    );
    expect(entries.map((e) => e.stepId)).toEqual(['s1', 's2']);
    expect(entries.every((e) => e.status === 'start')).toBe(true);
  });

  it('flips status to complete on step:complete (and error when result is failed)', () => {
    const plan = buildPlan(['s1', 's2']);
    const entries = extractLiveUpdates(
      [
        stepStart(plan.steps[0]),
        stepComplete(plan.steps[0], 'run-1', 'completed'),
        stepStart(plan.steps[1]),
        stepComplete(plan.steps[1], 'run-1', 'failed')
      ],
      plan
    );
    expect(entries.find((e) => e.stepId === 's1')?.status).toBe('complete');
    expect(entries.find((e) => e.stepId === 's2')?.status).toBe('error');
  });

  it('ignores events whose runId belongs to a different plan', () => {
    const plan = buildPlan(['s1']);
    const entries = extractLiveUpdates(
      [stepStart(plan.steps[0], 'some-other-run')],
      plan
    );
    expect(entries).toEqual([]);
  });

  it('caps the returned list at LIVE_UPDATE_LIMIT entries (most recent kept)', () => {
    const stepIds = Array.from({ length: LIVE_UPDATE_LIMIT + 3 }, (_, i) => `s${i}`);
    const plan = buildPlan(stepIds);
    const events = plan.steps.map((s) => stepStart(s));
    const entries = extractLiveUpdates(events, plan);
    expect(entries).toHaveLength(LIVE_UPDATE_LIMIT);
    // Cap takes the tail (slice(-LIVE_UPDATE_LIMIT)), so the very first
    // few steps are dropped.
    expect(entries[0].stepId).toBe(`s3`);
    expect(entries[entries.length - 1].stepId).toBe(`s${LIVE_UPDATE_LIMIT + 2}`);
  });
});

// ─── findActivePlanRun ───────────────────────────────────────────────
describe('findActivePlanRun', () => {
  type Run = Parameters<typeof findActivePlanRun>[0][number];
  const buildRun = (id: string, createdAt: number): Run =>
    ({
      id,
      conversationId: 'conv-1',
      createdAt,
      updatedAt: createdAt,
      plan: { goal: id, steps: [] },
      updates: {},
      events: []
    } as unknown as Run);

  it('returns null when history is empty', () => {
    expect(findActivePlanRun([], null)).toBeNull();
    expect(findActivePlanRun([], 'anything')).toBeNull();
  });

  it('returns the run whose id matches activePlanRunId when present', () => {
    const a = buildRun('a', 1);
    const b = buildRun('b', 2);
    expect(findActivePlanRun([a, b], 'a')).toBe(a);
  });

  it('falls back to the most-recent run when activePlanRunId is null', () => {
    const a = buildRun('a', 1);
    const b = buildRun('b', 99);
    const c = buildRun('c', 50);
    expect(findActivePlanRun([a, b, c], null)).toBe(b);
  });

  it('falls back to the most-recent run when activePlanRunId does not match any history entry', () => {
    const a = buildRun('a', 1);
    const b = buildRun('b', 99);
    expect(findActivePlanRun([a, b], 'ghost')).toBe(b);
  });
});

// ─── buildPlanActivityEntries ────────────────────────────────────────
describe('buildPlanActivityEntries', () => {
  it('returns [] when there is no plan available (no history, no fallback)', () => {
    expect(buildPlanActivityEntries([], null, null, {})).toEqual([]);
  });

  it('emits a start entry derived from the plan goal even with zero updates', () => {
    const entries = buildPlanActivityEntries(
      [],
      null,
      { goal: 'Make the thing work', steps: [] },
      {}
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: 'Make the thing work',
      summary: 'Goal: Make the thing work',
      status: 'start'
    });
  });

  it('emits one update entry per step in updates, ordered by timestamp', () => {
    const entries = buildPlanActivityEntries(
      [],
      null,
      {
        goal: 'Plan',
        steps: [
          { id: 'a', title: 'Step A', details: '' },
          { id: 'b', title: 'Step B', details: '' }
        ]
      },
      {
        b: { state: 'start', summary: 'Beginning B', updatedAt: 200 },
        a: { state: 'complete', summary: 'A done', updatedAt: 100 }
      }
    );
    // start entry + 2 step entries; step entries ordered by timestamp.
    expect(entries).toHaveLength(3);
    expect(entries[1].stepId).toBe('a'); // earlier timestamp
    expect(entries[1].status).toBe('complete');
    expect(entries[2].stepId).toBe('b'); // later timestamp
    expect(entries[2].status).toBe('start');
  });
});

// ─── mapPlanUpdateStateToTaskStatus ──────────────────────────────────
describe('mapPlanUpdateStateToTaskStatus', () => {
  it('maps every known plan-update state to the right TaskStatus', () => {
    expect(mapPlanUpdateStateToTaskStatus('complete')).toBe('completed');
    expect(mapPlanUpdateStateToTaskStatus('done')).toBe('completed');
    expect(mapPlanUpdateStateToTaskStatus('approved')).toBe('completed');
    expect(mapPlanUpdateStateToTaskStatus('error')).toBe('failed');
    expect(mapPlanUpdateStateToTaskStatus('failed')).toBe('failed');
    expect(mapPlanUpdateStateToTaskStatus('needs-revision')).toBe('failed');
    expect(mapPlanUpdateStateToTaskStatus('start')).toBe('in_progress');
    expect(mapPlanUpdateStateToTaskStatus('progress')).toBe('in_progress');
    expect(mapPlanUpdateStateToTaskStatus('update')).toBe('in_progress');
  });

  it('returns the fallback for unknown / empty input, and honors an explicit fallback override', () => {
    expect(mapPlanUpdateStateToTaskStatus(undefined)).toBe('pending');
    expect(mapPlanUpdateStateToTaskStatus('')).toBe('pending');
    // Unknown non-empty strings fall through every known branch and land
    // on the explicit `fallback` param too — same default as empty input.
    expect(mapPlanUpdateStateToTaskStatus('whatever')).toBe('pending');
    expect(mapPlanUpdateStateToTaskStatus(undefined, 'completed')).toBe('completed');
    expect(mapPlanUpdateStateToTaskStatus('whatever', 'in_progress')).toBe('in_progress');
  });
});

// ─── toAgentSummaryData ──────────────────────────────────────────────
describe('toAgentSummaryData', () => {
  it('returns null for null input', () => {
    expect(toAgentSummaryData(null)).toBeNull();
  });

  it("returns null for payloads whose `type` is not 'agent-summary'", () => {
    expect(toAgentSummaryData({ type: 'something-else' })).toBeNull();
  });

  it('strips file entries whose shape is invalid (no path / non-object) and keeps valid ones', () => {
    const summary = toAgentSummaryData({
      type: 'agent-summary',
      success: true,
      goal: 'Test run',
      files: [
        { path: 'src/keep.ts', diff: '@@ +1', summary: { added: 1, removed: 0 }, confidence: 0.9 },
        'not-an-object',
        { path: '', diff: '@@' }, // empty path → dropped
        { diff: 'no-path-key' } // missing path → dropped
      ]
    });
    expect(summary?.files).toHaveLength(1);
    expect(summary?.files?.[0]).toMatchObject({ path: 'src/keep.ts' });
  });

  it('returns files=undefined (not [], not null) when no valid entries survive', () => {
    // The shape matters: AgentSummaryCard treats undefined as "no files
    // section" but renders an empty header for [].
    const summary = toAgentSummaryData({
      type: 'agent-summary',
      success: true,
      goal: 'Bad input',
      files: ['nope']
    });
    expect(summary?.files).toBeUndefined();
  });
});

// ─── readBootConfig ──────────────────────────────────────────────────
describe('readBootConfig', () => {
  afterEach(() => {
    const existing = document.getElementById('bandit-stealth-config');
    if (existing) existing.remove();
  });

  const installConfig = (text: string): void => {
    const el = document.createElement('script');
    el.id = 'bandit-stealth-config';
    el.type = 'application/json';
    el.textContent = text;
    document.body.appendChild(el);
  };

  it('returns {} when the boot-config script element is missing', () => {
    expect(readBootConfig()).toEqual({});
  });

  it('returns {} when the boot-config script element has empty content', () => {
    installConfig('');
    expect(readBootConfig()).toEqual({});
  });

  it('parses a valid JSON blob from the boot-config script', () => {
    installConfig('{"logoSrc":"vscode-webview://abc/logo.png"}');
    expect(readBootConfig()).toEqual({ logoSrc: 'vscode-webview://abc/logo.png' });
  });

  it('falls back to {} when the boot-config script body is corrupt JSON', () => {
    installConfig('{this is not json');
    expect(readBootConfig()).toEqual({});
  });
});
