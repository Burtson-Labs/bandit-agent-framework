import { describe, it, expect } from 'vitest';
import {
  looksLikeYesNoQuestion,
  stripHiddenReasoningForDetection
} from '../src/heuristics/yesNoDetect';

describe('looksLikeYesNoQuestion — affirmative-pivot questions', () => {
  it('fires on "would you like" / "should I" / "do you want" / "want me to" / "shall I"', () => {
    expect(looksLikeYesNoQuestion('Would you like me to retry?')).toBe(true);
    expect(looksLikeYesNoQuestion('Should I retry the failed step?')).toBe(true);
    expect(looksLikeYesNoQuestion('Do you want me to keep going?')).toBe(true);
    expect(looksLikeYesNoQuestion('Want me to ship it?')).toBe(true);
    expect(looksLikeYesNoQuestion('Shall I commit the change?')).toBe(true);
  });

  it('fires on "proceed?" / "ok to X" / "is that ok"', () => {
    expect(looksLikeYesNoQuestion('Ready to proceed?')).toBe(true);
    expect(looksLikeYesNoQuestion('Okay to overwrite the file?')).toBe(true);
    expect(looksLikeYesNoQuestion('Is that ok with you?')).toBe(true);
    expect(looksLikeYesNoQuestion('Is that fine?')).toBe(true);
  });
});

describe('looksLikeYesNoQuestion — declarative statements do not fire', () => {
  it('returns false for plain prose with no question mark', () => {
    expect(looksLikeYesNoQuestion('I refactored the auth flow and added tests.')).toBe(false);
    expect(looksLikeYesNoQuestion('All done.')).toBe(false);
    expect(looksLikeYesNoQuestion('')).toBe(false);
  });

  it('returns false for statements that happen to mention y/n trigger words', () => {
    // "Can I" was deliberately removed from the pattern list because verbose
    // models emit "Can I summarize…?" as a rhetorical statement. Likewise
    // "may I" was removed.
    expect(looksLikeYesNoQuestion('Can I summarize the change?')).toBe(false);
    expect(looksLikeYesNoQuestion('May I walk through the flow?')).toBe(false);
  });
});

describe('looksLikeYesNoQuestion — open-ended questions do not fire', () => {
  it('wh-word prefix on the tail suppresses the y/n hint', () => {
    expect(looksLikeYesNoQuestion('What would you like to do next?')).toBe(false);
    expect(looksLikeYesNoQuestion('Where do you want the file?')).toBe(false);
    expect(looksLikeYesNoQuestion('Which one should I keep?')).toBe(false);
  });

  it('multi-choice / enumeration patterns suppress', () => {
    expect(
      looksLikeYesNoQuestion('Want me to dig into anything specific — resource usage, pods, etc.?')
    ).toBe(false);
    expect(looksLikeYesNoQuestion('Do you want me to add tests, docs, and types?')).toBe(false);
  });

  it('question mark inside a fenced code block is ignored', () => {
    const text = 'Done.\n\n```bash\ncurl https://example.com/?q=1\n```';
    // The visible text ends with a closing fence, not a `?`, so this should
    // be false regardless of the code-fence guard — but it confirms that
    // fenced examples never accidentally trigger the hint.
    expect(looksLikeYesNoQuestion(text)).toBe(false);
  });
});

describe('looksLikeYesNoQuestion — reasoning fences stripped before detection', () => {
  it('y/n phrase inside <think>…</think> does NOT trigger when the user-visible tail is declarative', () => {
    const text =
      '<think>Should I introduce myself first?</think>\n\nI am Bandit, your terminal coding agent.';
    expect(looksLikeYesNoQuestion(text)).toBe(false);
  });

  it('y/n phrase inside ```bandit-reasoning … ``` does NOT trigger', () => {
    const text =
      '```bandit-reasoning\nDo you want me to keep going?\n```\n\nHere is what I found.';
    expect(looksLikeYesNoQuestion(text)).toBe(false);
  });

  it('unterminated <think> opener is treated as fully hidden', () => {
    // Stream cut off mid-thinking-block — the rest of the message must
    // not be treated as user-visible.
    const text = 'Plain answer.\n\n<think>Should I proceed?';
    expect(looksLikeYesNoQuestion(text)).toBe(false);
  });

  it('y/n phrase that is genuinely user-visible still fires even after a <think> block', () => {
    const text =
      '<think>Working out the steps.</think>\n\nAll set. Should I commit it?';
    expect(looksLikeYesNoQuestion(text)).toBe(true);
  });
});

describe('stripHiddenReasoningForDetection', () => {
  it('removes <think>…</think> blocks', () => {
    expect(stripHiddenReasoningForDetection('a <think>hidden</think> b')).toBe('a  b');
  });

  it('removes bandit-reasoning fenced blocks', () => {
    expect(
      stripHiddenReasoningForDetection('intro\n```bandit-reasoning\nhidden\n```\nouter')
    ).toBe('intro\n\nouter');
  });

  it('truncates an unterminated <think> opener', () => {
    expect(stripHiddenReasoningForDetection('visible <think>tail-cut-off')).toBe('visible');
  });
});
