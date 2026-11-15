/**
 * Ordering for chunked Bandit Cloud read-aloud. The extension host sends a
 * long reply as `playAudio` messages carrying `chunkIndex` / `chunkCount`;
 * this queue plays them strictly in order, holds a chunk that arrives early
 * (the one prefetched while the previous one plays), and says when the read
 * is finished.
 */
export interface QueuedChunk<T> {
  index: number;
  payload: T;
}

export class AudioChunkQueue<T> {
  private readonly ready = new Map<number, T>();
  private nextIndex = 0;
  private playing = false;

  constructor(readonly entryId: string, readonly count: number) {}

  /**
   * A chunk arrived. Returns it (or the next in order) when the player is
   * idle and it is next; otherwise holds it and returns null.
   */
  accept(index: number, payload: T): QueuedChunk<T> | null {
    if (index < this.nextIndex) {return null;}
    this.ready.set(index, payload);
    return this.playing ? null : this.takeNext();
  }

  /**
   * The playing chunk ended. Returns the next chunk to play, `"wait"` when it
   * has not arrived yet, or `"done"` after the last chunk.
   */
  ended(): QueuedChunk<T> | "wait" | "done" {
    this.playing = false;
    if (this.nextIndex >= this.count) {return "done";}
    return this.takeNext() ?? "wait";
  }

  private takeNext(): QueuedChunk<T> | null {
    const payload = this.ready.get(this.nextIndex);
    if (payload === undefined) {return null;}
    this.ready.delete(this.nextIndex);
    const chunk = { index: this.nextIndex, payload };
    this.nextIndex++;
    this.playing = true;
    return chunk;
  }
}
