import { describe, it, expect } from 'vitest';
import {
  consumeStreamChunk,
  flushStreamChunkBuffer,
  createStreamStrippingState
} from '../src/streaming/streamStripping';

function pump(chunks: readonly string[]) {
  const state = createStreamStrippingState();
  let out = '';
  for (const c of chunks) out += consumeStreamChunk(state, c);
  out += flushStreamChunkBuffer(state);
  return { out, state };
}

describe('consumeStreamChunk — suppressed blocks', () => {
  it('strips <think> blocks delivered in a single chunk', () => {
    const { out } = pump(['hello <think>internal</think> world']);
    expect(out).toBe('hello  world');
  });

  it('strips <tool_call> blocks', () => {
    const { out } = pump(['answer: <tool_call>{"name":"x"}</tool_call> done']);
    expect(out).toBe('answer:  done');
  });

  it('suppresses <think> across chunk boundaries (open tag split, close intact)', () => {
    // The opening tag is split mid-chunk; the partial opener must be
    // held back rather than emitted as visible prose.
    const { out } = pump(['pre <thi', 'nk>hidden</think> post']);
    expect(out).toBe('pre  post');
  });

  it('preserves the earliest tag when <think> precedes <tool_call> in one buffer', () => {
    const { out } = pump(['a <think>t</think> b <tool_call>x</tool_call> c']);
    expect(out).toBe('a  b  c');
  });

  it('preserves the earliest tag when <tool_call> precedes <think> in one buffer', () => {
    const { out } = pump(['a <tool_call>x</tool_call> b <think>t</think> c']);
    expect(out).toBe('a  b  c');
  });
});

describe('consumeStreamChunk — partial-opener buffering', () => {
  it('does not leak a partial opener that could still grow into a real tag', () => {
    const state = createStreamStrippingState();
    // "<th" matches the prefix of "<think" — must be held back until we
    // know whether it grows into the suppressed tag or resolves into
    // ordinary prose.
    const emitted = consumeStreamChunk(state, 'prefix <th');
    expect(emitted).toBe('prefix ');
    expect(state.buffer).toBe('<th');
  });

  it('resolves a held-back partial opener as ordinary prose on flush when it never grew', () => {
    const state = createStreamStrippingState();
    consumeStreamChunk(state, 'prefix <th');
    // The stream ends without ever completing <think>; flush should
    // release the buffered bytes (otherwise the last 3 chars would
    // be silently dropped, the bug flushStreamChunkBuffer fixes).
    const tail = flushStreamChunkBuffer(state);
    expect(tail).toBe('<th');
  });

  it('emits a stray `<` immediately when it cannot grow into a suppressed tag', () => {
    const { out } = pump(['a < b']);
    // `< b` cannot become `<tool_call` or `<think`, so nothing is buffered.
    expect(out).toBe('a < b');
  });

  it('completes a partial opener once the rest of the tag arrives', () => {
    const { out } = pump(['x <thi', 'nk>secret</think> y']);
    expect(out).toBe('x  y');
  });
});

describe('consumeStreamChunk — close-tag prefix held across chunks', () => {
  it('preserves post-close visible content when the close tag splits across chunks', () => {
    // Regression: pre-fix the close-not-found branch unconditionally
    // dropped the buffer, which silently ate `nk> visible` because the
    // `</thi` prefix was held in the suppressed branch's buffer, then
    // wiped, and `nk> visible` arrived after the suppression should
    // have ended.
    const { out } = pump(['pre <think>hidden</thi', 'nk> visible']);
    expect(out).toBe('pre  visible');
  });

  it('preserves post-close visible content for </tool_call> split across chunks', () => {
    const { out } = pump(['pre <tool_call>x</tool_ca', 'll> visible']);
    expect(out).toBe('pre  visible');
  });

  it('handles a multi-byte close tag split across more than two chunks', () => {
    const { out } = pump(['<think>h</', 'thi', 'nk> ok']);
    expect(out).toBe(' ok');
  });
});

describe('flushStreamChunkBuffer — end-of-stream semantics', () => {
  it('returns and clears any pending non-suppressed buffer', () => {
    const state = createStreamStrippingState();
    consumeStreamChunk(state, 'tail<th');
    expect(flushStreamChunkBuffer(state)).toBe('<th');
    expect(state.buffer).toBe('');
  });

  it('discards the buffer when the stream ended mid-suppressed-block', () => {
    const state = createStreamStrippingState();
    consumeStreamChunk(state, 'pre <think>hidden-but-no-close');
    expect(flushStreamChunkBuffer(state)).toBe('');
    expect(state.buffer).toBe('');
  });
});
