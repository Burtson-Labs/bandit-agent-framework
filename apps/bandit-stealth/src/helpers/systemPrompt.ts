/**
 * VS Code system-prompt wrapper.
 *
 * Thin adapter: reads VS Code workspace configuration, resolves the
 * model id, then delegates to the canonical `buildExtensionSystemPrompt`
 * in `@burtson-labs/stealth-core-runtime`. Previous versions had a
 * full inline copy of the prompt builder that drifted away from the
 * runtime version (the eval harness was testing one prompt while the
 * extension shipped another).: single source of truth.
 *
 * The only thing this layer adds beyond the runtime builder is the
 * codebase context-block injection (file excerpts, search results)
 * that's specific to per-turn assembly inside the extension.
 */
import type * as vscode from 'vscode';
import { buildExtensionSystemPrompt, type ProviderKind } from '@burtson-labs/stealth-core-runtime';

export interface BuildSystemPromptOptions {
  providerKind: ProviderKind;
  configuration: vscode.WorkspaceConfiguration;
  /** Codebase context block (file excerpts, search results) appended to the prompt body. */
  contextBlock?: string;
  /** Override the configured model id — used by completion paths that override per-call. */
  modelIdOverride?: string;
  /** The user's prompt — used for the skill-authoring section gate. */
  userGoal?: string;
}

/**
 * Build the system prompt for a single turn. Returns `undefined` only
 * if neither a layered prompt nor a context block exist (in practice
 * always returns a string since the layered prompt is always non-empty).
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string | undefined {
  const { providerKind, configuration, contextBlock, modelIdOverride, userGoal } = options;

  const configuredModelId = providerKind === 'ollama'
    ? configuration.get<string>('ollamaModel', 'gemma3:12b') ?? 'gemma3:12b'
    : configuration.get<string>('model', 'bandit-core-1') ?? 'bandit-core-1';
  const modelId = (modelIdOverride && modelIdOverride.trim().length > 0
    ? modelIdOverride
    : configuredModelId).trim();

  const customBasePrompt = configuration.get<string>('systemPrompt', '');
  // co-author toggle. `banditStealth.coauthor` defaults to
  // true; `BANDIT_NO_COAUTHOR=1` in the editor's process environment
  // forces off (matches the CLI's behavior for power-users running
  // both surfaces).
  const envOff = /^(1|true)$/i.test(process.env.BANDIT_NO_COAUTHOR ?? '');
  const settingValue = configuration.get<boolean>('coauthor', true);
  const coauthor = envOff ? false : settingValue;

  let prompt: string | undefined = buildExtensionSystemPrompt({
    providerKind,
    modelId,
    customBasePrompt,
    userGoal,
    coauthor
  });

  if (contextBlock && contextBlock.trim().length > 0) {
    prompt = prompt ? `${prompt}\n\n${contextBlock}` : contextBlock;
  }
  return prompt;
}
