import * as vscode from 'vscode';
import { API_KEY_SECRET_KEY } from '../storageKeys';

export async function testConnection(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const providerKind = configuration.get<string>('provider', 'bandit');
  const ollamaUrl =
    configuration.get<string>('ollamaBaseUrl', '') ||
    configuration.get<string>('ollamaUrl', 'http://localhost:11434') ||
    'http://localhost:11434';
  const gatewayUrl = configuration.get<string>('gatewayUrl', 'https://api.burtson.ai');

  if (providerKind === 'ollama') {
    try {
      const start = Date.now();
      const response = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const latency = Date.now() - start;
      if (response.ok) {
        const data = await response.json() as { models?: Array<{ name: string }> };
        const modelCount = data?.models?.length ?? 0;
        const model = configuration.get<string>('ollamaModel', 'gemma3:12b');
        void vscode.window.showInformationMessage(
          `Ollama connected · ${model} · ${modelCount} model(s) available · ${latency}ms`
        );
      } else {
        void vscode.window.showWarningMessage(`Ollama responded with ${response.status} at ${ollamaUrl}`);
      }
    } catch {
      void vscode.window.showErrorMessage(`Cannot reach Ollama at ${ollamaUrl} — is it running?`);
    }
  } else {
    // Bandit / Gateway provider
    const apiKey = await context.secrets.get(API_KEY_SECRET_KEY);
    if (!apiKey) {
      void vscode.window.showWarningMessage('No API key set. Use "Bandit: Set API Key" first.');
      return;
    }
    try {
      const start = Date.now();
      const response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/stealth/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000)
      });
      const latency = Date.now() - start;
      if (response.ok) {
        const model = configuration.get<string>('model', 'bandit-core-1');
        void vscode.window.showInformationMessage(`Gateway connected · ${model} · ${latency}ms`);
      } else {
        void vscode.window.showWarningMessage(`Gateway responded with ${response.status}`);
      }
    } catch {
      void vscode.window.showErrorMessage(`Cannot reach Gateway at ${gatewayUrl}`);
    }
  }
}
