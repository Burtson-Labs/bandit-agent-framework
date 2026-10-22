/**
 * Sending while the agent works: the message queues, the queue runs in
 * order one turn at a time, and Stop or a turn that does not finish puts
 * what is left back for the composer instead of sending or losing it.
 * Same rules as the CLI's lineQueue and the desktop IDE's messageQueue.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  draftWithQueued,
  useMessageQueue,
  type MessageQueue,
  type QueueTurnOutcome,
  type QueuedMessage
} from '../src/hooks/useMessageQueue';
import { ChatComposer } from '../src/components/ChatComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Msg = { text: string; images?: string[]; files?: string[] };

/** A chat whose turns end when the test says so. */
function fakeChat() {
  const sent: Msg[] = [];
  const pending: Array<(outcome: QueueTurnOutcome) => void> = [];
  let setStreaming: (v: boolean) => void = () => {};
  const send = vi.fn((message: Msg) => {
    sent.push(message);
    // The host's busy flag arrives later than the send (a round trip).
    return new Promise<QueueTurnOutcome>((resolve) => {
      pending.push((outcome) => {
        setStreaming(false);
        resolve(outcome);
      });
    });
  });
  return {
    sent,
    send,
    bind: (fn: (v: boolean) => void) => {
      setStreaming = fn;
    },
    setStreaming: (v: boolean) => act(() => setStreaming(v)),
    /** End the oldest running turn. */
    end: async (outcome: QueueTurnOutcome = 'done') => {
      const finish = pending.shift();
      expect(finish).toBeDefined();
      await act(async () => {
        finish!(outcome);
        await Promise.resolve();
      });
    },
    running: () => pending.length
  };
}

function mount(chat: ReturnType<typeof fakeChat>, onHalted = vi.fn()) {
  const api: { queue?: MessageQueue<Msg> } = {};
  function Harness() {
    const [isStreaming, setIsStreaming] = useState(false);
    chat.bind(setIsStreaming);
    api.queue = useMessageQueue<Msg>({ isStreaming, send: chat.send, onHalted });
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
  return { api, onHalted };
}

describe('useMessageQueue', () => {
  it('sends at once when idle and queues while a turn runs', () => {
    const chat = fakeChat();
    const { api } = mount(chat);
    let first: string | undefined;
    act(() => {
      first = api.queue!.submit({ text: 'add a test' });
    });
    expect(first).toBe('sent');
    let second: string | undefined;
    act(() => {
      second = api.queue!.submit({ text: 'then run it' });
    });
    expect(second).toBe('queued');
    expect(api.queue!.items.map((i) => i.text)).toEqual(['then run it']);
    expect(chat.sent.map((s) => s.text)).toEqual(['add a test']);
  });

  it('queues behind a turn it did not start (isStreaming)', () => {
    const chat = fakeChat();
    const { api } = mount(chat);
    chat.setStreaming(true);
    act(() => {
      expect(api.queue!.submit({ text: 'after the remote turn' })).toBe('queued');
    });
    expect(chat.sent).toHaveLength(0);
    chat.setStreaming(false);
    expect(chat.sent.map((s) => s.text)).toEqual(['after the remote turn']);
  });

  it('runs queued messages in order, one turn at a time, even before the host reports busy', async () => {
    const chat = fakeChat();
    const { api } = mount(chat);
    act(() => {
      api.queue!.submit({ text: 'first' });
      api.queue!.submit({ text: 'second' });
      api.queue!.submit({ text: 'third' });
    });
    expect(chat.running()).toBe(1);
    await chat.end();
    expect(chat.sent.map((s) => s.text)).toEqual(['first', 'second']);
    expect(chat.running()).toBe(1);
    await chat.end();
    await chat.end();
    expect(chat.sent.map((s) => s.text)).toEqual(['first', 'second', 'third']);
    expect(api.queue!.items).toEqual([]);
  });

  it('keeps the host fields with their message and drops the queue id', async () => {
    const chat = fakeChat();
    const { api } = mount(chat);
    act(() => {
      api.queue!.submit({ text: 'first' });
      api.queue!.submit({ text: 'look at this', images: ['data:image/png;base64,AAA'], files: ['src/a.ts'] });
    });
    await chat.end();
    expect(chat.sent[1]).toEqual({ text: 'look at this', images: ['data:image/png;base64,AAA'], files: ['src/a.ts'] });
  });

  it.each(['failed', 'cancelled', 'refused'] as const)('stops after a %s turn and hands the rest back', async (outcome) => {
    const chat = fakeChat();
    const { api, onHalted } = mount(chat);
    act(() => {
      api.queue!.submit({ text: 'first' });
      api.queue!.submit({ text: 'second' });
      api.queue!.submit({ text: 'third' });
    });
    await chat.end(outcome);
    expect(chat.sent.map((s) => s.text)).toEqual(['first']);
    expect(onHalted).toHaveBeenCalledTimes(1);
    const [back, why] = onHalted.mock.calls[0] as [QueuedMessage<Msg>[], QueueTurnOutcome];
    expect(back.map((i) => i.text)).toEqual(['second', 'third']);
    expect(why).toBe(outcome);
    expect(api.queue!.items).toEqual([]);
  });

  it('treats a send that throws or rejects as failed', async () => {
    const onHalted = vi.fn();
    const api: { queue?: MessageQueue<Msg> } = {};
    let reject: (e: Error) => void = () => {};
    const send = vi.fn(() => new Promise<QueueTurnOutcome>((_, r) => { reject = r; }));
    function Harness() {
      api.queue = useMessageQueue<Msg>({ isStreaming: false, send, onHalted });
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    act(() => {
      api.queue!.submit({ text: 'first' });
      api.queue!.submit({ text: 'second' });
    });
    await act(async () => {
      reject(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(onHalted.mock.calls[0][1]).toBe('failed');
  });

  it('takeAll (Stop) empties the queue so nothing runs after the turn', async () => {
    const chat = fakeChat();
    const { api, onHalted } = mount(chat);
    act(() => {
      api.queue!.submit({ text: 'first' });
      api.queue!.submit({ text: 'second' });
    });
    let back: QueuedMessage<Msg>[] = [];
    act(() => {
      back = api.queue!.takeAll();
    });
    expect(back.map((i) => i.text)).toEqual(['second']);
    await chat.end('cancelled');
    expect(chat.sent).toHaveLength(1);
    expect(onHalted).not.toHaveBeenCalled();
  });

  it('take and remove change only the message they name', async () => {
    const chat = fakeChat();
    const { api } = mount(chat);
    act(() => {
      api.queue!.submit({ text: 'running' });
      api.queue!.submit({ text: 'a' });
      api.queue!.submit({ text: 'b' });
      api.queue!.submit({ text: 'c' });
    });
    const [a, b] = api.queue!.items;
    let taken: QueuedMessage<Msg> | undefined;
    act(() => {
      taken = api.queue!.take(b.id);
      api.queue!.remove(a.id);
    });
    expect(taken?.text).toBe('b');
    expect(api.queue!.items.map((i) => i.text)).toEqual(['c']);
    await chat.end();
    expect(chat.sent.map((s) => s.text)).toEqual(['running', 'c']);
  });

  it('restore with a running turn waits for it, then runs the saved messages', async () => {
    const chat = fakeChat();
    const { api } = mount(chat);
    let finish: (o: QueueTurnOutcome) => void = () => {};
    const running = new Promise<QueueTurnOutcome>((resolve) => { finish = resolve; });
    act(() => {
      api.queue!.restore([{ id: 'q1', text: 'saved one' }, { id: 'q2', text: 'saved two' }], running);
    });
    expect(chat.sent).toHaveLength(0);
    act(() => {
      expect(api.queue!.submit({ text: 'typed after reload' })).toBe('queued');
    });
    await act(async () => {
      finish('done');
      await Promise.resolve();
    });
    expect(chat.sent.map((s) => s.text)).toEqual(['saved one']);
    await chat.end();
    await chat.end();
    expect(chat.sent.map((s) => s.text)).toEqual(['saved one', 'saved two', 'typed after reload']);
  });

  it('restore with a running turn that fails hands the saved messages back', async () => {
    const chat = fakeChat();
    const { api, onHalted } = mount(chat);
    let finish: (o: QueueTurnOutcome) => void = () => {};
    const running = new Promise<QueueTurnOutcome>((resolve) => { finish = resolve; });
    act(() => {
      api.queue!.restore([{ id: 'q1', text: 'saved one' }], running);
    });
    await act(async () => {
      finish('failed');
      await Promise.resolve();
    });
    expect(chat.sent).toHaveLength(0);
    expect((onHalted.mock.calls[0][0] as QueuedMessage<Msg>[]).map((i) => i.text)).toEqual(['saved one']);
  });
});

describe('draftWithQueued', () => {
  it('puts messages after what is typed, one paragraph each', () => {
    const items = [{ text: 'first' }, { text: ' second ' }];
    expect(draftWithQueued('', items)).toBe('first\n\nsecond');
    expect(draftWithQueued('half typed', items)).toBe('half typed\n\nfirst\n\nsecond');
  });
});

describe('ChatComposer queued pills', () => {
  const render = (props: Partial<React.ComponentProps<typeof ChatComposer>> = {}) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <ChatComposer
          value=""
          onChange={() => undefined}
          onSubmit={() => undefined}
          isStreaming
          allowQueueWhileStreaming
          queuedItems={[
            { id: 'a', preview: 'add a test' },
            { id: 'b', preview: 'look at this', imageCount: 1 }
          ]}
          {...props}
        />
      )
    );
  };

  it('edits and removes the message they belong to', () => {
    const onEditQueued = vi.fn();
    const onCancelQueued = vi.fn();
    render({ onEditQueued, onCancelQueued });
    const edits = host!.querySelectorAll<HTMLButtonElement>('[aria-label="Edit this queued message"]');
    const cancels = host!.querySelectorAll<HTMLButtonElement>('[aria-label="Cancel this queued message"]');
    expect(edits).toHaveLength(2);
    act(() => edits[1].click());
    act(() => cancels[0].click());
    expect(onEditQueued).toHaveBeenCalledWith('b');
    expect(onCancelQueued).toHaveBeenCalledWith('a');
  });

  it('shows no edit button without onEditQueued', () => {
    render({ onCancelQueued: vi.fn() });
    expect(host!.querySelector('[aria-label="Edit this queued message"]')).toBeNull();
    expect(host!.querySelectorAll('[aria-label="Cancel this queued message"]')).toHaveLength(2);
  });
});
