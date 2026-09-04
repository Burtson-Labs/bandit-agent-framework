/**
 * Learning-memory store — .bandit/lessons.md. Properties: add persists +
 * dedupes near-identical lessons, the cap drops the oldest, clear removes the
 * file, and loadMemory picks the file up (so lessons inject on future turns).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { loadLessons, addLesson, clearLessons, lessonsPath } from '../src/lessons';
import { loadMemory } from '../src/memory';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'bandit-lessons-'));
});

describe('lesson store', () => {
  it('adds, persists, and reads back', () => {
    expect(loadLessons(cwd)).toEqual([]);
    const r = addLesson(cwd, 'This project uses pnpm, not npm.');
    expect(r).toMatchObject({ added: true, total: 1 });
    expect(loadLessons(cwd)).toEqual(['This project uses pnpm, not npm.']);
  });

  it('dedupes near-identical lessons (normalized-equal)', () => {
    addLesson(cwd, 'This project uses pnpm.');
    const dup = addLesson(cwd, 'this   project uses pnpm');
    expect(dup).toMatchObject({ added: false, reason: 'duplicate', total: 1 });
    expect(loadLessons(cwd)).toHaveLength(1);
  });

  it('rejects empty', () => {
    expect(addLesson(cwd, '   ')).toMatchObject({ added: false, reason: 'empty' });
  });

  it('caps the store, dropping the oldest', () => {
    for (let i = 0; i < 45; i++) addLesson(cwd, `lesson number ${i}`);
    const kept = loadLessons(cwd);
    expect(kept.length).toBe(40);
    expect(kept[0]).toBe('lesson number 5');   // 0..4 fell off
    expect(kept.at(-1)).toBe('lesson number 44');
  });

  it('clear removes the file', () => {
    addLesson(cwd, 'something');
    clearLessons(cwd);
    expect(loadLessons(cwd)).toEqual([]);
  });

  it('loadMemory injects lessons as a labeled source (so they reach the model)', async () => {
    addLesson(cwd, 'Tests for src/api live in test/api.');
    const bundle = await loadMemory(cwd);
    expect(bundle.sources).toContain(path.join('.bandit', 'lessons.md'));
    expect(bundle.content).toContain('Tests for src/api live in test/api.');
    expect(bundle.content).toContain('Learned lessons'); // the lower-trust header travels with it
  });

  it('lessonsPath resolves under .bandit', () => {
    expect(lessonsPath(cwd)).toBe(path.join(cwd, '.bandit', 'lessons.md'));
  });
});

afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } });
