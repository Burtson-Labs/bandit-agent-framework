/**
 * Learning-memory distiller — the shared "did we learn anything durable?" core.
 * Properties: the prompt frames repo-durable facts (not task history), and
 * parsing yields a clean one-line lesson OR null for the common "nothing
 * learned" case, tolerating the label/quote/bullet noise models add.
 */
import { describe, it, expect } from 'vitest';
import { buildLessonPrompt, parseLesson, normalizeLesson, NO_LESSON } from '../src/lessons';

describe('buildLessonPrompt', () => {
  it('frames durable repo facts and carries the turn + tools + outcome', () => {
    const p = buildLessonPrompt({
      prompt: 'run the build',
      assistantResponse: 'The build failed until I ran pnpm codegen first, then pnpm build passed.',
      toolsUsed: ['run_command'],
      outcome: 'ok',
    });
    expect(p).toContain('DURABLE');
    expect(p).toContain('run the build');
    expect(p).toContain('Tools used: run_command');
    expect(p).toContain('Outcome: ok');
    expect(p).toContain(NO_LESSON); // the escape hatch is offered
  });
});

describe('parseLesson', () => {
  it('returns null for NONE in any casing/punctuation', () => {
    for (const s of ['NONE', 'none', 'None.', 'none!']) expect(parseLesson(s)).toBeNull();
  });

  it('returns null for empty / non-answers', () => {
    expect(parseLesson('')).toBeNull();
    expect(parseLesson('   ')).toBeNull();
    expect(parseLesson('nothing durable here')).toBeNull();
    expect(parseLesson('N/A')).toBeNull();
  });

  it('extracts a clean one-line lesson, stripping label/quotes/bullet', () => {
    expect(parseLesson('This project uses pnpm, not npm.')).toBe('This project uses pnpm, not npm.');
    expect(parseLesson('Lesson: tests for src/api live in test/api')).toBe('tests for src/api live in test/api');
    expect(parseLesson('- "The build needs codegen first"')).toBe('The build needs codegen first');
  });

  it('rejects paragraph-length replies (model ignored the one-line rule)', () => {
    expect(parseLesson('x'.repeat(250))).toBeNull();
  });
});

describe('normalizeLesson', () => {
  it('makes dedup-equal lessons compare equal', () => {
    expect(normalizeLesson('This project uses pnpm.')).toBe(normalizeLesson('this   project uses pnpm'));
    expect(normalizeLesson('A.')).not.toBe(normalizeLesson('B.'));
  });
});
