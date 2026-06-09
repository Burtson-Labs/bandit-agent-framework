/**
 * Contract tests for the `ask_user` tool + its question parser.
 *
 * Pins:
 *  - Graceful degrade: with no host `requestUserInput`, the tool returns a
 *    non-error "ask in plain text" instruction (so it's safe to register
 *    anywhere) — never throws, never hangs.
 *  - Tolerant parsing: a single object (not wrapped in an array), string
 *    options, and `question`/`text`/`prompt` aliases all parse; ids are
 *    assigned when omitted.
 *  - The request handed to the host carries the parsed questions; the tool
 *    output echoes the user's answers keyed back to each question.
 *  - Cancellation returns a non-error "dismissed" message, not the answers.
 *  - Malformed JSON / no valid questions → isError with the example.
 */
import { describe, expect, it } from 'vitest';
import { askUserTool, parseAskUserQuestions } from '../src/tools/ask-user-tool';
import type { ToolExecutionContext, UserInputRequest, UserInputResponse } from '../src/tools/tool-types';

function baseCtx(): ToolExecutionContext {
  return {
    workspaceRoot: '/tmp/test',
    async readFile() { return ''; },
    async writeFile() { /* no-op */ },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
}

function ctxWith(
  handler: (req: UserInputRequest) => Promise<UserInputResponse>
): { ctx: ToolExecutionContext; seen: UserInputRequest[] } {
  const seen: UserInputRequest[] = [];
  const ctx = baseCtx();
  ctx.requestUserInput = (req) => {
    seen.push(req);
    return handler(req);
  };
  return { ctx, seen };
}

describe('parseAskUserQuestions', () => {
  it('parses an array of rich question objects and assigns ids', () => {
    const qs = parseAskUserQuestions(JSON.stringify([
      { question: 'A?', header: 'A', options: [{ label: 'x', description: 'the x' }, { label: 'y' }] },
      { question: 'B?', allowFreeform: false }
    ]));
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ id: 'q1', question: 'A?', header: 'A', allowFreeform: true });
    expect(qs[0].options).toEqual([{ label: 'x', description: 'the x' }, { label: 'y', description: undefined }]);
    expect(qs[1]).toMatchObject({ id: 'q2', question: 'B?', allowFreeform: false });
  });

  it('accepts a single object, string options, and question aliases', () => {
    const qs = parseAskUserQuestions(JSON.stringify({ text: 'Pick one', options: ['red', 'green'] }));
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe('Pick one');
    expect(qs[0].options).toEqual([{ label: 'red' }, { label: 'green' }]);
  });

  it('returns [] on malformed JSON or empty questions', () => {
    expect(parseAskUserQuestions('not json')).toEqual([]);
    expect(parseAskUserQuestions(JSON.stringify([{ options: ['a'] }]))).toEqual([]);
  });
});

describe('ask_user tool', () => {
  it('degrades to a plain-text instruction when no host callback is wired', async () => {
    const res = await askUserTool.execute({ questions: JSON.stringify([{ question: 'A?' }]) }, baseCtx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/plain text/i);
  });

  it('forwards parsed questions to the host and echoes the answers', async () => {
    const { ctx, seen } = ctxWith(async (req) => ({
      answers: Object.fromEntries(req.questions.map((q) => [q.id, `picked for ${q.id}`]))
    }));
    const res = await askUserTool.execute({
      questions: JSON.stringify([{ question: 'First?' }, { question: 'Second?' }])
    }, ctx);
    expect(seen[0].questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('First?');
    expect(res.output).toContain('picked for q1');
    expect(res.output).toContain('picked for q2');
  });

  it('reports a clean dismissal without leaking partial answers', async () => {
    const { ctx } = ctxWith(async () => ({ answers: {}, cancelled: true }));
    const res = await askUserTool.execute({ questions: JSON.stringify([{ question: 'A?' }]) }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/dismissed/i);
  });

  it('errors with the example when the questions param is unparseable', async () => {
    const { ctx } = ctxWith(async () => ({ answers: {} }));
    const res = await askUserTool.execute({ questions: '{{ bad' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain('"question"');
  });
});
