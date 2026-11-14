import { describe, it, expect } from 'vitest';
import { answerAcknowledgesToolError } from '../src/tools/loop/toolErrorAcknowledged';

const BLOCKED = 'Blocked: burtson.ai resolves to the private/loopback/link-local address 192.168.1.44. Set BANDIT_ALLOW_PRIVATE_WEB_FETCH=1 to allow fetches against internal networks.';

describe('answerAcknowledgesToolError', () => {
  it('accepts an answer that repeats a distinctive token from the error', () => {
    expect(answerAcknowledgesToolError('The site lives at 192.168.1.44 here, so I read my notes about it instead.', [BLOCKED])).toBe(true);
    expect(answerAcknowledgesToolError('Turn on BANDIT_ALLOW_PRIVATE_WEB_FETCH=1 and ask again; here is what I know meanwhile.', [BLOCKED])).toBe(true);
  });

  it('accepts an answer that plainly says the step failed', () => {
    expect(answerAcknowledgesToolError("I can't open that page from here, so here is what I know about it.", ['boom'])).toBe(true);
  });

  it('rejects a short or unrelated reply (the silent-abandon case)', () => {
    expect(answerAcknowledgesToolError('Oh well, moving on to something else.', [BLOCKED])).toBe(false);
    expect(answerAcknowledgesToolError('Here is an overview of the project structure and its main modules.', [BLOCKED])).toBe(false);
    expect(answerAcknowledgesToolError('', [BLOCKED])).toBe(false);
  });

  it('ignores generic words that appear in every error', () => {
    expect(answerAcknowledgesToolError('Internal networks are interesting; let me summarize the repository instead.', [BLOCKED])).toBe(false);
  });
});
