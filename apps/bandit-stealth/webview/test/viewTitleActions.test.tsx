/**
 * Title-bar actions end to end inside <App/>: the host forwards a
 * `viewAction` (from VS Code's view/title buttons) and the webview
 * switches page, reports what it shows via `viewTitle`, and drops its own
 * toolbar when the host provides native title-bar actions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BanditProvider } from '@burtson-labs/agent-ui';
import { App } from '../src/App';
import { mockPostMessage, mockReceiveMessage, type PostMessageRecorder } from './_helpers';

let recorder: PostMessageRecorder;

/** A signed-in Bandit-cloud state, as the host sends it (Acme sample data). */
const banditState = () => ({
  messages: [],
  hasApiKey: true,
  hasStoredApiKey: true,
  requiresApiKey: false,
  isBusy: false,
  provider: 'bandit',
  model: 'bandit-core-1',
  mode: 'agent',
  history: [],
  hasArchivedConversations: false,
  showHistory: false,
  allowImageUploads: true,
  showIntentChips: false,
  feedbackEnabled: false,
  contextUsage: null,
  accountProfile: { valid: true, firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@acme.example' }
});

function setBootConfig(config: Record<string, unknown> | null): void {
  document.getElementById('bandit-stealth-config')?.remove();
  if (!config) {return;}
  const script = document.createElement('script');
  script.id = 'bandit-stealth-config';
  script.type = 'application/json';
  script.textContent = JSON.stringify(config);
  document.body.appendChild(script);
}

function mount(): void {
  render(
    <BanditProvider context="vscode">
      <App />
    </BanditProvider>
  );
}

const viewTitles = () =>
  recorder.calls
    .filter((m): m is { type: 'viewTitle'; title: string } => (m as { type?: string }).type === 'viewTitle')
    .map((m) => m.title);

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
  setBootConfig(null);
});

describe('with native title-bar actions', () => {
  beforeEach(() => {
    setBootConfig({ nativeTitleActions: true });
    mount();
  });

  it('renders no in-webview toolbar', () => {
    expect(screen.queryByRole('toolbar', { name: 'Bandit Stealth' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conversation history' })).toBeNull();
  });

  it('opens and closes settings on toggleSettings and reports the title', async () => {
    mockReceiveMessage({ type: 'viewAction', action: 'toggleSettings' });
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeTruthy());
    await waitFor(() => expect(viewTitles().at(-1)).toBe('Settings'));

    mockReceiveMessage({ type: 'viewAction', action: 'toggleSettings' });
    await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Settings sections' })).toBeNull());
    await waitFor(() => expect(viewTitles().at(-1)).toBe('New conversation'));
  });

  it('asks the host for history when History is pressed from settings', async () => {
    mockReceiveMessage({ type: 'viewAction', action: 'toggleSettings' });
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeTruthy());
    recorder.reset();
    mockReceiveMessage({ type: 'viewAction', action: 'toggleHistory' });
    await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Settings sections' })).toBeNull());
    expect(recorder.calls).toContainEqual({ type: 'showHistory', value: true });
  });

  it('starts a new conversation from settings', async () => {
    mockReceiveMessage({ type: 'viewAction', action: 'toggleSettings' });
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeTruthy());
    recorder.reset();
    mockReceiveMessage({ type: 'viewAction', action: 'newConversation' });
    await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Settings sections' })).toBeNull());
    expect(recorder.calls).toContainEqual({ type: 'startNewConversation' });
  });

  it('opens Settings → Account on the host openSettings push', async () => {
    mockReceiveMessage({ type: 'state', state: banditState() });
    mockReceiveMessage({ type: 'openSettings' });
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeTruthy());
    const selected = screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toBe('Account');
  });
});

describe('without native title-bar actions', () => {
  it('renders the compact in-webview toolbar', () => {
    setBootConfig(null);
    mount();
    expect(screen.getByRole('toolbar', { name: 'Bandit Stealth' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });
});
