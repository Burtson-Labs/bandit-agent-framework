import { describe, it, expect } from 'vitest';
import { mergeConfig } from '../src/config';

/**
 * Regression: mergeConfig rebuilds the config field-by-field, and used to omit
 * `tools` entirely — so a Tavily key saved in ~/.bandit/config.json (including
 * the one the IDE writes) was dropped on load and the CLI's web_search reported
 * "not configured" despite a valid key on disk.
 */
describe('mergeConfig preserves BYOK tool credentials', () => {
  it('carries tools.tavily.apiKey through a merge from the global file', () => {
    const merged = mergeConfig({ tools: { tavily: { apiKey: 'tvly-global' } } }, {});
    expect(merged.tools?.tavily?.apiKey).toBe('tvly-global');
  });

  it('lets a later (workspace) file override the key but never drops it', () => {
    const merged = mergeConfig(
      { tools: { tavily: { apiKey: 'tvly-a' } } },
      { tools: { tavily: { apiKey: 'tvly-b' } } }
    );
    expect(merged.tools?.tavily?.apiKey).toBe('tvly-b');
  });

  it('keeps an existing key when the later file has no tools block', () => {
    const merged = mergeConfig(
      { tools: { tavily: { apiKey: 'tvly-keep' } } },
      { provider: 'ollama' }
    );
    expect(merged.tools?.tavily?.apiKey).toBe('tvly-keep');
  });
});
