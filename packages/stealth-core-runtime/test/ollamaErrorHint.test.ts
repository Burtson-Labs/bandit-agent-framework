import { describe, expect, it } from 'vitest';
import { buildOllamaErrorHint } from '../src';

const LOCAL = 'http://localhost:11434';

describe('buildOllamaErrorHint', () => {
  it('a subscription 403 points at the upgrade page, not at sign-in (real kimi-k2.7-code:cloud case)', () => {
    const detail = '{"error":"this model requires a subscription, upgrade for access: https://ollama.com/upgrade"}';
    const hint = buildOllamaErrorHint(403, 'kimi-k2.7-code:cloud', LOCAL, detail);
    expect(hint).toContain('paid Ollama plan');
    expect(hint).toContain('ollama.com/upgrade');
    expect(hint).not.toContain('ollama signin');
  });

  it('recognizes BOTH cloud tag shapes for a plain auth 403 (-cloud and :cloud)', () => {
    expect(buildOllamaErrorHint(403, 'kimi-k2:1t-cloud', LOCAL, 'forbidden')).toContain('ollama signin');
    expect(buildOllamaErrorHint(401, 'kimi-k2.7-code:cloud', LOCAL, 'unauthorized')).toContain('ollama signin');
  });

  it('treats an ollama.com base URL as cloud even for a non-cloud tag', () => {
    expect(buildOllamaErrorHint(401, 'kimi-k2', 'https://ollama.com', 'unauthorized')).toContain('ollama signin');
  });

  it('no hint for a local model auth error (not cloud)', () => {
    expect(buildOllamaErrorHint(403, 'gemma4:e4b', LOCAL, 'forbidden')).toBe('');
  });

  it('no hint for a non-auth status', () => {
    expect(buildOllamaErrorHint(500, 'kimi-k2:1t-cloud', LOCAL, 'server error')).toBe('');
  });
});
