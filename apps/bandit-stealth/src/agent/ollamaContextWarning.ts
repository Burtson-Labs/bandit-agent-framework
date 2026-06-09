/**
 * `buildMaybeShowOllamaContextWarning` — once-per-provider-instance
 * Ollama-context-underweight gate.
 *
 * Probes the live Ollama server for the currently-loaded context size
 * of the active model. If Ollama loaded with significantly fewer
 * tokens than Bandit asked for (the `check.underweight` branch), shows
 * a `vscode.window.showWarningMessage` with a "Copy command" action
 * that puts a suggested `ollama` invocation on the clipboard so the
 * user can restart Ollama with the right window size.
 *
 * The gate is intentionally once-per-provider-instance, not
 * once-per-process: a `setProvider` switch (Ollama → Bandit → Ollama)
 * gets a fresh provider and a fresh warning probe. The provider's
 * `ollamaContextWarned` field is the persistent flag; the deps
 * callbacks `isAlreadyShown()` / `markShown()` let this helper read
 * and flip it without holding a reference to the provider.
 *
 * Skips immediately if the active provider isn't Ollama — the warning
 * makes no sense for Bandit cloud or OpenAI-compatible endpoints.
 *
 * The fetch chain is fire-and-forget (`void check…then…catch`) so the
 * chat-events caller doesn't block on a network probe to a possibly-
 * down Ollama server. A caught probe failure is a non-fatal UX hint
 * miss.
 */
import * as vscode from 'vscode';
import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import {
  checkOllamaLoadedContext,
  resolveOllamaEndpoint,
  resolveOllamaRuntimeOptions
} from '@burtson-labs/stealth-core-runtime';

export interface OllamaContextWarningDeps {
  isAlreadyShown: () => boolean;
  markShown: () => void;
  getProviderKind: (cfg: vscode.WorkspaceConfiguration) => ProviderKind;
  resolveOllamaBaseModel: (cfg: vscode.WorkspaceConfiguration) => string;
}

export function buildMaybeShowOllamaContextWarning(deps: OllamaContextWarningDeps): () => void {
  const { isAlreadyShown, markShown, getProviderKind, resolveOllamaBaseModel } = deps;
  return () => {
    if (isAlreadyShown()) {return;}
    const cfg = vscode.workspace.getConfiguration('banditStealth');
    if (getProviderKind(cfg) !== 'ollama') {return;}
    markShown();
    const ollamaEndpoint = resolveOllamaEndpoint(cfg);
    const activeModel = resolveOllamaBaseModel(cfg);
    const requestedCtx = resolveOllamaRuntimeOptions(activeModel).num_ctx;
    void checkOllamaLoadedContext(ollamaEndpoint.url, activeModel, requestedCtx)
      .then((check) => {
        if (check.underweight && check.loadedContext !== null) {
          void vscode.window
            .showWarningMessage(
              `Ollama loaded ${activeModel} with only ${check.loadedContext} tokens of context (Bandit asked for ${check.requestedContext}). Prompts will overflow and the agent will feel slow. Restart Ollama with a higher window: ${check.suggestionCommand}`,
              'Copy command',
              'Dismiss'
            )
            .then((choice) => {
              if (choice === 'Copy command') {
                void vscode.env.clipboard.writeText(check.suggestionCommand);
                void vscode.window.showInformationMessage('Copied — paste into a terminal and restart Ollama.');
              }
            });
        }
      })
      .catch(() => { /* non-fatal UX hint */ });
  };
}
