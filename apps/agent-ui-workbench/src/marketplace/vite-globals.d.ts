/// <reference types="vite/client" />

// Injected by vite.config.ts at build time so the Extensions panel can
// quote real artifact stats. Null when bandit-stealth.vsix hasn't been
// built yet — the marketplace panel falls back to "—" for those rows.
declare const __BANDIT_VSIX_SIZE_BYTES__: number | null;
declare const __BANDIT_VSIX_MTIME__: string | null;
