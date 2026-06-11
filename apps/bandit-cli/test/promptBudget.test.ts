import { describe, expect, it } from 'vitest';
import { getModelCapabilities } from '@burtson-labs/stealth-core-runtime';
import { buildSystemPrompt, CLI_SYSTEM_PROMPT_BUDGETS } from '../src/systemPrompt';

/**
 * Mirror of the extension's promptBudget.test.ts for the CLI builder.
 * Regression guard for the inverted-tier bug fixed in v1.7.372: the CLI
 * shipped a 19.5 KB base prompt to small models and 10.4 KB to large
 * ones. Any future prompt growth must either fit the tier budget or be
 * a deliberate budget bump in systemPrompt.ts reviewed alongside it.
 */

const TIER_REPRESENTATIVES: Record<string, string> = {
  small: 'gemma4:e4b',
  medium: 'gemma3:12b',
  large: 'qwen3.6:27b'
};

describe('CLI system prompt budgets', () => {
  for (const [tier, modelId] of Object.entries(TIER_REPRESENTATIVES)) {
    it(`composed base prompt for ${tier} tier (${modelId}) fits its budget`, () => {
      expect(getModelCapabilities(modelId).tier).toBe(tier);
      const prompt = buildSystemPrompt('', { modelId });
      expect(prompt.length).toBeLessThanOrEqual(
        CLI_SYSTEM_PROMPT_BUDGETS[tier as keyof typeof CLI_SYSTEM_PROMPT_BUDGETS]
      );
    });
  }

  it('small tier is no longer drastically larger than large tier (inversion guard)', () => {
    const small = buildSystemPrompt('', { modelId: TIER_REPRESENTATIVES.small });
    const large = buildSystemPrompt('', { modelId: TIER_REPRESENTATIVES.large });
    // Small keeps the targeted tool-discipline bullets, so it may run a
    // little over large — but never the 2x of the inverted era.
    expect(small.length).toBeLessThanOrEqual(large.length * 1.35);
  });

  it('no tier ships the old 14-row slash-command table', () => {
    for (const modelId of Object.values(TIER_REPRESENTATIVES)) {
      const prompt = buildSystemPrompt('', { modelId });
      expect(prompt).not.toContain('| User wants to… |');
      expect(prompt).toContain('Slash commands are a REPL feature.');
    }
  });

  it('skill authoring section only loads when the goal mentions skills', () => {
    const withSkills = buildSystemPrompt('', { modelId: 'gemma4:e4b', userGoal: 'make me a skill for gh' });
    const without = buildSystemPrompt('', { modelId: 'gemma4:e4b', userGoal: 'fix the login bug' });
    expect(withSkills).toContain('## Authoring skills');
    expect(without).not.toContain('## Authoring skills');
  });
});
