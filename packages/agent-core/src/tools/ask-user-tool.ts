/**
 * `ask_user` — pose one or more clarifying questions to the user and wait
 * for their answer before continuing.
 *
 * Host-agnostic: the tool only formats the question payload and the answer
 * summary. The actual interactive prompt is rendered by the host via
 * `ToolExecutionContext.requestUserInput` (the CLI's ink form, the
 * extension's webview card). When a host doesn't provide that callback the
 * tool degrades to telling the model to ask in plain text, so it's always
 * safe to register — though hosts typically only register the owning skill
 * when they actually have an interactive surface (see interaction-skill).
 */

import type { AgentTool, UserInputQuestion } from './tool-types';

const QUESTIONS_EXAMPLE =
  '[{"question":"Which database should we use?","header":"Database","options":' +
  '[{"label":"Postgres","description":"Relational, strong consistency"},' +
  '{"label":"MongoDB","description":"Flexible document store"}],"allowFreeform":true}]';

type ParsedOption = { label: string; description?: string };

function coerceOption(raw: unknown): ParsedOption | null {
  if (typeof raw === 'string') {return raw.trim() ? { label: raw.trim() } : null;}
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label
      : typeof o.value === 'string' ? o.value
      : typeof o.text === 'string' ? o.text : '';
    if (!label.trim()) {return null;}
    return {
      label: label.trim(),
      description: typeof o.description === 'string' ? o.description : undefined
    };
  }
  return null;
}

/** Parse the model-supplied `questions` JSON into validated question specs.
 *  Tolerant: accepts a single object (not wrapped in an array), string
 *  options, and `question`/`text`/`prompt` aliases. Assigns stable ids. */
export function parseAskUserQuestions(rawJson: string): UserInputQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const questions: UserInputQuestion[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {return;}
    const r = raw as Record<string, unknown>;
    const text = typeof r.question === 'string' ? r.question
      : typeof r.text === 'string' ? r.text
      : typeof r.prompt === 'string' ? r.prompt : '';
    if (!text.trim()) {return;}
    const options = (Array.isArray(r.options) ? r.options : [])
      .map(coerceOption)
      .filter((o): o is ParsedOption => o !== null);
    questions.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `q${i + 1}`,
      question: text.trim(),
      header: typeof r.header === 'string' && r.header.trim() ? r.header.trim() : undefined,
      options: options.length > 0 ? options : undefined,
      allowFreeform: r.allowFreeform === false ? false : true
    });
  });
  return questions;
}

export const askUserTool: AgentTool = {
  name: 'ask_user',
  description:
    'Ask the user one or more clarifying questions and WAIT for their answer before continuing. ' +
    'ALWAYS use this tool when you need a decision or direction from the user — do NOT ask in your prose ' +
    'response and end the turn. A prose question is passive (the user must start a new turn); this renders ' +
    'an interactive prompt they answer in one click. ' +
    'Use only when you are genuinely blocked on a decision that is the user\'s to make and cannot be ' +
    'resolved from the request, the code, or sensible defaults — not for routine choices you can make ' +
    'yourself. Provide 1–4 questions, each with 2–4 suggested options (the user can also type their own ' +
    'answer). When one option is the clear best choice, make it the FIRST option and append ' +
    '" (Recommended)" to its label — it is pre-selected, so the user can accept it with one click. ' +
    'The tool result contains the user\'s answers; act on them directly without re-asking.',
  parameters: [
    {
      name: 'questions',
      description:
        'A JSON array of question objects. Each object: { "question": "the question text", ' +
        '"header": "short tab label", "options": [{ "label": "...", "description": "optional context" }], ' +
        '"allowFreeform": true }. Example: ' + QUESTIONS_EXAMPLE,
      required: true,
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask the user.' },
            header: { type: 'string', description: 'A short (≤12 char) label for the question tab.' },
            options: {
              type: 'array',
              description: 'Suggested answers (2–4). If one is the clear best choice, list it first and append " (Recommended)" to its label.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The option text.' },
                  description: { type: 'string', description: 'Optional one-line explanation of the option.' }
                },
                required: ['label']
              }
            },
            allowFreeform: { type: 'boolean', description: 'Allow a typed custom answer (default true).' }
          },
          required: ['question']
        }
      }
    }
  ],
  async execute(params, ctx) {
    if (!ctx.requestUserInput) {
      return {
        output:
          'Interactive questions are not available in this environment. Ask your question(s) in plain ' +
          'text in your normal response and wait for the user to reply.',
        isError: false
      };
    }

    const questions = parseAskUserQuestions(params.questions ?? '');
    if (questions.length === 0) {
      return {
        output:
          'ask_user failed: the `questions` parameter must be a JSON array of {question, options} ' +
          'objects. Example: ' + QUESTIONS_EXAMPLE,
        isError: true
      };
    }

    const res = await ctx.requestUserInput({ questions });
    if (res.cancelled) {
      return {
        output:
          'The user dismissed the question(s) without answering. Do not immediately re-ask — proceed ' +
          'with your best judgment, or briefly explain what you need and let the user respond when ready.',
        isError: false
      };
    }

    const lines = questions.map((q) => {
      const a = res.answers[q.id];
      return `Q: ${q.question}\nA: ${a !== undefined && a !== '' ? a : '(no answer)'}`;
    });
    return { output: 'The user answered:\n\n' + lines.join('\n\n'), isError: false };
  }
};
