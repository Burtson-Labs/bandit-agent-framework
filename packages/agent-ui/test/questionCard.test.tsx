import { describe, expect, it } from 'vitest';

import { QuestionCard, toUserInputResponse, type QuestionPayload } from '../src/components/QuestionCard';
import { buttonNamed, click, key, mount } from './_dom';

type Submit = [string, Record<string, string>, boolean | undefined];

const one: QuestionPayload[] = [
  { id: 'lang', question: 'Which language?', options: [{ label: 'TypeScript' }, { label: 'Go' }] }
];
const two: QuestionPayload[] = [
  { id: 'lang', header: 'Language', question: 'Which language?', options: [{ label: 'TypeScript' }, { label: 'Go' }] },
  { id: 'name', header: 'Name', question: 'Project name?' }
];

describe('QuestionCard', () => {
  it('labels each question group and the free-text answer', () => {
    const el = mount(<QuestionCard id="q" questions={one} onSubmit={() => {}} />);
    const group = el.querySelector('[role="radiogroup"]')!;
    const labelledBy = group.getAttribute('aria-labelledby')!;
    expect(el.ownerDocument.getElementById(labelledBy)?.textContent).toBe('Which language?');
    expect(el.querySelector('input[type="text"]')?.getAttribute('aria-label')).toContain('Which language?');
  });

  it('submits the pre-selected first option on Enter, once', () => {
    const calls: Submit[] = [];
    const el = mount(<QuestionCard id="q" questions={one} onSubmit={(...a) => calls.push(a)} />);
    const card = el.querySelector('.question-card')!;
    key(card, 'Enter');
    key(card, 'Enter');
    click(buttonNamed(el, 'Submit'));
    expect(calls).toEqual([['q', { lang: 'TypeScript' }, undefined]]);
  });

  it('ignores Enter while an IME is composing', () => {
    const calls: Submit[] = [];
    const el = mount(<QuestionCard id="q" questions={one} onSubmit={(...a) => calls.push(a)} />);
    key(el.querySelector('.question-card')!, 'Enter', { isComposing: true });
    expect(calls).toEqual([]);
  });

  it('Escape cancels', () => {
    const calls: Submit[] = [];
    const el = mount(<QuestionCard id="q" questions={one} onSubmit={(...a) => calls.push(a)} />);
    key(el.querySelector('.question-card')!, 'Escape');
    expect(calls).toEqual([['q', {}, true]]);
  });

  it('multi-question tabs follow the tabs pattern with arrow keys', () => {
    const el = mount(<QuestionCard id="q" questions={two} onSubmit={() => {}} />);
    const tabs = Array.from(el.querySelectorAll('[role="tab"]')) as HTMLElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(['Language (answered)', 'Name', 'Submit']);
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs[1].getAttribute('tabindex')).toBe('-1');
    const panel = el.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
    key(tabs[0], 'ArrowRight');
    const after = Array.from(el.querySelectorAll('[role="tab"]'));
    expect(after[1].getAttribute('aria-selected')).toBe('true');
    expect(el.textContent).toContain('Project name?');
    key(after[1], 'End');
    expect(el.textContent).toContain('Review your answers');
    expect(el.textContent).toContain('Not answered');
  });

  it('builds the userInputResponse wire message', () => {
    expect(toUserInputResponse('q', { a: 'b' })).toEqual({
      type: 'userInputResponse',
      id: 'q',
      answers: { a: 'b' },
      cancelled: undefined
    });
  });
});
