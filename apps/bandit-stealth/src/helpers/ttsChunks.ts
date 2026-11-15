/**
 * Chunked Bandit Cloud read-aloud.
 *
 * The gateway refuses a TTS request over 4,000 characters (413), so a long
 * assistant reply is split into requests of at most {@link MAX_TTS_CHUNK_CHARS}
 * characters at paragraph, then sentence, then word boundaries, and the chunks
 * are played back to back. The extension host synthesises; the webview plays
 * and reports each chunk as it starts (`audioChunkPlaying`), which lets the
 * host fetch exactly one chunk ahead of what is audible. Stop (`stopSpeaking`)
 * aborts the request in flight and nothing further is requested.
 */

export const MAX_TTS_CHUNK_CHARS = 3500;

/** Pack whole words into runs of at most `max` characters. */
function splitWords(text: string, max: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > max) {
      // A single "word" longer than the limit (a URL, a hash) is the only
      // thing ever cut mid-token.
      if (current) { out.push(current); current = ''; }
      for (let i = 0; i < word.length; i += max) {out.push(word.slice(i, i + max));}
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > max) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {out.push(current);}
  return out;
}

/** Sentences, each keeping its closing punctuation (and any closing quote/bracket). */
function splitSentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g);
  return (parts ?? [paragraph]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Split `text` into chunks of at most `max` characters. Paragraph breaks are
 * preferred, then sentence ends, then spaces; no word is cut unless it is
 * itself longer than `max`. Order is kept and no words are lost (runs of
 * whitespace collapse to the single space or blank line that joins chunks).
 */
export function chunkTextForTts(text: string, max = MAX_TTS_CHUNK_CHARS): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {return [];}
  if (trimmed.length <= max) {return [trimmed];}

  // Units small enough to pack: whole paragraphs, else sentences, else word runs.
  const units: { text: string; paragraphStart: boolean }[] = [];
  for (const paragraph of trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    const pieces = paragraph.length <= max
      ? [paragraph]
      : splitSentences(paragraph).flatMap((s) => (s.length <= max ? [s] : splitWords(s, max)));
    pieces.forEach((p, i) => units.push({ text: p, paragraphStart: i === 0 }));
  }

  // Pack units greedily so each request is as full as the limit allows.
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const joiner = unit.paragraphStart ? '\n\n' : ' ';
    const candidate = current ? `${current}${joiner}${unit.text}` : unit.text;
    if (candidate.length > max) {
      if (current) {chunks.push(current);}
      current = unit.text;
    } else {
      current = candidate;
    }
  }
  if (current) {chunks.push(current);}
  return chunks;
}

export interface SynthesizedChunk {
  audio: Uint8Array;
  mimeType: string;
}

export interface ChunkedTtsDeps {
  /** One normal TTS request for one chunk. Must honour `signal`. */
  synthesize(text: string, signal: AbortSignal): Promise<SynthesizedChunk>;
  /** Hand a synthesised chunk to the player. */
  deliver(index: number, count: number, chunk: SynthesizedChunk): void;
  /** A chunk failed (429, 413, network): playback stops and the message is shown. */
  fail(message: string): void;
}

/**
 * One read-aloud of one message. Chunk 0 is fetched at once; chunk k (k ≥ 1)
 * is fetched only after the player reports chunk k−1 playing, so at most one
 * chunk is ever waiting beyond the audible one.
 */
export class ChunkedTtsSession {
  private readonly controller = new AbortController();
  private playingIndex = -1;
  private wake: (() => void) | null = null;
  private finished = false;

  constructor(private readonly chunks: string[], private readonly deps: ChunkedTtsDeps) {}

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get done(): boolean {
    return this.finished;
  }

  /** The player started chunk `index`. */
  notifyPlaying(index: number): void {
    if (index > this.playingIndex) {
      this.playingIndex = index;
      this.wake?.();
    }
  }

  /** Stop: abort the request in flight and request nothing more. */
  cancel(): void {
    if (this.cancelled) {return;}
    this.controller.abort();
    this.wake?.();
  }

  /**
   * Runs the whole read. The returned promise resolves once chunk 0 has been
   * delivered (or failed); the remaining chunks continue in the background.
   * `completion` resolves when everything is fetched, cancelled or failed.
   */
  start(): { first: Promise<void>; completion: Promise<void> } {
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => { resolveFirst = r; });
    const completion = this.run(resolveFirst).finally(() => {
      this.finished = true;
      resolveFirst();
    });
    return { first, completion };
  }

  private async run(onFirst: () => void): Promise<void> {
    const count = this.chunks.length;
    for (let index = 0; index < count; index++) {
      if (index > 0) {
        await this.waitUntil(() => this.playingIndex >= index - 1);
      }
      if (this.cancelled) {return;}
      let chunk: SynthesizedChunk;
      try {
        chunk = await this.deps.synthesize(this.chunks[index], this.controller.signal);
      } catch (err) {
        if (!this.cancelled) {
          this.deps.fail(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (this.cancelled) {return;}
      this.deps.deliver(index, count, chunk);
      if (index === 0) {onFirst();}
    }
  }

  private waitUntil(condition: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.cancelled || condition()) {
          this.wake = null;
          resolve();
        } else {
          this.wake = check;
        }
      };
      check();
    });
  }
}
