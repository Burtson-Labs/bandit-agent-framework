import { describe, it, expect } from 'vitest';
import { searchHistory } from '../src/input/historySearch';

const HISTORY = [
  'git status',
  'run the tests',
  'fix the auth bug',
  'run the tests again',
  'git commit -m wip',
];

describe('searchHistory', () => {
  it('matches substrings, most-recent-first', () => {
    // Newest 'run the tests again' comes before older 'run the tests'.
    expect(searchHistory(HISTORY, 'run the tests')).toEqual([
      'run the tests again',
      'run the tests',
    ]);
  });

  it('is case-insensitive', () => {
    expect(searchHistory(HISTORY, 'GIT')).toEqual(['git commit -m wip', 'git status']);
  });

  it('returns nothing for an empty query', () => {
    expect(searchHistory(HISTORY, '')).toEqual([]);
    expect(searchHistory(HISTORY, '   ')).toEqual([]);
  });

  it('de-duplicates identical entries', () => {
    expect(searchHistory(['a', 'b', 'a', 'a'], 'a')).toEqual(['a']);
  });

  it('returns [] when nothing matches', () => {
    expect(searchHistory(HISTORY, 'zzz')).toEqual([]);
  });
});
