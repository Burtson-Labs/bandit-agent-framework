export const API_KEY_SECRET_KEY = 'banditStealth.apiKey';

// Ollama auth token stored in VS Code's encrypted secret store. When
// set, the provider layer auto-injects it as `Authorization: Bearer
// <value>` on every Ollama request (including /api/tags for model
// discovery), unless `banditStealth.ollamaHeaders.Authorization` is
// already explicitly set — an explicit header in settings always wins
// so power users can mix schemes.
export const OLLAMA_AUTH_SECRET_KEY = 'banditStealth.ollamaAuthToken';

export const CONVERSATION_STORAGE_KEY = 'banditStealth.conversation';
export const CONVERSATION_HISTORY_STORAGE_KEY = 'banditStealth.conversationHistory';
export const MODE_STORAGE_KEY = 'banditStealth.mode';
export const INTENT_MEMORY_STORAGE_KEY = 'banditStealth.intentHistory';
