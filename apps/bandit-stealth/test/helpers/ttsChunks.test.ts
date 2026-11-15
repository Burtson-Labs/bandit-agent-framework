import { describe, it, expect } from 'vitest';
import { ChunkedTtsSession, MAX_TTS_CHUNK_CHARS, chunkTextForTts, type SynthesizedChunk } from '../../src/helpers/ttsChunks';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function sentence(n: number, len = 80): string {
  const base = `Sentence number ${n} talks about the build and the deploy`;
  let s = base;
  while (s.length < len) {s += ' and more';}
  return `${s}.`;
}

describe('chunkTextForTts', () => {
  it('returns short text as one chunk and nothing for blank text', () => {
    expect(chunkTextForTts('Hello there.')).toEqual(['Hello there.']);
    expect(chunkTextForTts('   \n\n ')).toEqual([]);
  });

  it('keeps every chunk within 3,500 characters and loses no words', () => {
    const text = Array.from({ length: 12 }, (_, p) =>
      Array.from({ length: 12 }, (_, i) => sentence(p * 100 + i)).join(' ')
    ).join('\n\n');
    expect(text.length).toBeGreaterThan(10_000);
    const chunks = chunkTextForTts(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHUNK_CHARS);}
    expect(words(chunks.join(' '))).toEqual(words(text));
  });

  it('prefers paragraph boundaries', () => {
    const para = (n: number) => Array.from({ length: 25 }, (_, i) => sentence(n * 100 + i)).join(' ');
    const p1 = para(1);
    const p2 = para(2);
    expect(p1.length).toBeLessThan(MAX_TTS_CHUNK_CHARS);
    expect(p1.length + p2.length).toBeGreaterThan(MAX_TTS_CHUNK_CHARS);
    expect(chunkTextForTts(`${p1}\n\n${p2}`)).toEqual([p1, p2]);
  });

  it('splits an over-long paragraph at sentence ends', () => {
    const sentences = Array.from({ length: 80 }, (_, i) => sentence(i));
    const chunks = chunkTextForTts(sentences.join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.endsWith('.')).toBe(true);
      expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHUNK_CHARS);
    }
  });

  it('splits an over-long sentence at spaces, never mid-word', () => {
    const longSentence = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ') + '.';
    expect(longSentence.length).toBeGreaterThan(MAX_TTS_CHUNK_CHARS * 2);
    const chunks = chunkTextForTts(longSentence);
    const original = new Set(words(longSentence));
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHUNK_CHARS);
      for (const w of words(c)) {expect(original.has(w)).toBe(true);}
    }
    expect(words(chunks.join(' '))).toEqual(words(longSentence));
  });

  it('hard-splits only a single word longer than the limit', () => {
    const huge = 'x'.repeat(MAX_TTS_CHUNK_CHARS * 2 + 10);
    const chunks = chunkTextForTts(`Before. ${huge} after.`);
    for (const c of chunks) {expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHUNK_CHARS);}
    expect(chunks.join('').replace(/\s+/g, '')).toBe(`Before.${huge}after.`);
    expect(chunks[0]).toBe('Before.');
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const audio = (): SynthesizedChunk => ({ audio: new Uint8Array([1]), mimeType: 'audio/mpeg' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(chunks: string[]) {
  const requests: { text: string; signal: AbortSignal; d: ReturnType<typeof deferred<SynthesizedChunk>> }[] = [];
  const delivered: number[] = [];
  const failures: string[] = [];
  const session = new ChunkedTtsSession(chunks, {
    synthesize: (text, signal) => {
      const d = deferred<SynthesizedChunk>();
      signal.addEventListener('abort', () => d.reject(new Error('aborted')));
      requests.push({ text, signal, d });
      return d.promise;
    },
    deliver: (index) => { delivered.push(index); },
    fail: (m) => { failures.push(m); }
  });
  return { session, requests, delivered, failures };
}

describe('ChunkedTtsSession', () => {
  it('fetches chunk 0 at once and each next chunk one ahead of playback', async () => {
    const h = harness(['a', 'b', 'c', 'd']);
    const { first, completion } = h.session.start();
    await tick();
    expect(h.requests.map((r) => r.text)).toEqual(['a']);

    h.requests[0].d.resolve(audio());
    await first;
    expect(h.delivered).toEqual([0]);
    await tick();
    // Chunk 1 waits until chunk 0 is audible.
    expect(h.requests).toHaveLength(1);

    h.session.notifyPlaying(0);
    await tick();
    expect(h.requests.map((r) => r.text)).toEqual(['a', 'b']);
    h.requests[1].d.resolve(audio());
    await tick();
    expect(h.delivered).toEqual([0, 1]);
    // Never more than one ahead: chunk 2 waits for chunk 1 to play.
    expect(h.requests).toHaveLength(2);

    h.session.notifyPlaying(1);
    await tick();
    h.requests[2].d.resolve(audio());
    await tick();
    h.session.notifyPlaying(2);
    await tick();
    h.requests[3].d.resolve(audio());
    await completion;
    expect(h.delivered).toEqual([0, 1, 2, 3]);
    expect(h.failures).toEqual([]);
  });

  it('stop aborts the request in flight and requests nothing more', async () => {
    const h = harness(['a', 'b', 'c']);
    const { completion } = h.session.start();
    await tick();
    h.requests[0].d.resolve(audio());
    await tick();
    h.session.notifyPlaying(0);
    await tick();
    expect(h.requests).toHaveLength(2);

    h.session.cancel();
    await completion;
    expect(h.requests[1].signal.aborted).toBe(true);
    h.session.notifyPlaying(1);
    await tick();
    expect(h.requests).toHaveLength(2);
    expect(h.delivered).toEqual([0]);
    expect(h.failures).toEqual([]); // a cancel is not an error
  });

  it('stop while waiting for playback ends the read without another request', async () => {
    const h = harness(['a', 'b']);
    const { completion } = h.session.start();
    await tick();
    h.requests[0].d.resolve(audio());
    await tick();
    h.session.cancel();
    await completion;
    expect(h.requests).toHaveLength(1);
  });

  it('a failed chunk (429/413) is reported once and stops the read', async () => {
    const h = harness(['a', 'b', 'c']);
    const { completion } = h.session.start();
    await tick();
    h.requests[0].d.resolve(audio());
    await tick();
    h.session.notifyPlaying(0);
    await tick();
    h.requests[1].d.reject(new Error('Bandit TTS failed: 429 Too Many Requests'));
    await completion;
    h.session.notifyPlaying(1);
    await tick();
    expect(h.failures).toEqual(['Bandit TTS failed: 429 Too Many Requests']);
    expect(h.requests).toHaveLength(2);
    expect(h.delivered).toEqual([0]);
  });
});
