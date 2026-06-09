import { describe, expect, it } from 'vitest';
import {
  dedupeBanditReasoningFences,
  stripReasoningAlreadyInTranscript
} from '../../src/helpers/reasoningDedup';

const REASONING = [
  '```bandit-reasoning',
  'The patch was applied successfully.',
  'Let me verify the file and summarize.',
  '```'
].join('\n');

describe('reasoning transcript cleanup', () => {
  it('removes duplicate reasoning fences from one transcript', () => {
    const result = dedupeBanditReasoningFences(`${REASONING}\n\n${REASONING}\n\nAll updated.`);
    expect(result).toBe(`${REASONING}\n\nAll updated.`);
  });

  it('strips final-response reasoning that already streamed into the transcript', () => {
    const result = stripReasoningAlreadyInTranscript(
      `${REASONING}\n\nAll updated.`,
      `Tool trace\n\n${REASONING}`
    );
    expect(result).toBe('All updated.');
  });

  it('keeps final-response reasoning when it was not streamed yet', () => {
    const result = stripReasoningAlreadyInTranscript(
      `${REASONING}\n\nAll updated.`,
      'Tool trace without reasoning'
    );
    expect(result).toBe(`${REASONING}\n\nAll updated.`);
  });
});
