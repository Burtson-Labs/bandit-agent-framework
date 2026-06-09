import { describe, it, expect, vi, afterEach } from 'vitest';
import { promptAskUser } from '../src/askUserPrompt';
import type { UserInputQuestion } from '@burtson-labs/agent-core';

// Under vitest stdin isn't a TTY, so promptAskUser takes its sequential
// fallback path — which is exactly what runs in piped/CI sessions. The
// raw-mode interactive form needs a real terminal and is verified by hand.

afterEach(() => {
  vi.restoreAllMocks();
});

function queuedReader(answers: string[]) {
  let i = 0;
  return () => Promise.resolve(answers[i++] ?? '');
}

describe('promptAskUser (non-TTY fallback)', () => {
  it('maps a numeric reply to the chosen option and free text to a custom answer', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const questions: UserInputQuestion[] = [
      { id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'green' }] },
      { id: 'q2', question: 'Anything else?' }
    ];
    const res = await promptAskUser(questions, { readLine: queuedReader(['2', 'ship it']) });
    expect(res.cancelled).toBeFalsy();
    expect(res.answers).toEqual({ q1: 'green', q2: 'ship it' });
  });

  it('skips a question answered with an empty line', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const questions: UserInputQuestion[] = [
      { id: 'q1', question: 'Optional', options: [{ label: 'a' }] }
    ];
    const res = await promptAskUser(questions, { readLine: queuedReader(['']) });
    expect(res.answers).toEqual({});
  });

  it('treats an out-of-range number as a free-text answer', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const questions: UserInputQuestion[] = [
      { id: 'q1', question: 'Pick', options: [{ label: 'only' }] }
    ];
    const res = await promptAskUser(questions, { readLine: queuedReader(['9']) });
    expect(res.answers).toEqual({ q1: '9' });
  });

  it('cancels cleanly when there is no reader and no TTY', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const res = await promptAskUser([{ id: 'q1', question: 'A?' }], {});
    expect(res.cancelled).toBe(true);
  });
});
