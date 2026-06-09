/**
 * Cloud endpoint resolvers extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The six resolvers + the underlying
 * `deriveEndpoint` URL math are pure functions of the workspace
 * configuration — no `this`, no context, no IO — so they're a clean
 * cut alongside the prior helper extractions.
 *
 * The base shape is: each resolver reads `<thing>Url` from settings,
 * falls back to `apiUrl` (default `https://api.burtson.ai/completions`),
 * and `deriveEndpoint` rewrites the URL's tail so a user who pasted
 * `.../completions` ends up with the right per-feature path.
 */
import type * as vscode from 'vscode';

const DEFAULT_API_URL = 'https://api.burtson.ai/completions';

/**
 * Take an optional explicit URL (`raw`) and a fallback base URL plus a
 * feature-specific path tail, and return the canonical endpoint URL.
 *
 * If the URL already ends in `/<path>`, it's returned as-is. If it
 * ends in `/completions` or `/chat/completions`, that suffix is
 * replaced with the new path. Otherwise the path is appended. Query
 * strings and hashes are stripped so a user who pasted `?token=...`
 * doesn't leak it onto every per-feature endpoint.
 *
 * Falls back to `${fallbackBase}/${path}` if URL parsing fails so a
 * malformed setting doesn't take down the feature.
 */
export function deriveEndpoint(raw: string | undefined, fallbackBase: string, path: string): string {
  const candidate = raw?.trim();
  const base = candidate && candidate.length > 0 ? candidate : fallbackBase;
  try {
    const url = new URL(base);
    const sanitized = url.pathname.replace(/\/+$/, '');
    if (sanitized.toLowerCase().endsWith(`/${path}`)) {
      url.pathname = sanitized;
    } else if (sanitized.toLowerCase().endsWith('/completions')) {
      url.pathname = sanitized.replace(/\/completions$/i, `/${path}`);
    } else if (sanitized.toLowerCase().endsWith('/chat/completions')) {
      url.pathname = sanitized.replace(/\/chat\/completions$/i, `/${path}`);
    } else {
      url.pathname = `${sanitized}/${path}`.replace(/\/+/g, '/');
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    const normalized = fallbackBase.replace(/\/+$/, '');
    return `${normalized}/${path}`;
  }
}

/** Cloud Intent classification endpoint. POST prompt → JSON insight. */
export function resolveIntentUrl(configuration: vscode.WorkspaceConfiguration): string {
  const raw = configuration.get<string>('intentUrl');
  const fallback = configuration.get<string>('apiUrl', DEFAULT_API_URL);
  return deriveEndpoint(raw, fallback, 'intent');
}

/** Cloud Semantic search endpoint. POST query → ranked context payloads. */
export function resolveSemanticUrl(configuration: vscode.WorkspaceConfiguration): string {
  const raw = configuration.get<string>('semanticUrl');
  const fallback = configuration.get<string>('apiUrl', DEFAULT_API_URL);
  return deriveEndpoint(raw, fallback, 'semantic/query');
}

/** Cloud Feedback collection endpoint. POST FeedbackRequest → ack. */
export function resolveFeedbackUrl(configuration: vscode.WorkspaceConfiguration): string {
  const raw = configuration.get<string>('feedbackUrl');
  const fallback = configuration.get<string>('apiUrl', DEFAULT_API_URL);
  return deriveEndpoint(raw, fallback, 'feedback');
}

/** Cloud TTS endpoint: POST text → audio/mpeg bytes. Gated by API-key. */
export function resolveTtsUrl(configuration: vscode.WorkspaceConfiguration): string {
  const fallback = configuration.get<string>('apiUrl', DEFAULT_API_URL);
  return deriveEndpoint(undefined, fallback, 'api/stealth/tts');
}

/** Cloud STT endpoint: POST multipart audio → JSON { transcription }. */
export function resolveSttUrl(configuration: vscode.WorkspaceConfiguration): string {
  const fallback = configuration.get<string>('apiUrl', DEFAULT_API_URL);
  return deriveEndpoint(undefined, fallback, 'api/stealth/stt/transcribe');
}

/**
 * Cloud Account & Usage endpoint. Returns auth method, email, plan,
 * admin flag, and rolling-window usage (session 5hr / weekly 7d) with
 * reset timestamps for the modal's progress bars.
 */
export function resolveAccountUsageUrl(configuration: vscode.WorkspaceConfiguration): string {
  const fallback = configuration.get<string>('apiUrl', DEFAULT_API_URL);
  return deriveEndpoint(undefined, fallback, 'api/stealth/account/usage');
}
