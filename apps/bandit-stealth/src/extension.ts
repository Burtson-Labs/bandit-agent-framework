/**
 * Bandit Stealth VS Code extension entry point.
 *
 * Owns activation glue: provider construction, status bar wiring, the
 * `banditStealth.*` configuration listener that invalidates the
 * slow-state cache, the Ollama health probe on startup, and the
 * `context.subscriptions` registration of commands + view provider +
 * lifecycle disposables.
 *
 * The webview provider class itself lives in
 * ./provider/BanditStealthViewProvider.ts. Command bodies live in
 * ./commands/. See ./provider/slowStateCache.ts for the v1.7.347
 * cache, ./agent/statusIndicators.ts for the v1.7.341 status pill,
 * and ./provider/messageHandlers/ for the per-topic message handlers.
 */
import * as vscode from 'vscode';
import type {
  AgentRuntime as FrameworkAgentRuntime} from '@burtson-labs/agent-core';
import {
  type AgentEvent
} from '@burtson-labs/agent-core';
import { createVscodeAdapter } from '@burtson-labs/agent-adapters-vscode';
import {
  queryModelsDevCapabilities,
  queryOllamaModelCapabilities,
  registerModelCapabilities
} from '@burtson-labs/stealth-core-runtime';

import { StealthAgentRuntime } from './agent/agentRuntime';
import { PromptPipeline } from './agent/promptPipeline';
import { environmentService } from './agent/environmentService';
import { ensurePython } from './agent/pythonEnvironment';
import { setBundledRecorderPath } from './extensionRecorder';
import { DiffContentProvider } from './diffContentProvider';
import {
  loadWorkspaceModelBehaviorProfiles,
  clearModelBehaviorOverrides
} from './agent/modelBehaviorProfiles';
import { registerCommands } from './commands/registerCommands';
import { BanditStealthViewProvider } from './provider/BanditStealthViewProvider';

// Re-export for command files and other consumers that import the class
// by type from `./extension` — preserves the existing import surface.
export { BanditStealthViewProvider } from './provider/BanditStealthViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  // Resolve the bundled platform-specific recorder (currently macOS
  // only — bandit-mic, a tiny Swift AVFoundation binary). When present,
  // the extension's mic button records through this binary instead of
  // the webview's getUserMedia, sidestepping Chromium's per-origin
  // permission cache entirely. Linux still falls through to arecord
  // (preinstalled) and Windows to ffmpeg (probed on PATH); see
  // extensionRecorder.ts for the full probe order.
  const recorderName = process.platform === 'darwin' ? 'bandit-mic-darwin' : null;
  if (recorderName) {
    const recorderPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'recorders', recorderName).fsPath;
    setBundledRecorderPath(recorderPath);
  }

  const runtimeController = new StealthAgentRuntime(context);
  const frameworkRuntime: FrameworkAgentRuntime = runtimeController.getFrameworkRuntime();
  const adapter = createVscodeAdapter(vscode);
  adapter.activate();
  const adapterPlanListener = (event: AgentEvent) => {
    void environmentService.postToWebview({ type: 'agent:plan', payload: event.payload });
  };
  adapter.on('plan:complete', adapterPlanListener);

  const diffListener = (event: AgentEvent) => {
    void environmentService.postToWebview({ type: 'agent:diff', payload: event.payload });
  };
  frameworkRuntime.on('diff:apply', diffListener);

  const promptPipeline = new PromptPipeline(runtimeController);
  const diffContentProvider = new DiffContentProvider();
  const provider = new BanditStealthViewProvider(context, runtimeController, promptPipeline, diffContentProvider);
  loadWorkspaceModelBehaviorProfiles(false);
  const modelProfileWatcher = vscode.workspace.createFileSystemWatcher('**/.bandit/model-profiles.json');
  context.subscriptions.push(
    modelProfileWatcher,
    modelProfileWatcher.onDidCreate(() => loadWorkspaceModelBehaviorProfiles(true)),
    modelProfileWatcher.onDidChange(() => loadWorkspaceModelBehaviorProfiles(true)),
    modelProfileWatcher.onDidDelete(() => {
      clearModelBehaviorOverrides();
      void vscode.window.showInformationMessage('Bandit model behavior profile overrides cleared.');
    })
  );

  // ── Status bar item ──────────────────────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'banditStealth.switchModel';

  let lastContextBudget: { tokenEstimate: number; contextWindow: number; source: string } | undefined;

  function updateStatusBarText(busy?: boolean, statusText?: string, contextBudget?: { tokenEstimate: number; contextWindow: number; source: string }): void {
    if (contextBudget !== undefined) {
      lastContextBudget = contextBudget;
    }
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const providerKind = configuration.get<string>('provider', 'bandit');
    const isOllama = providerKind === 'ollama';
    const model = isOllama
      ? configuration.get<string>('ollamaModel', 'gemma3:12b') ?? 'gemma3:12b'
      : configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1';
    const providerLabel = isOllama ? 'Ollama' : 'Bandit AI';
    const toolUse = configuration.get<boolean>('enableToolUse', true) ? ' · tools' : '';

    // Format context budget suffix: e.g. " · $(database) 3.2k / 32k"
    let ctxSuffix = '';
    let ctxTooltipLine = '';
    if (lastContextBudget && lastContextBudget.source !== 'none') {
      const estK = (lastContextBudget.tokenEstimate / 1000).toFixed(1);
      const winK = Math.round(lastContextBudget.contextWindow / 1000);
      const srcIcon = lastContextBudget.source === 'gateway' ? '$(database)' : '$(files)';
      ctxSuffix = ` · ${srcIcon} ${estK}k / ${winK}k`;
      const srcLabel = lastContextBudget.source === 'gateway' ? 'Qdrant' : lastContextBudget.source === 'local' ? 'Local' : 'Pinned';
      ctxTooltipLine = `\nContext: ${srcLabel} · ${estK}k / ${winK}k tokens`;
    }

    if (busy) {
      const txt = statusText && statusText !== 'Ready' ? statusText : '…';
      statusBarItem.text = `$(sync~spin) Bandit · ${txt}`;
      statusBarItem.tooltip = `${providerLabel} — ${txt}`;
    } else {
      statusBarItem.text = `$(robot) Bandit · ${model}${toolUse}${ctxSuffix}`;
      statusBarItem.tooltip = `Bandit Stealth · ${providerLabel}\nModel: ${model}${toolUse}${ctxTooltipLine}\nClick to switch model`;
    }
  }

  updateStatusBarText();
  statusBarItem.show();

  // On activation, auto-detect Ollama availability and model capabilities.
  // Shows a helpful status message so users know the agent is ready.
  {
    const activationCfg = vscode.workspace.getConfiguration('banditStealth');

    // Mirror the CLI's models.dev hook: when the configured provider
    // is openai-compatible, fetch real capability metadata for the
    // active model so the output-budget gate, parallel-write
    // serialiser, and vision routing all see the right tier/context
    // instead of falling through to the conservative default. The CLI
    // has the same hook in apps/bandit-cli/src/cli.ts; both surfaces
    // share the disk cache (~/.bandit/cache/models-dev.json), so the
    // first surface to fire pays the network round-trip and the rest
    // hit a 304 within the next 24h.
    const activationProvider = (activationCfg.get<string>('provider', 'ollama') ?? '').trim().toLowerCase();
    if (activationProvider === 'openai-compatible' || activationProvider === 'openai') {
      const openaiBaseUrl = activationCfg.get<string>('openaiBaseUrl', '') ?? '';
      const openaiModel = activationCfg.get<string>('openaiModel', '') ?? '';
      if (openaiBaseUrl && openaiModel) {
        void queryModelsDevCapabilities(openaiModel, openaiBaseUrl)
          .then(caps => {
            if (caps) {registerModelCapabilities(openaiModel, caps);}
          })
          .catch(() => undefined);
      }
    }

    if (activationCfg.get<string>('provider', 'ollama') === 'ollama') {
      const baseModelId = activationCfg.get<string>('ollamaModel', 'gemma3:12b') ?? '';
      // Auto-routing ACTUALLY uses ollamaCodingModel for coding/text prompts
      // when enabled. If we only validate baseModelId, we give users a
      // false "ready" signal — then their first prompt hits an uninstalled
      // coding model and hangs silently. Gather every model that could
      // be dispatched to and verify each is pulled.
      const autoRoute = activationCfg.get<boolean>('ollamaAutoRouteModels', true) !== false;
      const codingModelId = (activationCfg.get<string>('ollamaCodingModel', '') ?? '').trim();
      const agentModelId = (activationCfg.get<string>('agentOllamaModel', '') ?? '').trim();
      const visionModelId = (activationCfg.get<string>('ollamaVisionModel', '') ?? '').trim();
      const modelsToCheck = new Set<string>();
      if (baseModelId) {modelsToCheck.add(baseModelId);}
      if (autoRoute && codingModelId) {modelsToCheck.add(codingModelId);}
      if (agentModelId) {modelsToCheck.add(agentModelId);}
      if (autoRoute && visionModelId) {modelsToCheck.add(visionModelId);}
      const activationBaseUrl =
        activationCfg.get<string>('ollamaBaseUrl', '') ||
        activationCfg.get<string>('ollamaUrl', 'http://localhost:11434') ||
        'http://localhost:11434';

      // Health check: is Ollama running? Update status bar + webview onboarding.
      void (async () => {
        try {
          const response = await fetch(`${activationBaseUrl.replace(/\/+$/, '')}/api/tags`, {
            signal: AbortSignal.timeout(3000)
          });
          if (response.ok) {
            const data = await response.json() as { models?: Array<{ name: string }> };
            const models = data?.models ?? [];
            // Match on name-prefix up to the first colon so "gemma3:12b"
            // matches "gemma3:12b-it-qat" — users frequently pull variants
            // without realizing the tag differs from the config string.
            const isInstalled = (candidate: string): boolean =>
              models.some(m => m.name === candidate || m.name.startsWith(candidate.split(':')[0] + ':') || m.name === candidate.split(':')[0]);
            const missing = Array.from(modelsToCheck).filter(m => !isInstalled(m));
            if (missing.length > 0 && models.length > 0) {
              // Flag every missing model. The first missing one owns the
              // prompt affordance (Pull Model button) since installing one
              // at a time via the terminal is the path of least resistance.
              const primary = missing[0];
              provider.setOllamaStatus('no-model', primary);
              const listed = missing.length === 1 ? `"${primary}"` : `${missing.length} models (${missing.map(m => `"${m}"`).join(', ')})`;
              void vscode.window.showWarningMessage(
                `Ollama is running but ${listed} not installed. Without these, chats will silently hang. Run: ollama pull ${primary}${missing.length > 1 ? ` (and the others)` : ''}`,
                'Pull Model',
                'Disable auto-routing'
              ).then(choice => {
                if (choice === 'Pull Model') {
                  const terminal = vscode.window.createTerminal('Ollama');
                  terminal.show();
                  terminal.sendText(`ollama pull ${primary}`);
                } else if (choice === 'Disable auto-routing') {
                  // Turning off auto-routing makes the extension use
                  // banditStealth.ollamaModel directly — the safest
                  // recovery when the coding/vision models are missing.
                  void activationCfg.update('ollamaAutoRouteModels', false, vscode.ConfigurationTarget.Global);
                }
              });
            } else {
              provider.setOllamaStatus('ready');
            }
            const caps = await queryOllamaModelCapabilities(baseModelId, activationBaseUrl);
            if (caps) {registerModelCapabilities(baseModelId, caps);}
          }
        } catch {
          provider.setOllamaStatus('offline');
          statusBarItem.text = '$(warning) Bandit · Ollama offline';
          statusBarItem.tooltip = 'Ollama is not running. Start it with: ollama serve';
        }
      })();
    }
  }

  // Update status bar AND invalidate the provider's slow-state cache
  // when any banditStealth.* setting changes — the cache holds Tavily
  // BYOK presence (resolved through env → config.json → VS Code setting)
  // and the provider/model identity used to derive `requiresApiKey`. A
  // user toggling provider or pasting a key into Settings UI should
  // show up on the next flushState, not after the streaming turn.
  const configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('banditStealth')) {
      updateStatusBarText();
      provider.invalidateSlowStateCache();
    }
  });

  // Update status bar when provider busy state changes.
  const statusChangeListener = provider.onDidChangeStatus(({ busy, text, contextBudget }) => {
    updateStatusBarText(busy, text, contextBudget);
  });

  void ensurePython().then((result) => {
    if (result.info) {
      console.info(`Bandit Stealth: detected Python ${result.info.version} via "${result.info.command}".`);
      return;
    }

    const openDocs = 'Open Python Downloads';
    const openSettings = 'Configure Python Path';

    void vscode.window.showWarningMessage(
      'Bandit Stealth agent features require Python 3. Install Python 3 or configure the `banditStealth.pythonPath` setting.',
      openDocs,
      openSettings
    ).then((choice) => {
      if (choice === openDocs) {
        void vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
      } else if (choice === openSettings) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'banditStealth.pythonPath');
      }
    });
  });

  context.subscriptions.push(
    provider,
    diffContentProvider,
    statusBarItem,
    configChangeListener,
    statusChangeListener,
    vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, diffContentProvider),
    vscode.window.registerWebviewViewProvider(BanditStealthViewProvider.viewType, provider),
    ...registerCommands(context, provider, runtimeController, updateStatusBarText),
    new vscode.Disposable(() => {
      adapter.off('plan:complete', adapterPlanListener);
      adapter.dispose();
    }),
    new vscode.Disposable(() => {
      frameworkRuntime.off('diff:apply', diffListener);
    })
  );
}

export function deactivate(): void {
  // no-op
}
