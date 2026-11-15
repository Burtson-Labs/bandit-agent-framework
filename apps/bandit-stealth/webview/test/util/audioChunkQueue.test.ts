import { describe, expect, it } from 'vitest';
import { AudioChunkQueue } from '../../src/util/audioChunkQueue';

describe('AudioChunkQueue', () => {
  it('plays chunks strictly in order and holds the prefetched one', () => {
    const q = new AudioChunkQueue<string>('m', 3);
    expect(q.accept(0, 'a')).toEqual({ index: 0, payload: 'a' });
    // Chunk 1 arrives while chunk 0 plays: held, not played over it.
    expect(q.accept(1, 'b')).toBeNull();
    expect(q.ended()).toEqual({ index: 1, payload: 'b' });
    // Chunk 2 has not arrived when chunk 1 ends: wait, then play on arrival.
    expect(q.ended()).toBe('wait');
    expect(q.accept(2, 'c')).toEqual({ index: 2, payload: 'c' });
    expect(q.ended()).toBe('done');
  });

  it('ignores a duplicate of a chunk already played', () => {
    const q = new AudioChunkQueue<string>('m', 2);
    q.accept(0, 'a');
    expect(q.accept(0, 'a-again')).toBeNull();
    q.accept(1, 'b');
    expect(q.ended()).toEqual({ index: 1, payload: 'b' });
  });

  it('a single-chunk read is done after its one chunk', () => {
    const q = new AudioChunkQueue<string>('m', 1);
    expect(q.accept(0, 'a')).toEqual({ index: 0, payload: 'a' });
    expect(q.ended()).toBe('done');
  });
});
