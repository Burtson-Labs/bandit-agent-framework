/**
 * Which Ollama server the semantic_search skill should embed through.
 *
 * The skill defaults to http://localhost:11434 and nothing in the CLI ever told it
 * otherwise, so with Ollama on another host or port (OLLAMA_URL, `ollama.url` in
 * ~/.bandit/config.json) chat went to the configured server while every embedding call
 * went to localhost and failed, or hit a different Ollama. Same precedence as the chat
 * provider: the node URL when one is set, else the primary URL. Undefined (no URL
 * configured) keeps the skill's default.
 */
import type { ProviderSettings } from '@burtson-labs/stealth-core-runtime';

export function semanticSearchOllamaUrl(settings: Pick<ProviderSettings, 'ollamaUrl' | 'ollamaNodeUrl'>): string | undefined {
  return settings.ollamaNodeUrl?.trim() || settings.ollamaUrl?.trim() || undefined;
}
