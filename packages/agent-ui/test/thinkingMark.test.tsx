/**
 * The Bandit mark as the chat's activity indicator, in both renderers: the
 * React component and the HTML string the VS Code webview splices into its
 * rendered markdown (and then sanitizes with DOMPurify, which must keep it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import DOMPurify from 'dompurify';
import {
  BanditThinkingDots,
  BanditThinkingMark,
  banditStatusLineHtml,
  banditThinkingLabel,
  statusPhraseState,
  usePrefersReducedMotion
} from '../src/components/BanditThinkingMark';
import { REMOTE_CONTENT_TAGS } from '../src/components/MarkdownMessage';
import { mount } from './_dom';

// The webview's sanitizer config (apps/bandit-stealth/webview/src/App.tsx).
const WEBVIEW_PURIFY = {
  ADD_ATTR: ['aria-hidden', 'data-workspace-link'],
  FORBID_TAGS: REMOTE_CONTENT_TAGS
};

const parse = (html: string): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('BanditThinkingMark (React)', () => {
  it('is decorative, carries its state, and rides currentColor', () => {
    const host = mount(<BanditThinkingMark state="tool" size={24} />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('data-state')).toBe('tool');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('fill')).toBeNull();
    expect(svg.querySelector('path.bm-hood')!.getAttribute('fill-rule')).toBe('evenodd');
    expect(svg.querySelector('.bm-lid .bm-eyes path')).not.toBeNull();
    expect(svg.querySelector('polygon.bm-band')).not.toBeNull();
  });

  it('gives each instance its own clip path', () => {
    const host = mount(
      <>
        <BanditThinkingMark />
        <BanditThinkingMark state="streaming" />
      </>
    );
    const ids = Array.from(host.querySelectorAll('clipPath')).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('renders the dots, or a plain ellipsis under reduced motion', () => {
    const moving = mount(<BanditThinkingDots reduced={false} />);
    expect(moving.querySelectorAll('.bandit-thinking-dots i')).toHaveLength(3);
    expect(moving.querySelector('.bandit-thinking-ellipsis')!.textContent).toBe('…');
    const still = mount(<BanditThinkingDots reduced />);
    expect(still.querySelector('.bandit-thinking-dots')).toBeNull();
    expect(still.querySelector('.bandit-thinking-ellipsis')!.textContent).toBe('…');
  });

  it('usePrefersReducedMotion follows the media query', () => {
    let matches = true;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        get matches() {
          return matches;
        },
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) =>
          listeners.delete(fn)
      }))
    });
    const Probe = () => <output>{usePrefersReducedMotion() ? 'static' : 'motion'}</output>;
    const host = mount(<Probe />);
    expect(host.textContent).toBe('static');
    act(() => {
      matches = false;
      listeners.forEach((fn) => fn({ matches: false }));
    });
    expect(host.textContent).toBe('motion');
  });
});

describe('status phrases', () => {
  it('map to the mark state and the accessible name', () => {
    expect(statusPhraseState('pondering…')).toBe('thinking');
    expect(statusPhraseState('generating tool call · 3s')).toBe('tool');
    expect(statusPhraseState('streaming response…')).toBe('streaming');
    expect(banditThinkingLabel('thinking')).toBe('Bandit is thinking');
    expect(banditThinkingLabel('tool')).toBe('Running a tool');
    expect(banditThinkingLabel('tool', 'bash')).toBe('Running bash');
    expect(banditThinkingLabel('streaming')).toBe('Writing');
  });
});

describe('banditStatusLineHtml (webview)', () => {
  it('leads with the mark, splits the phrase into letters, and ends it with the dots', () => {
    const host = parse(banditStatusLineHtml('pondering…'));
    const line = host.querySelector('.bandit-status-line')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('aria-label')).toBe('Bandit is thinking');
    expect(line.getAttribute('data-state')).toBe('thinking');
    expect(line.firstElementChild!.classList.contains('bandit-thinking-mark')).toBe(true);
    expect(line.firstElementChild!.getAttribute('data-state')).toBe('thinking');
    expect(line.querySelector('.bandit-status-spark')).toBeNull();
    const text = line.querySelector('.bandit-status-text')!;
    expect(text.getAttribute('aria-hidden')).toBe('true');
    const letters = Array.from(text.querySelectorAll('.bandit-status-char')).map((c) => c.textContent);
    expect(letters.join('')).toBe('pondering');
    expect(text.querySelectorAll('.bandit-thinking-dots i')).toHaveLength(3);
    expect(text.querySelector('.bandit-thinking-ellipsis')!.textContent).toBe('…');
  });

  it('names the tool and the writing state', () => {
    expect(parse(banditStatusLineHtml('generating tool call · 3s')).firstElementChild!.getAttribute('aria-label')).toBe(
      'Running a tool'
    );
    expect(parse(banditStatusLineHtml('running bash…')).firstElementChild!.getAttribute('aria-label')).toBe(
      'Running bash'
    );
    const streaming = parse(banditStatusLineHtml('streaming response...')).firstElementChild!;
    expect(streaming.getAttribute('aria-label')).toBe('Writing');
    expect(streaming.querySelector('svg')!.getAttribute('data-state')).toBe('streaming');
  });

  it('renders an entity-bearing phrase flat rather than split mid-entity', () => {
    const text = parse(banditStatusLineHtml('this &amp; that…')).querySelector('.bandit-status-text')!;
    expect(text.querySelectorAll('.bandit-status-char')).toHaveLength(0);
    expect(text.textContent!.startsWith('this & that')).toBe(true);
  });

  it('gives each line its own clip path id', () => {
    const a = parse(banditStatusLineHtml('a…')).querySelector('clipPath')!.id;
    const b = parse(banditStatusLineHtml('b…')).querySelector('clipPath')!.id;
    expect(a).not.toBe(b);
  });

  it("survives the webview's sanitizer with its role, name, state and mark intact", () => {
    const clean = DOMPurify.sanitize(banditStatusLineHtml('generating tool call…'), WEBVIEW_PURIFY);
    const line = parse(clean).querySelector('.bandit-status-line')!;
    expect(line).not.toBeNull();
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('aria-label')).toBe('Running a tool');
    expect(line.getAttribute('data-state')).toBe('tool');
    const svg = line.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('data-state')).toBe('tool');
    expect(svg.querySelector('.bm-hood')).not.toBeNull();
    expect(svg.querySelector('.bm-eyes')).not.toBeNull();
    expect(svg.querySelector('.bm-band')).not.toBeNull();
    expect(line.querySelector('.bandit-status-text')!.getAttribute('aria-hidden')).toBe('true');
    expect(line.querySelectorAll('.bandit-thinking-dots i')).toHaveLength(3);
  });
});
