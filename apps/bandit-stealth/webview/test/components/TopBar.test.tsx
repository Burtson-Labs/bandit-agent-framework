/**
 * The in-webview toolbar (used only when the host has no native title-bar
 * actions) must label every icon button and must not overflow a narrow
 * side bar. happy-dom has no layout engine, so the width check budgets
 * the toolbar from the CSS it ships with; the Playwright screenshot
 * harness checks the real layout at 280/320/400px.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TopBar } from '../../src/components/TopBar';

afterEach(() => cleanup());

const css = readFileSync(path.resolve(__dirname, '../../src/styles.css'), 'utf8');

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) {throw new Error(`no rule for ${selector}`);}
  const decls: Record<string, string> = {};
  for (const line of match[1].split(';')) {
    const [prop, ...rest] = line.replace(/\/\*[\s\S]*?\*\//g, '').split(':');
    if (prop?.trim() && rest.length) {decls[prop.trim()] = rest.join(':').trim();}
  }
  return decls;
}

const px = (value: string | undefined): number => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? '');
  if (!m) {throw new Error(`expected a px value, got ${value}`);}
  return Number(m[1]);
};

const rem = (value: string): number => {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  return m ? Number(m[1]) * 16 : px(value);
};

describe('TopBar', () => {
  it('labels every icon button and gives each a tooltip', () => {
    render(<TopBar title="New conversation" activePage="workspace" showHistory={false} tracePanelOpen={false} onAction={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.getAttribute('title')).toBeTruthy();
      expect(button.hasAttribute('disabled')).toBe(false);
    }
  });

  it('shows the title in sentence case', () => {
    render(<TopBar title="Settings" activePage="settings" showHistory={false} tracePanelOpen={false} onAction={() => undefined} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('sends the matching view action for each button', () => {
    const onAction = vi.fn();
    render(<TopBar title="x" activePage="workspace" showHistory={false} tracePanelOpen={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Trace logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      'newConversation',
      'toggleHistory',
      'openTraceLogs',
      'toggleSettings'
    ]);
  });

  describe.each([280, 320, 400])('at a %ipx-wide view', (width) => {
    it('fits the four buttons beside a shrinkable title without overflow', () => {
      const shell = rule('.stealth-shell');
      const [, horizontal] = shell.padding.split(/\s+/);
      const available = width - 2 * rem(horizontal);

      const button = rule('.icon-button');
      const actions = rule('.stealth-toolbar__actions');
      const toolbar = rule('.stealth-toolbar');
      const buttonsWidth = 4 * px(button.width) + 3 * px(actions.gap);
      const titleMin = 24; // room for an ellipsis
      expect(buttonsWidth + rem(toolbar.gap) + titleMin).toBeLessThanOrEqual(available);

      // The title is the part that gives way: it shrinks and truncates,
      // the buttons never shrink or wrap.
      const title = rule('.stealth-toolbar__title');
      expect(title['min-width']).toBe('0');
      expect(title['text-overflow']).toBe('ellipsis');
      expect(title['white-space']).toBe('nowrap');
      expect(actions.flex).toBe('0 0 auto');
      expect(toolbar['flex-wrap']).toBe('nowrap');
      expect(button.flex).toBe('0 0 auto');
    });
  });
});
