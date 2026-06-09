import * as vscode from 'vscode';
import type { IncomingMessage } from '../../messages';

export interface ConfigMessageDeps {
  syncState(): Promise<void>;
}

export async function handleSetConfig(
  message: Extract<IncomingMessage, { type: 'setConfig' }>,
  deps: ConfigMessageDeps
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  if (message.key === 'agent.autoApproveEdits') {
    await configuration.update(
      'agent.autoApproveEdits',
      message.value === true,
      vscode.ConfigurationTarget.Workspace
    );
    await deps.syncState();
  }
  if (message.key === 'autoContextEnabled') {
    // Global target so the toggle sticks across workspaces — users
    // who want context attached for one repo almost always want it
    // for all of them; workspace-scoping caused "why is it back on?"
    // confusion because each new folder inherited the true default.
    await configuration.update(
      'autoContextEnabled',
      message.value !== false,
      vscode.ConfigurationTarget.Global
    );
    await deps.syncState();
  }
  if (message.key === 'voice.autoSpeak' || message.key === 'voice.micEnabled') {
    // Both voice toggles persist globally — a user who enables voice
    // once clearly wants it available for every project. Cloud-gated
    // at play-time (handleSpeakMessage checks provider+API key and
    // sends an audioError toast if either is missing), so local
    // users flipping these on just see "cloud only" feedback later.
    await configuration.update(
      message.key,
      message.value === true,
      vscode.ConfigurationTarget.Global
    );
    await deps.syncState();
  }
  // Voice provider settings — strings + enums. Persisted globally
  // so the user's STT/TTS choice carries across every workspace.
  // Validated as strings; the schema in package.json enforces the
  // enum constraints on the dropdown values.
  const VOICE_STRING_KEYS = new Set([
    'voice.stt.provider',
    'voice.stt.url',
    'voice.stt.apiKey',
    'voice.stt.model',
    'voice.tts.provider',
    'voice.tts.url',
    'voice.tts.apiKey',
    'voice.tts.model',
    'voice.voiceId'
  ]);
  if (VOICE_STRING_KEYS.has(message.key)) {
    await configuration.update(
      message.key,
      typeof message.value === 'string' ? message.value : '',
      vscode.ConfigurationTarget.Global
    );
    await deps.syncState();
  }
}

export async function handleUpdatePreference(
  message: Extract<IncomingMessage, { type: 'updatePreference' }>,
  deps: ConfigMessageDeps
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  if (message.key === 'intent.showSuggestions') {
    await configuration.update('intent.showSuggestions', message.value !== false, vscode.ConfigurationTarget.Global);
    await deps.syncState();
  }
  if (message.key === 'feedback.enabled') {
    await configuration.update('feedback.enabled', message.value !== false, vscode.ConfigurationTarget.Global);
    await deps.syncState();
  }
  if (message.key === 'debug.emitPlanJson') {
    await configuration.update('debug.emitPlanJson', message.value !== false, vscode.ConfigurationTarget.Workspace);
    await deps.syncState();
  }
  if (message.key === 'agent.skipValidationInDev') {
    await configuration.update('agent.skipValidationInDev', message.value === true, vscode.ConfigurationTarget.Global);
    await deps.syncState();
  }
  if (message.key === 'enableToolUse') {
    await configuration.update('enableToolUse', message.value === true, vscode.ConfigurationTarget.Workspace);
    await deps.syncState();
  }
  if (message.key === 'agent.createBranchBeforeRun') {
    await configuration.update('agent.createBranchBeforeRun', message.value === true, vscode.ConfigurationTarget.Workspace);
    await deps.syncState();
  }
}

export async function handleSetOllamaBaseUrl(
  message: Extract<IncomingMessage, { type: 'setOllamaBaseUrl' }>,
  deps: ConfigMessageDeps
): Promise<void> {
  const trimmed = (message.value ?? '').trim();
  const config = vscode.workspace.getConfiguration('banditStealth');
  await config.update('ollamaBaseUrl', trimmed, vscode.ConfigurationTarget.Global);
  // Keep legacy alias in sync so older code paths (and the picker's
  // readiness probe) pick up the new URL without a reload.
  await config.update('ollamaUrl', trimmed, vscode.ConfigurationTarget.Global);
  await deps.syncState();
}

export async function handleEditOllamaUrl(deps: ConfigMessageDeps): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const current =
    configuration.get<string>('ollamaBaseUrl', '') ||
    configuration.get<string>('ollamaUrl', 'http://localhost:11434') ||
    'http://localhost:11434';
  const input = await vscode.window.showInputBox({
    title: 'Set Ollama URL',
    prompt: 'Enter the Ollama base URL (e.g. http://localhost:11434).',
    value: current,
    ignoreFocusOut: true
  });

  if (input && input.trim()) {
    const normalized = input.trim().replace(/\/+$/, '');
    await configuration.update('ollamaBaseUrl', normalized, vscode.ConfigurationTarget.Global);
    await configuration.update('ollamaUrl', normalized, vscode.ConfigurationTarget.Global);
    // silent — settings panel reflects the new URL.
    await deps.syncState();
  }
}

export async function handleEditModel(deps: ConfigMessageDeps): Promise<void> {
  // Delegate to banditStealth.switchModel so the composer chip and the
  // status bar share one picker. v1.5.46 made switchModel Ollama-aware
  // (/api/tags discovery, free-text fallback for remote endpoints);
  // this handler used to open a dumb InputBox, which is why clicking
  // the composer chip bypassed discovery entirely.
  await vscode.commands.executeCommand('banditStealth.switchModel');
  await deps.syncState();
}

export function handleOpenSettings(
  message: Extract<IncomingMessage, { type: 'openSettings' }>
): void {
  // Surface the VS Code settings UI filtered to a query — used by the
  // Providers settings tab to point users at `banditStealth.openai*`
  // when they pick the openai-compatible provider. Cheaper than
  // building a full inline form for the four config keys, and lands
  // the user in the canonical settings surface they already know.
  const query = typeof message.query === 'string' && message.query.length > 0
    ? message.query
    : 'banditStealth';
  void vscode.commands.executeCommand('workbench.action.openSettings', query);
}

/**
 * Topic dispatcher — returns `true` if the message belongs to the
 * config / settings cluster (and was handled), `false` otherwise.
 * Collapses 6 if-blocks in the provider's `handleMessage`.
 *
 * The provider-bound credential messages (setProvider with its API-key
 * check, setOllamaAuthToken, clearOllamaAuthToken, setTavilyKey,
 * clearTavilyKey, clearApiKey) stay inline in `handleMessage` because
 * they touch provider-class methods directly. Folding them here would
 * cost a deps-callback per call site without saving net LOC.
 */
export async function dispatchConfigMessage(
  deps: ConfigMessageDeps,
  message: IncomingMessage
): Promise<boolean> {
  switch (message.type) {
    case 'setConfig':
      await handleSetConfig(message, deps);
      return true;
    case 'updatePreference':
      await handleUpdatePreference(message, deps);
      return true;
    case 'setOllamaBaseUrl':
      await handleSetOllamaBaseUrl(message, deps);
      return true;
    case 'editOllamaUrl':
      await handleEditOllamaUrl(deps);
      return true;
    case 'editModel':
      await handleEditModel(deps);
      return true;
    case 'openSettings':
      handleOpenSettings(message);
      return true;
    default:
      return false;
  }
}
