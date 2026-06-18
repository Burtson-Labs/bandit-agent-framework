import * as vscode from 'vscode';
import {
  queryOllamaModelCapabilities,
  registerModelCapabilities,
  resolveOllamaEndpoint
} from '@burtson-labs/stealth-core-runtime';
import { API_KEY_SECRET_KEY } from '../storageKeys';

export async function switchModel(
  updateStatusBarText: () => void,
  context?: vscode.ExtensionContext
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const providerKind = configuration.get<string>('provider', 'bandit');

  if (providerKind === 'ollama') {
    // Resolve the exact URL + headers the chat engine will use so the
    // picker can never disagree with the actual inference endpoint.
    const { url: ollamaUrl, headers: extraHeaders, isNodeOverride } =
      resolveOllamaEndpoint({
        get: <T,>(section: string, defaultValue: T): T =>
          configuration.get<T>(section, defaultValue) as T
      });
    const currentModel = configuration.get<string>('ollamaModel', 'gemma3:12b') ?? '';
    const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i.test(ollamaUrl);
    const hasCustomAuth = Object.keys(extraHeaders).length > 0 || isNodeOverride || !isLocalUrl;

    type OllamaModel = { name: string; size?: number; modified_at?: string };
    type HealthState = 'healthy' | 'empty' | 'unreachable';
    let models: OllamaModel[] = [];
    let health: HealthState = 'unreachable';
    let fetchError: string | undefined;

    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        // 3-second timeout — don't hang the UI on unreachable remote endpoints.
        signal: AbortSignal.timeout(3000),
        headers: extraHeaders
      });
      if (response.ok) {
        const data = await response.json() as { models?: OllamaModel[] };
        models = Array.isArray(data?.models) ? data.models : [];
        health = models.length > 0 ? 'healthy' : 'empty';
      } else {
        fetchError = `HTTP ${response.status}`;
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    const commitModel = async (picked: string): Promise<void> => {
      const trimmed = picked.trim();
      if (!trimmed) {return;}
      await configuration.update('ollamaModel', trimmed, vscode.ConfigurationTarget.Workspace);
      updateStatusBarText();
      void vscode.window.showInformationMessage(`Model switched to ${trimmed}`);
      // Auto-detect capabilities for models not in the built-in profile list.
      void queryOllamaModelCapabilities(trimmed, ollamaUrl).then(caps => {
        if (caps) {registerModelCapabilities(trimmed, caps);}
      });
    };

    if (health === 'healthy') {
      type ModelItem = vscode.QuickPickItem & { model?: string; action?: 'manual' };
      const items: ModelItem[] = models
        .map<ModelItem>(m => ({
          label: m.name === currentModel ? `$(check) ${m.name}` : m.name,
          description: m.name === currentModel ? 'current' : undefined,
          model: m.name
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      // Manual entry always available — even on localhost. Covers the
      // "set a name before pulling" flow, OLLAMA_MODELS-pointed setups
      // where /api/tags doesn't show everything, and "skip the list
      // wait" when a remote endpoint is slow.
      items.push({
        label: '$(edit) Enter model name manually…',
        description: 'Type a model ID (works even if not yet pulled)',
        action: 'manual'
      });
      void hasCustomAuth; // retained for future per-endpoint gating hooks
      const selected = await vscode.window.showQuickPick(items, {
        title: 'Switch Ollama Model',
        placeHolder: `Current: ${currentModel} · ${ollamaUrl}`
      });
      if (!selected) {return;}
      if (selected.action === 'manual') {
        const input = await vscode.window.showInputBox({
          title: 'Enter Ollama Model',
          prompt: `Model ID on ${ollamaUrl}`,
          value: currentModel
        });
        if (!input?.trim()) {return;}
        await commitModel(input);
      } else if (selected.model) {
        await commitModel(selected.model);
      }
    } else if (health === 'empty') {
      const pullHint = 'ollama pull bandit-core:31b';
      void vscode.window.showWarningMessage(
        `Ollama is reachable at ${ollamaUrl} but no models are installed. Pull one with: ${pullHint}`
      );
      if (hasCustomAuth) {
        const input = await vscode.window.showInputBox({
          title: 'Enter Ollama Model',
          prompt: `Model ID on ${ollamaUrl}`,
          value: currentModel
        });
        if (input?.trim()) {await commitModel(input);}
      }
    } else {
      // Unreachable: split copy by local vs remote. Remote failures almost
      // always mean "my GPU node / RunPod is off right now" — let the user
      // type a model manually so a down endpoint doesn't block them.
      if (isLocalUrl) {
        void vscode.window.showErrorMessage(
          `Can't detect Ollama at ${ollamaUrl}. Check that it's running (curl ${ollamaUrl}/api/tags).`
        );
      } else {
        void vscode.window.showWarningMessage(
          `Your remote Ollama at ${ollamaUrl} isn't responding${fetchError ? ` (${fetchError})` : ''} — type a model name manually to keep working.`
        );
      }
      if (hasCustomAuth || !isLocalUrl) {
        const input = await vscode.window.showInputBox({
          title: 'Enter Ollama Model',
          prompt: `Model ID on ${ollamaUrl}`,
          value: currentModel,
          placeHolder: 'e.g. bandit-core:31b'
        });
        if (input?.trim()) {await commitModel(input);}
      }
    }
  } else {
    // Bandit AI — fetch the model catalog from the gateway so new models
    // (e.g. bandit-logic-2) appear without an extension release. Falls back to
    // a built-in list when the gateway is unreachable or no API key is set.
    // A manual-entry escape hatch always routes custom gateway aliases.
    const currentModel = configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1';
    const gatewayUrl = configuration.get<string>('gatewayUrl', 'https://api.burtson.ai');
    type BanditPick = vscode.QuickPickItem & { model?: string; action?: 'manual' };
    interface CatalogModel {
      id: string;
      displayName?: string;
      description?: string;
      available?: boolean;
      unavailableReason?: string;
    }

    // Built-in fallback, kept in sync with the gateway catalog for offline /
    // unauthenticated use. Backend-neutral copy; bandit-logic-2 reads as a Kimi variant.
    const fallbackModels: BanditPick[] = [
      { label: 'bandit-core-1', description: 'Balanced speed and quality — the default.', model: 'bandit-core-1' },
      { label: 'bandit-logic', description: 'Agentic coding specialist (Qwen 3.6 27B, native tools, multimodal).', model: 'bandit-logic' },
      { label: 'bandit-logic-2', description: 'Frontier coding model — a Kimi K2 variant (native tools, multimodal).', model: 'bandit-logic-2' }
    ];

    let banditModels: BanditPick[] = fallbackModels;
    const apiKey = await context?.secrets.get(API_KEY_SECRET_KEY);
    if (apiKey) {
      try {
        const response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/stealth/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000)
        });
        if (response.ok) {
          const data = await response.json() as { models?: CatalogModel[] };
          const fetched = (data?.models ?? [])
            .filter((m): m is CatalogModel => !!m && typeof m.id === 'string' && m.id.length > 0)
            .map<BanditPick>(m => {
              const unavailable = m.available === false
                ? `$(warning) ${m.unavailableReason ?? 'currently unavailable'}`
                : undefined;
              return {
                label: m.displayName?.trim() || m.id,
                description: [m.description?.trim(), unavailable].filter(Boolean).join(' · '),
                model: m.id
              };
            });
          if (fetched.length > 0) {
            banditModels = fetched;
          }
        }
      } catch {
        // Gateway unreachable — keep the built-in fallback list.
      }
    }

    // bandit-core and bandit-core-1 are the same upstream; treat them as equal
    // so the "current" marker still lands when the catalog id is "bandit-core".
    const sameModel = (a: string, b: string): boolean =>
      a === b || a.replace(/-1$/, '') === b.replace(/-1$/, '');
    const items: BanditPick[] = banditModels.map(m => ({
      ...m,
      description: m.model && sameModel(m.model, currentModel)
        ? `$(check) current${m.description ? ` · ${m.description}` : ''}`
        : m.description
    }));
    if (!items.some(it => !!it.model && sameModel(it.model, currentModel))) {
      items.unshift({
        label: currentModel,
        description: '$(check) current · custom gateway alias',
        model: currentModel
      });
    }
    items.push({
      label: '$(edit) Enter model name manually…',
      description: 'Route to a custom gateway alias (e.g. a cluster Ollama model)',
      action: 'manual'
    });
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Switch Bandit AI Model',
      placeHolder: `Current: ${currentModel}`
    });
    if (!selected) {return;}
    let chosen = selected.model;
    if (selected.action === 'manual') {
      const input = await vscode.window.showInputBox({
        title: 'Bandit AI Model — Custom Alias',
        prompt: 'Model name as configured on api.burtson.ai (e.g. qwen2.5-coder:32b)',
        value: currentModel,
        validateInput: value => value.trim().length === 0 ? 'Enter a non-empty model name' : undefined
      });
      chosen = input?.trim();
    }
    if (!chosen) {return;}
    await configuration.update('model', chosen, vscode.ConfigurationTarget.Workspace);
    updateStatusBarText();
  }
}
