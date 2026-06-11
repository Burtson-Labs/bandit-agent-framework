import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, CLI_SYSTEM_PROMPT_BUDGETS } from '../src/systemPrompt';

/**
 * CLI system prompt budget gate.
 *
 * Before v1.7.345 the CLI's `buildSystemPrompt` had no tier awareness:
 * every model — `bandit-logic` frontier-tier included — got the full
 * ~21 KB rulebook with small-model compensation bullets, the full slash-
 * command table, the filesystem-scope primer, and the skill-authoring
 * guide. The captured CLI prompt on a fresh `bandit-logic` invocation
 * sat at 21,316 chars vs the IDE's 5,564 (post-1.7.340 fix) — same
 * model, different builders.
 *
 * v1.7.345 refactored the CLI prompt to mirror the extension's layered
 * approach: identity + core working style always; small/mid-only
 * compensation bullets, the filesystem-scope primer, and the slash-
 * command table gated on tier; skill-authoring gated on user goal.
 *
 * These tests pin the savings so a future "while I'm here" addition
 * can't silently re-inflate the prompt. Budgets are deliberately tight
 * (each ~1 KB above current composed size) — looser than the IDE's
 * because the CLI surface still needs the filesystem-scope primer for
 * users running outside a git repo.
 */

// Recalibrated 2026-06-11 (v1.7.372 inverted-tier fix): the small/mid
// safety set was culled to the failure modes the tool-loop detectors
// don't already cover, and the 14-row slash table became a one-line hint
// for every tier. Composed sizes now 10,384 (large) and 12,541
// (small/medium). Budgets are the exported single source of truth —
// see CLI_SYSTEM_PROMPT_BUDGETS in src/systemPrompt.ts and the
// dedicated promptBudget.test.ts.
const CLI_BUDGETS = CLI_SYSTEM_PROMPT_BUDGETS;

describe('CLI buildSystemPrompt — tier-gated composition', () => {
  it.skip('SIZE PROBE — prints actual sizes for budget calibration', () => {
    for (const m of ['bandit-logic', 'qwen3.6:27b', 'gemma3:12b', 'gemma3:27b', 'gemma3:4b', 'gemma4:e4b']) {
      console.log(`${m.padEnd(22)} ${buildSystemPrompt('', { modelId: m }).length}`);
    }
    console.log('large + skill goal:', buildSystemPrompt('', { modelId: 'bandit-logic', userGoal: 'make a skill' }).length);
    console.log('large + coauthor false:', buildSystemPrompt('', { modelId: 'bandit-logic', coauthor: false }).length);
    console.log('no modelId (default small):', buildSystemPrompt('', {}).length);
  });

  it('large tier composes well under the budget (no small-model quirks, no slash command table)', () => {
    const out = buildSystemPrompt('', { modelId: 'bandit-logic' });
    expect(out.length).toBeLessThanOrEqual(CLI_BUDGETS.large);
    // Frontier-tier bullets must NOT include the small-model
    // compensation rules.
    expect(out).not.toMatch(/CRITICAL RULE: never claim to have written/);
    expect(out).not.toMatch(/Be environment-aware: verify/);
    expect(out).not.toMatch(/Verification results are authoritative — pivot/);
    // Slash command table is replaced by a one-line hint.
    expect(out).not.toMatch(/\| User wants to… \| Tell them to type \|/);
    expect(out).toMatch(/Slash commands are a REPL feature/);
    // Filesystem scope primer is small/mid only.
    expect(out).not.toMatch(/^## Filesystem scope$/m);
    // Identity + core working style stay.
    expect(out).toMatch(/^## Identity$/m);
    expect(out).toMatch(/ACT, DON'T NARRATE/);
  });

  it('medium tier includes the culled tool-discipline bullets and the slash hint (no table)', () => {
    const out = buildSystemPrompt('', { modelId: 'gemma3:12b' });
    expect(out.length).toBeLessThanOrEqual(CLI_BUDGETS.medium);
    expect(out).toMatch(/\*\*Edit discipline\.\*\*/);
    expect(out).toMatch(/Do not invent file paths/);
    // The detector-covered prose and the 14-row table were culled in
    // v1.7.372 — prose can't make a model behave; detectors can.
    expect(out).not.toMatch(/CRITICAL RULE: never claim to have written/);
    expect(out).not.toMatch(/\| User wants to… \| Tell them to type \|/);
    expect(out).toMatch(/Slash commands are a REPL feature/);
    expect(out).toMatch(/^## Filesystem scope$/m);
  });

  it('small tier matches medium composition (same culled safety set)', () => {
    const out = buildSystemPrompt('', { modelId: 'gemma3:4b' });
    expect(out.length).toBeLessThanOrEqual(CLI_BUDGETS.small);
    expect(out).toMatch(/\*\*Edit discipline\.\*\*/);
    expect(out).not.toMatch(/\| User wants to… \| Tell them to type \|/);
    expect(out).toMatch(/^## Filesystem scope$/m);
  });

  it('missing modelId defaults to the most conservative (small) gating — never under-instructs', () => {
    const withModel = buildSystemPrompt('', { modelId: 'gemma3:4b' });
    const withoutModel = buildSystemPrompt('', {});
    expect(withoutModel).toMatch(/\*\*Edit discipline\.\*\*/);
    expect(withoutModel.length).toBeLessThanOrEqual(CLI_BUDGETS.small);
    // The two should produce roughly the same prompt — within a few
    // hundred chars (label-derived diffs). What matters is the safety
    // bullets are present in both.
    expect(Math.abs(withoutModel.length - withModel.length)).toBeLessThan(500);
  });

  it('skill authoring section gates on user goal mentioning "skill"', () => {
    const skillGoal = buildSystemPrompt('', { modelId: 'bandit-logic', userGoal: 'help me make a skill for k8s' });
    const noSkillGoal = buildSystemPrompt('', { modelId: 'bandit-logic', userGoal: 'tell me about this repo' });
    expect(skillGoal).toMatch(/^## Authoring skills/m);
    expect(noSkillGoal).not.toMatch(/^## Authoring skills/m);
    // Even with skill guide on, large tier stays well under a reasonable
    // ceiling. The skill-authoring section adds ~2 KB on its own.
    expect(skillGoal.length).toBeLessThanOrEqual(CLI_BUDGETS.large + 3 * 1024);
  });

  it('coauthor=false swaps the trailer guidance and still respects budgets', () => {
    const optedOut = buildSystemPrompt('', { modelId: 'bandit-logic', coauthor: false });
    const optedIn = buildSystemPrompt('', { modelId: 'bandit-logic', coauthor: true });
    expect(optedOut).toMatch(/Do NOT append a `Co-authored-by: Bandit` trailer/);
    expect(optedIn).toMatch(/Git commits on the user's behalf get a Bandit co-author trailer/);
    expect(optedOut.length).toBeLessThanOrEqual(CLI_BUDGETS.large);
    expect(optedIn.length).toBeLessThanOrEqual(CLI_BUDGETS.large);
  });

  it('appends the project memory block when provided, after the base prompt', () => {
    const memory = '- Built with React 19, TypeScript 5\n- Deploys via GitHub Actions';
    const out = buildSystemPrompt(memory, { modelId: 'bandit-logic' });
    expect(out).toMatch(/## Project Memory\n\n- Built with React 19/);
  });

  it('vision-capable model gets the image-aware file format bullet', () => {
    const visionOn = buildSystemPrompt('', { modelId: 'qwen3.6:27b', supportsVision: true });
    const visionOff = buildSystemPrompt('', { modelId: 'bandit-core-1', supportsVision: false });
    expect(visionOn).toMatch(/the active model accepts image input/);
    expect(visionOff).toMatch(/Images \/ video \/ archives \/ executables: not readable/);
  });
});

describe('CLI buildSystemPrompt — backwards compatibility', () => {
  it('two-arg (memory, no options) call still produces a useful prompt', () => {
    const out = buildSystemPrompt('- some memory');
    expect(out).toMatch(/^## Identity$/m);
    expect(out).toMatch(/## Project Memory/);
    // Default tier when modelId is omitted is 'small' — full prompt.
    expect(out.length).toBeLessThanOrEqual(CLI_BUDGETS.small + 1024);
  });

  it('single-arg memory-only call returns a non-empty string', () => {
    const out = buildSystemPrompt('');
    expect(out.length).toBeGreaterThan(2 * 1024);
  });
});
