/**
 * Phase 10 pre-gate contract set — the cheap, model-free "is this even worth
 * asking the planner?" heuristic. Properties: single-step tasks score low
 * (planner never consulted), genuinely decomposable tasks clear the bar, and
 * the signal is transparent (reasons explain the score). The bar to SUGGEST a
 * graph is deliberately high — a false positive costs a planner call, a false
 * negative costs nothing (normal loop, today's default).
 */
import { describe, it, expect } from 'vitest';
import { classifyGraphShaped, wantsArtifactDeliverable } from '../src/graph';

const LOOP_TASKS = [
  'fix the typo in the README title',
  'rename formatUser to formatUserLabel everywhere',
  'bump the patch version in package.json',
  'what port does the server listen on?',
  'add a comment above the greet function',
  'update the timeout',                        // too short
  'read config.json',                          // too short
];

const GRAPH_TASKS = [
  'survey how errors are handled in src/runner and in src/graph separately, then write a comparison',
  'compare config/dev.json and config/prod.json and summarize what settings differ',
  'for each of the three services, audit its logging, then produce a combined overview report',
  'review both the auth module and the billing module independently and report the security gaps',
];

describe('classifyGraphShaped — single-step tasks stay out of the planner', () => {
  for (const task of LOOP_TASKS) {
    it(`does not suggest a graph: "${task.slice(0, 40)}"`, () => {
      const signal = classifyGraphShaped(task);
      expect(signal.suggestsGraph).toBe(false);
      expect(signal.score).toBeLessThan(0.6);
    });
  }
});

describe('classifyGraphShaped — decomposable tasks clear the bar', () => {
  for (const task of GRAPH_TASKS) {
    it(`suggests a graph: "${task.slice(0, 40)}…"`, () => {
      const signal = classifyGraphShaped(task);
      expect(signal.suggestsGraph).toBe(true);
      expect(signal.score).toBeGreaterThanOrEqual(0.6);
      expect(signal.reasons.length).toBeGreaterThan(0);
    });
  }
});

describe('classifyGraphShaped — transparency + guards', () => {
  it('explains its score with concrete reasons', () => {
    const signal = classifyGraphShaped('compare A.ts and B.ts and summarize the differences between them');
    expect(signal.reasons.join(' ')).toMatch(/multi-part|synthesis|files/);
  });

  it('a hard single-step marker caps the score even amid other words', () => {
    const signal = classifyGraphShaped('please bump the version in package.json and then let me know it is done');
    expect(signal.suggestsGraph).toBe(false);
    expect(signal.reasons[0]).toMatch(/single-step marker/);
  });

  it('very short prompts short-circuit to zero', () => {
    expect(classifyGraphShaped('do the thing').score).toBe(0);
  });

  it('threshold is tunable', () => {
    // ≥8 words so it clears the short-prompt floor and actually scores.
    const task = 'compare the two config files and summarize the differences between them';
    const strict = classifyGraphShaped(task, { suggestThreshold: 0.95 });
    const loose = classifyGraphShaped(task, { suggestThreshold: 0.2 });
    expect(strict.suggestsGraph).toBe(false);
    expect(loose.suggestsGraph).toBe(true);
  });

  it('a plain conjunction is NOT enough on its own', () => {
    const signal = classifyGraphShaped('open the file and read the first function definition in it');
    expect(signal.suggestsGraph).toBe(false);
  });
});

describe('wantsArtifactDeliverable', () => {
  it('is true for research → publish an artifact/report/briefing/page', () => {
    expect(wantsArtifactDeliverable('research burtson.ai and x.ai news, then create a briefing')).toBe(true);
    expect(wantsArtifactDeliverable('summarize these findings and publish a report')).toBe(true);
    expect(wantsArtifactDeliverable('build a one-pager summarizing the competitive landscape')).toBe(true);
    expect(wantsArtifactDeliverable('make a shareable page comparing the two options')).toBe(true);
  });

  it('is false for code work even when it "creates" something', () => {
    // No artifact-deliverable noun → not an artifact task; the editing loop handles it.
    expect(wantsArtifactDeliverable('create a new React component and wire it up')).toBe(false);
    expect(wantsArtifactDeliverable('implement the auth service and add tests')).toBe(false);
    expect(wantsArtifactDeliverable('refactor the parser into smaller modules')).toBe(false);
  });

  it('needs BOTH a deliverable noun and a produce verb', () => {
    expect(wantsArtifactDeliverable('what does the report say?')).toBe(false); // noun, no produce verb
    expect(wantsArtifactDeliverable('publish the changes to main')).toBe(false); // verb, no deliverable noun
  });
});
