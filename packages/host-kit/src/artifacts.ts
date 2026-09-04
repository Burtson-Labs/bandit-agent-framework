/**
 * Bandit Artifacts (cloud) — publish a shareable artifact to S3Api and get back
 * a URL anyone with the link can open.
 *
 * Auth: S3Api (like every [BurtsonAuthorize] service) validates a gateway JWT,
 * NOT the opaque `bai_` device key the CLI/extension hold. So a host with a
 * `bai_` key must first exchange it for a short-lived gateway token via AuthApi
 * — exactly what BLFlow's GatewayTokenResolver does for the same S3Api calls.
 * publishArtifact does that exchange automatically (see resolveGatewayToken); a
 * caller that already has a gateway JWT (a signed-in web/extension session)
 * passes it straight through. The upload is per-user/team scoped and
 * quota-bounded server-side (see S3Api's ArtifactController).
 *
 * Host-agnostic (fetch + FormData/Blob, standard in the Node the CLI and
 * extension run on), so both hosts share one implementation. Local-only users
 * never call this — it requires a cloud token, keeping the offline path offline.
 */

/** AuthApi base URL used for the `bai_` → gateway-JWT exchange. */
export const DEFAULT_AUTH_BASE_URL = 'https://auth.burtson.ai';

export interface PublishArtifactOptions {
  /** S3Api base URL, e.g. https://s3.burtson.ai (no trailing slash needed). */
  s3ApiBaseUrl: string;
  /**
   * The user's Bandit cloud credential — either a `bai_` device key (exchanged
   * for a gateway JWT automatically) or an already-minted gateway JWT.
   */
  token: string;
  /** Artifact bytes (a report, a file) or text. */
  content: Uint8Array | string;
  /** File name — its extension drives how the artifact renders when shared. */
  filename: string;
  /** MIME type; defaults by extension, else application/octet-stream. */
  contentType?: string;
  /** AuthApi base for the `bai_`→JWT exchange; defaults to auth.burtson.ai. */
  authBaseUrl?: string;
  /** Injectable for tests / non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
}

export interface PublishedArtifact {
  /** Absolute shareable URL (open in any browser). */
  url: string;
  /** Server object key (owner-prefixed). */
  key: string;
  size: number;
}

/** Best-effort MIME guess from a filename extension. */
export function guessContentType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.html': case '.htm': return 'text/html';
    case '.md': return 'text/markdown';
    case '.txt': case '.log': return 'text/plain';
    case '.json': return 'application/json';
    case '.csv': return 'text/csv';
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/**
 * Exchange a Bandit `bai_` device key for a short-lived gateway JWT, so a host
 * holding only the opaque device key can call a [BurtsonAuthorize] service that
 * validates JWTs (S3Api, Ollama, …). POSTs the key to AuthApi `/api/keys/validate`
 * and returns `gatewayToken`. A token that is not a `bai_` key (i.e. already a
 * gateway JWT) passes straight through untouched — no network call.
 *
 * Mirrors BLFlow's GatewayTokenResolver; kept here so both the CLI and the VS
 * Code extension share one exchange path.
 */
export async function resolveGatewayToken(
  token: string,
  opts: { authBaseUrl?: string; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  if (!token.startsWith('bai_')) return token; // already a gateway JWT
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.authBaseUrl ?? DEFAULT_AUTH_BASE_URL).replace(/\/$/, '');

  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/keys/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: token }),
    });
  } catch (err) {
    throw new Error(`could not reach the auth service to sign in: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const body = (await res.json()) as { valid?: boolean; gatewayToken?: string; reason?: string };
  if (!body.valid || !body.gatewayToken) {
    throw new Error(`your API key was rejected${body.reason ? ` (${body.reason})` : ''} — sign in again with \`bandit login\``);
  }
  return body.gatewayToken;
}

/**
 * Upload an artifact and return its shareable URL. Throws on a non-2xx (with
 * the status + server message) so callers can surface a clear failure — this
 * is user-initiated ("share this"), so silent failure would be worse than an
 * error.
 */
export async function publishArtifact(opts: PublishArtifactOptions): Promise<PublishedArtifact> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.s3ApiBaseUrl.replace(/\/$/, '');
  const contentType = opts.contentType ?? guessContentType(opts.filename);
  const bytes = typeof opts.content === 'string' ? new TextEncoder().encode(opts.content) : opts.content;

  // S3Api validates a gateway JWT, not the `bai_` device key — trade up first.
  const bearer = await resolveGatewayToken(opts.token, { authBaseUrl: opts.authBaseUrl, fetchImpl });

  const form = new FormData();
  // Field name must match S3Api's UploadRequest.File. Don't set a
  // Content-Type header ourselves — fetch derives the multipart boundary.
  // Cast: Uint8Array is a valid BlobPart at runtime; the cast only sidesteps
  // TS 5.7's ArrayBufferLike/SharedArrayBuffer generic strictness.
  form.append('File', new Blob([bytes as unknown as BlobPart], { type: contentType }), opts.filename);

  const res = await fetchImpl(`${base}/api/artifact`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: form,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json() as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(`artifact upload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  const body = (await res.json()) as Partial<PublishedArtifact>;
  if (!body.url) throw new Error('artifact upload succeeded but no URL was returned');
  return { url: body.url, key: body.key ?? '', size: body.size ?? bytes.byteLength };
}
