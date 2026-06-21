import { describe, it, expect } from 'vitest';
import {
  sleep,
  isRetryableLlmError,
  tagRetryableLlmError,
  summarizeLlmError,
  isContinuationPrompt,
} from '../src/index';

// These primitives moved out of tool-use-loop.ts into loop/loopShared.ts to
// break an import cycle (which let bun's cross-compile tree-shake away
// createToolUseLoop). This guards that they remain part of the package's public
// API — re-exported all the way up through tool-use-loop → tools → index —
// and that the move preserved their behavior.
describe('loop shared primitives (public API)', () => {
  it('are all exported from the package entry', () => {
    expect(typeof sleep).toBe('function');
    expect(typeof isRetryableLlmError).toBe('function');
    expect(typeof tagRetryableLlmError).toBe('function');
    expect(typeof summarizeLlmError).toBe('function');
    expect(typeof isContinuationPrompt).toBe('function');
  });

  it('isRetryableLlmError classifies upstream/network failures but not rate limits or aborts', () => {
    expect(isRetryableLlmError(new Error('Upstream model request failed'))).toBe(true);
    expect(isRetryableLlmError(new Error('boom 503 service unavailable'))).toBe(true);
    expect(isRetryableLlmError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableLlmError(new Error('429 too many requests'))).toBe(false);
    expect(isRetryableLlmError(Object.assign(new Error('stop'), { code: 'USER_ABORT' }))).toBe(false);
  });

  it('tagRetryableLlmError stamps an untagged error and leaves tagged ones alone', () => {
    const fresh = new Error('upstream blew up');
    tagRetryableLlmError(fresh);
    expect((fresh as Error & { code?: string }).code).toBe('UPSTREAM_MODEL');

    const tagged = Object.assign(new Error('aborted'), { code: 'USER_ABORT' });
    tagRetryableLlmError(tagged);
    expect(tagged.code).toBe('USER_ABORT');
  });

  it('summarizeLlmError collapses whitespace and caps length', () => {
    expect(summarizeLlmError(new Error('a\n\n  b   c'))).toBe('a b c');
    const long = summarizeLlmError(new Error('x'.repeat(500)));
    expect(long.length).toBe(180);
    expect(long.endsWith('...')).toBe(true);
  });

  it('isContinuationPrompt detects contentless "keep going" prompts but not real goals', () => {
    expect(isContinuationPrompt('good lets keep going')).toBe(true);
    expect(isContinuationPrompt('continue')).toBe(true);
    expect(isContinuationPrompt('please continue')).toBe(true);
    expect(isContinuationPrompt('keep going on the auth refactor for the user-service')).toBe(false);
    expect(isContinuationPrompt('')).toBe(false);
  });
});
