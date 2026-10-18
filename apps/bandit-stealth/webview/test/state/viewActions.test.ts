import { describe, expect, it, vi } from 'vitest';
import {
  applyViewAction,
  isViewAction,
  viewTitleFor,
  type ViewActionEffects,
  type ViewSurface
} from '../../src/state/viewActions';

const effects = (): ViewActionEffects & Record<string, ReturnType<typeof vi.fn>> => ({
  showSettings: vi.fn(),
  hideSettings: vi.fn(),
  setHistoryVisible: vi.fn(),
  closeTracePanel: vi.fn(),
  openTracePanel: vi.fn(),
  startNewConversation: vi.fn()
});

const chat: ViewSurface = { page: 'workspace', showHistory: false, tracePanelOpen: false };
const settings: ViewSurface = { page: 'settings', showHistory: false, tracePanelOpen: false };
const history: ViewSurface = { page: 'workspace', showHistory: true, tracePanelOpen: false };
const trace: ViewSurface = { page: 'workspace', showHistory: false, tracePanelOpen: true };

describe('isViewAction', () => {
  it('accepts the five title-bar actions and nothing else', () => {
    for (const a of ['newConversation', 'toggleHistory', 'toggleSettings', 'openSettings', 'openTraceLogs']) {
      expect(isViewAction(a)).toBe(true);
    }
    expect(isViewAction('runVscodeCommand')).toBe(false);
    expect(isViewAction(undefined)).toBe(false);
    expect(isViewAction(42)).toBe(false);
  });
});

describe('applyViewAction', () => {
  it('toggleSettings opens settings from the conversation and closes it again', () => {
    const fx = effects();
    applyViewAction('toggleSettings', chat, fx);
    expect(fx.showSettings).toHaveBeenCalledTimes(1);
    const fx2 = effects();
    applyViewAction('toggleSettings', settings, fx2);
    expect(fx2.hideSettings).toHaveBeenCalledTimes(1);
    expect(fx2.showSettings).not.toHaveBeenCalled();
  });

  it('openSettings never closes settings (the Set API Key command)', () => {
    const fx = effects();
    applyViewAction('openSettings', settings, fx);
    expect(fx.showSettings).toHaveBeenCalledTimes(1);
    expect(fx.hideSettings).not.toHaveBeenCalled();
  });

  it('settings from history hides history first', () => {
    const fx = effects();
    applyViewAction('toggleSettings', history, fx);
    expect(fx.setHistoryVisible).toHaveBeenCalledWith(false);
    expect(fx.showSettings).toHaveBeenCalled();
  });

  it('history from settings leaves settings and opens history', () => {
    const fx = effects();
    applyViewAction('toggleHistory', settings, fx);
    expect(fx.hideSettings).toHaveBeenCalled();
    expect(fx.setHistoryVisible).toHaveBeenCalledWith(true);
  });

  it('history toggles from the conversation', () => {
    const open = effects();
    applyViewAction('toggleHistory', chat, open);
    expect(open.setHistoryVisible).toHaveBeenCalledWith(true);
    const close = effects();
    applyViewAction('toggleHistory', history, close);
    expect(close.setHistoryVisible).toHaveBeenCalledWith(false);
  });

  it('new conversation works from any page and closes what is open', () => {
    for (const surface of [chat, settings, history, trace]) {
      const fx = effects();
      applyViewAction('newConversation', surface, fx);
      expect(fx.startNewConversation).toHaveBeenCalledTimes(1);
      expect(fx.hideSettings).toHaveBeenCalledTimes(surface.page === 'settings' ? 1 : 0);
      expect(fx.closeTracePanel).toHaveBeenCalledTimes(surface.tracePanelOpen ? 1 : 0);
      if (surface.showHistory) {
        expect(fx.setHistoryVisible).toHaveBeenCalledWith(false);
      }
    }
  });

  it('trace logs toggle, leaving settings when needed', () => {
    const open = effects();
    applyViewAction('openTraceLogs', settings, open);
    expect(open.hideSettings).toHaveBeenCalled();
    expect(open.openTracePanel).toHaveBeenCalled();
    const close = effects();
    applyViewAction('openTraceLogs', trace, close);
    expect(close.closeTracePanel).toHaveBeenCalled();
    expect(close.openTracePanel).not.toHaveBeenCalled();
  });
});

describe('viewTitleFor', () => {
  const base = { page: 'workspace' as const, showHistory: false, tracePanelOpen: false, activeView: 'conversation' as const };
  it('uses sentence case, never upper case', () => {
    expect(viewTitleFor({ ...base, page: 'settings' })).toBe('Settings');
    expect(viewTitleFor({ ...base, tracePanelOpen: true })).toBe('Trace logs');
    expect(viewTitleFor({ ...base, showHistory: true })).toBe('History');
    expect(viewTitleFor({ ...base, activeView: 'plan' })).toBe('Plan');
  });
  it('shows the conversation name, falling back to New conversation', () => {
    expect(viewTitleFor({ ...base, conversationName: 'Refactor Acme invoice parser' })).toBe('Refactor Acme invoice parser');
    expect(viewTitleFor({ ...base, conversationName: '  ' })).toBe('New conversation');
    expect(viewTitleFor({ ...base })).toBe('New conversation');
    expect(viewTitleFor({ ...base, conversationName: 'New Conversation' })).toBe('New conversation');
  });
});
