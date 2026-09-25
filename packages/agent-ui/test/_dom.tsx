import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

// React only flushes updates inside act() when it knows it's a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

export const mount = (ui: React.ReactElement): HTMLElement => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
};

export const rerender = (ui: React.ReactElement): void => {
  act(() => root!.render(ui));
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

export const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

export const key = (el: Element, k: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

export const buttonNamed = (scope: Element, name: string): HTMLButtonElement => {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.includes(name));
  if (!found) throw new Error(`no button "${name}"`);
  return found;
};
