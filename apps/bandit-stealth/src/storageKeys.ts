export const API_KEY_SECRET_KEY = 'banditStealth.apiKey';

// Ollama auth token stored in VS Code's encrypted secret store. When
// set, the provider layer auto-injects it as `Authorization: Bearer
// <value>` on every Ollama request (including /api/tags for model
// discovery), unless `banditStealth.ollamaHeaders.Authorization` is
// already explicitly set — an explicit header in settings always wins
// so power users can mix schemes.
export const OLLAMA_AUTH_SECRET_KEY = 'banditStealth.ollamaAuthToken';

// The four keys below used to live in plain `settings.json`. A workspace
// setting lands in a file that gets committed; a user setting rides
// Settings Sync in cleartext. Both are the wrong place for a bearer token,
// so they now live in the OS keychain via SecretStorage and the old
// settings are cleared on activation by `migrateSettingSecrets`.
//
// The secret names deliberately match the old setting ids — the migration
// is then a move between two stores under one name, and a key that shows
// up in a keychain dump is still traceable to the feature that owns it.
// The settings themselves stay declared in package.json (marked deprecated)
// so an existing settings.json doesn't turn into an "unknown configuration"
// warning, and so the migration has something to read on first run.
export const OPENAI_API_KEY_SECRET_KEY = 'banditStealth.openaiApiKey';
export const VOICE_STT_API_KEY_SECRET_KEY = 'banditStealth.voice.stt.apiKey';
export const VOICE_TTS_API_KEY_SECRET_KEY = 'banditStealth.voice.tts.apiKey';
export const TAVILY_API_KEY_SECRET_KEY = 'banditStealth.webSearch.tavilyApiKey';

export const CONVERSATION_STORAGE_KEY = 'banditStealth.conversation';
export const CONVERSATION_HISTORY_STORAGE_KEY = 'banditStealth.conversationHistory';
export const MODE_STORAGE_KEY = 'banditStealth.mode';
export const INTENT_MEMORY_STORAGE_KEY = 'banditStealth.intentHistory';

// Map of { modelId: recommendedMaxIterations } cached from the gateway model
// catalog (/api/stealth/models) by the model picker. Lets the agent loop honor
// a server-advertised per-model loop cap without a network call at run time.
export const MODEL_MAX_ITER_CACHE_KEY = 'banditStealth.modelMaxIterations';
