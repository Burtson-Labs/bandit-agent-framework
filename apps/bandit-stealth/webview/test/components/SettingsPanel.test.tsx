/**
 * Settings navigation: the section switcher is a labelled WAI-ARIA tab
 * list (it was six unlabelled icons), driven by click and by the arrow,
 * Home and End keys.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { SettingsPanel, SETTINGS_TABS, type SettingsTab } from '../../src/components/SettingsPanel';

type Props = ComponentProps<typeof SettingsPanel>;

const noop = () => undefined;

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    activeTab: 'account',
    onSelectTab: noop,
    onClose: noop,
    accountProfile: {
      valid: true,
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex.rivera@acme.example',
      plan: 'Pro',
      credits: 1200,
      maskedKey: 'bai_****acme01',
      isAdmin: true
    },
    accountProfileStatus: 'idle',
    accountProfileError: null,
    onRefreshAccountProfile: noop,
    onOpenUsage: noop,
    apiKeyDraft: '',
    apiKeyInputType: 'text',
    apiKeyInputValue: 'bai_****acme01',
    onApiKeyChange: noop,
    onApiKeyFocus: noop,
    onSaveApiKey: noop,
    onClearApiKey: noop,
    onSignInWithBurtson: noop,
    hasStoredApiKey: true,
    maskStoredKey: true,
    setMaskStoredKey: noop,
    ollamaBaseUrlDraft: 'http://localhost:11434',
    onOllamaBaseUrlChange: noop,
    onSaveOllamaBaseUrl: noop,
    onResetOllamaBaseUrl: noop,
    ollamaAuthDraft: '',
    onOllamaAuthChange: noop,
    onSaveOllamaAuth: noop,
    onClearOllamaAuth: noop,
    hasOllamaAuthToken: false,
    extensionVersion: '1.7.452',
    providerKind: 'bandit',
    onSelectProvider: noop,
    onOpenSettings: noop,
    themePreference: 'auto',
    themeOptions: [{ id: 'auto', label: 'IDE Sync' }],
    onSelectTheme: noop,
    themeStatusLabel: 'Syncing with VS Code.',
    planArtifactsEnabled: true,
    onTogglePlanArtifacts: noop,
    feedbackPromptEnabled: false,
    onToggleFeedback: noop,
    developerMode: false,
    skipValidationInDev: false,
    onToggleSkipValidationInDev: noop,
    toolUseEnabled: true,
    onToggleToolUse: noop,
    createBranchBeforeRun: false,
    onToggleCreateBranchBeforeRun: noop,
    voiceAutoSpeakPref: false,
    voiceMicPref: false,
    onToggleVoiceAutoSpeak: noop,
    onToggleVoiceMic: noop,
    voiceProviderSettings: {
      sttProvider: 'bandit',
      sttUrl: '',
      sttApiKey: '',
      sttModel: '',
      ttsProvider: 'bandit',
      ttsUrl: '',
      ttsApiKey: '',
      ttsModel: '',
      ttsVoiceId: ''
    },
    onUpdateVoiceProviderSetting: noop,
    requireKey: false,
    mcpSnapshot: [],
    onMcpReload: noop,
    onMcpReconnect: noop,
    onMcpDisconnect: noop,
    onMcpRevokeTrust: noop,
    onMcpToggleActivation: noop,
    onMcpAddGitHub: noop,
    onMcpAddSlack: noop,
    onMcpAddGitLab: noop,
    onMcpAddCustom: noop,
    tavilyKeyDraft: '',
    onTavilyKeyChange: noop,
    onSaveTavilyKey: noop,
    onClearTavilyKey: noop,
    hasTavilyKey: false,
    ...overrides
  };
}

/** Owns activeTab like App does, so selection actually moves. */
function Harness(props: { initial?: SettingsTab; providerKind?: Props['providerKind']; onClose?: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(props.initial ?? 'account');
  return (
    <SettingsPanel
      {...baseProps({ providerKind: props.providerKind ?? 'bandit', onClose: props.onClose ?? noop })}
      activeTab={tab}
      onSelectTab={setTab}
    />
  );
}

afterEach(() => cleanup());

describe('settings section switcher', () => {
  it('shows every section as a tab with a visible text label', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(SETTINGS_TABS.map((t) => t.label));
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeTruthy();
  });

  it('marks exactly one tab selected and links it to the panel', () => {
    render(<Harness initial="voice" />);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe('Voice');
    expect(selected[0].getAttribute('tabindex')).toBe('0');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(selected[0].id);
  });

  it('switches section on click', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
  });

  it('moves with the arrow keys, wrapping at both ends, and Home/End', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist');
    const selectedLabel = () =>
      screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(selectedLabel()).toBe('Providers');
    expect(document.activeElement?.textContent).toBe('Providers');

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(selectedLabel()).toBe('Appearance');

    fireEvent.keyDown(list, { key: 'Home' });
    expect(selectedLabel()).toBe('Account');
    fireEvent.keyDown(list, { key: 'End' });
    expect(selectedLabel()).toBe('Appearance');
  });

  it('hides the Account tab when the provider is not Bandit', () => {
    render(<Harness initial="providers" providerKind="ollama" />);
    const labels = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(labels).not.toContain('Account');
    expect(labels[0]).toBe('Providers');
  });

  it('has a labelled back button that closes settings', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses sentence case: no upper-cased heading text in the markup', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Settings');
    expect(screen.getByText('Bandit Stealth 1.7.452 · Burtson Labs')).toBeTruthy();
  });
});
