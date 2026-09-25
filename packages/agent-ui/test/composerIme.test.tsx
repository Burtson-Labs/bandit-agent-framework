import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatComposer } from '../src/components/ChatComposer';

// React only flushes updates inside act() when it knows it's a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const mount = (ui: React.ReactElement): HTMLElement => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const pressEnter = (el: Element, composing: boolean): void => {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    isComposing: composing
  });
  if (composing) Object.defineProperty(event, 'keyCode', { value: 229 });
  act(() => {
    el.dispatchEvent(event);
  });
};

describe('ChatComposer IME composition', () => {
  it('does not submit when Enter confirms an IME candidate', () => {
    const submitted: string[] = [];
    const el = mount(<ChatComposer value="日本語" onChange={() => {}} onSubmit={(v) => submitted.push(v)} />);
    pressEnter(el.querySelector('textarea')!, true);
    expect(submitted).toEqual([]);
  });

  it('still submits on an ordinary Enter', () => {
    const submitted: string[] = [];
    const el = mount(<ChatComposer value="hello" onChange={() => {}} onSubmit={(v) => submitted.push(v)} />);
    pressEnter(el.querySelector('textarea')!, false);
    expect(submitted).toEqual(['hello']);
  });

  it('does not complete a slash suggestion while composing', () => {
    const changes: string[] = [];
    const el = mount(
      <ChatComposer
        value="/te"
        onChange={(v) => changes.push(v)}
        onSubmit={() => {}}
        slashCommands={[{ name: 'test', description: 'Run tests' }]}
      />
    );
    pressEnter(el.querySelector('textarea')!, true);
    expect(changes).toEqual([]);
  });
});
