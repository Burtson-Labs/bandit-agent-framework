import { describe, expect, it } from 'vitest';
import {
  buildExtensionSystemPrompt,
  getSystemPromptBudget,
  SYSTEM_PROMPT_BUDGETS
} from '../src';

/**
 * Hard CI gate on system prompt size, per tier.
 *
 * The v1.7.339 → v1.7.340 audit traced a ~30 KB system prompt back to
 * months of one-bullet-at-a-time accretion in `WORKING_STYLE` plus a
 * cache bug that downgraded `bandit-logic` from tier 'large' to tier
 * 'medium' so SMALL_MODEL_QUIRKS was being included where it shouldn't.
 * No test, no /config visibility, no budget — nothing pushed back.
 *
 * The budgets in `SYSTEM_PROMPT_BUDGETS` are 2× the current composed
 * size for each tier. An honest addition (a new always-on bullet that
 * grows the prompt by a few hundred chars) still fits. A regression —
 * e.g. someone reintroduces the slash-command table, or a behavior
 * profile mistakenly fires SMALL_MODEL_QUIRKS on a large-tier model —
 * triggers a hard test failure before merge.
 *
 * If a new feature genuinely needs more space, raise the budget here in
 * the same PR that adds the content. The budget edit forces an explicit
 * conversation about whether the addition is worth the size.
 */

const SCENARIOS = [
  // Each tuple: [modelId, userGoal, expectedTier]
  // Picks at least one model per tier and exercises the user-goal-gated
  // SKILL_AUTHORING section by including a "skill" scenario.

  // --- large tier: frontier models, lightest gating, biggest budget --
  ['bandit-logic',          '',                         'large'],
  ['bandit-logic:latest',   '',                         'large'],
  ['qwen3.6:27b',           '',                         'large'],
  ['qwen3.6:35b',           '',                         'large'],
  ['qwen2.5-coder:32b',     '',                         'large'],
  ['gemma4:31b',            '',                         'large'],

  // --- medium tier: SMALL_MODEL_QUIRKS gated in ----------------------
  ['llama3.2-vision',       '',                         'medium'],
  ['gemma3:12b',            '',                         'medium'],
  ['gemma3:27b',            '',                         'medium'],
  ['gemma4:26b',            '',                         'medium'],
  ['qwen2.5-coder:14b',     '',                         'medium'],
  ['llama3.1',              '',                         'medium'],

  // --- small tier: tightest budget ----------------------------------
  ['gemma3:4b',             '',                         'small'],
  ['gemma4:e2b',            '',                         'small'],
  ['gemma4:e4b',            '',                         'small'],
  ['bandit-core:4b',        '',                         'small'],

  // --- user-goal-triggered SKILL_AUTHORING fires; must still fit ----
  ['bandit-logic',          'help me make a skill for k8s', 'large'],
  ['gemma3:12b',            'write a skill that wraps gh',  'medium'],
  ['gemma3:4b',             'skills: how do I add one',     'small']
] as const;

describe('system prompt budgets — hard CI gate', () => {
  it('each tier has a defined budget', () => {
    expect(SYSTEM_PROMPT_BUDGETS.small).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT_BUDGETS.medium).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT_BUDGETS.large).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT_BUDGETS.small).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGETS.medium);
    expect(SYSTEM_PROMPT_BUDGETS.medium).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGETS.large);
  });

  it.each(SCENARIOS)('ollama provider — %s with goal "%s" (tier %s) composes within tier budget', (modelId, userGoal, expectedTier) => {
    const composed = buildExtensionSystemPrompt({
      providerKind: 'ollama',
      modelId,
      userGoal: userGoal as string,
      coauthor: true
    });
    const budget = getSystemPromptBudget(modelId);
    const tier = SYSTEM_PROMPT_BUDGETS[expectedTier as 'small' | 'medium' | 'large'];
    expect(budget).toBe(tier);
    expect(composed.length).toBeLessThanOrEqual(budget);
  });

  it.each(SCENARIOS)('bandit provider — %s with goal "%s" (tier %s) composes within tier budget', (modelId, userGoal, expectedTier) => {
    const composed = buildExtensionSystemPrompt({
      providerKind: 'bandit',
      modelId,
      userGoal: userGoal as string,
      coauthor: true
    });
    const budget = getSystemPromptBudget(modelId);
    expect(composed.length).toBeLessThanOrEqual(budget);
    expect(budget).toBe(SYSTEM_PROMPT_BUDGETS[expectedTier as 'small' | 'medium' | 'large']);
  });

  it('coauthor=false variant still respects budget (DISABLED prose is roughly same length as ENABLED)', () => {
    for (const [modelId, userGoal] of SCENARIOS) {
      const composed = buildExtensionSystemPrompt({
        providerKind: 'ollama',
        modelId,
        userGoal: userGoal as string,
        coauthor: false
      });
      const budget = getSystemPromptBudget(modelId);
      expect(composed.length).toBeLessThanOrEqual(budget);
    }
  });

  it('customBasePrompt prepended ≤ 1 KB still respects budget on large tier', () => {
    const customPrompt = 'You also have access to internal Burtson tooling. Be concise.';
    const composed = buildExtensionSystemPrompt({
      providerKind: 'ollama',
      modelId: 'bandit-logic',
      customBasePrompt: customPrompt,
      coauthor: true
    });
    expect(composed).toContain(customPrompt);
    expect(composed.length).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGETS.large);
  });
});
