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
  /** Total upload attempts before giving up on a transient 5xx. Default 3. */
  maxAttempts?: number;
  /** Base backoff between retries (ms), multiplied by attempt#. Default 300. */
  retryDelayMs?: number;
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
 * Build a multipart/form-data body by hand. We deliberately do NOT use
 * FormData + Blob: Bun's fetch encodes those WITHOUT a clean Content-Length
 * (it streams chunked), which makes S3Api's forwarded SigV4 upload signature
 * mismatch on MinIO (`SignatureDoesNotMatch` → 500). That's reproducible on the
 * Bun-compiled standalone CLI and INVISIBLE on Node (which is why it looked
 * intermittent). A hand-built body over a single Uint8Array is byte-identical
 * on Bun and Node, carries a real Content-Length, and is replayable across
 * retries. Field name must match S3Api's `UploadRequest.File`.
 */
function buildMultipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array
): { body: Uint8Array; contentType: string } {
  const boundary = '----banditartifact' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const enc = new TextEncoder();
  const safeName = filename.replace(/["\\\r\n]/g, '_'); // keep the header well-formed
  const head = enc.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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

  // Hand-built multipart body (see buildMultipartBody) — runtime-agnostic, so the
  // Bun-compiled CLI uploads identically to Node. Built once; a Uint8Array is
  // replayable across retries.
  const { body, contentType: multipartContentType } = buildMultipartBody('File', opts.filename, contentType, bytes);

  // Retry 5xx + network errors with a short backoff (the S3Api→MinIO leg can
  // still transiently flake). 4xx (auth, too-large) are terminal — surface those.
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoffMs = opts.retryDelayMs ?? 300;
  let lastError: Error = new Error('artifact upload failed');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/artifact`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': multipartContentType },
        body: body as unknown as BodyInit,
      });
    } catch (err) {
      // Network-level failure — transient, worth a retry.
      lastError = new Error(`artifact upload failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < maxAttempts) { await sleep(backoffMs * attempt); continue; }
      throw lastError;
    }

    if (res.ok) {
      const body = (await res.json()) as Partial<PublishedArtifact>;
      if (!body.url) throw new Error('artifact upload succeeded but no URL was returned');
      return { url: body.url, key: body.key ?? '', size: body.size ?? bytes.byteLength };
    }

    let detail = '';
    try { detail = (await res.json() as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    lastError = new Error(`artifact upload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    // Only 5xx is retryable; 4xx is a terminal client error.
    if (res.status >= 500 && attempt < maxAttempts) { await sleep(backoffMs * attempt); continue; }
    throw lastError;
  }
  throw lastError;
}

/** Injectable-free small delay; skipped when the backoff is 0 (tests). */
function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Common options for the artifact-management calls (list / delete / clear). */
export interface ArtifactManageOptions {
  s3ApiBaseUrl: string;
  /** `bai_` device key (exchanged for a gateway JWT) or an existing gateway JWT. */
  token: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ArtifactListItem {
  key: string;
  url: string;
  size: number;
  lastModified: string;
}

/**
 * Extract the object key from a share URL (everything after `/api/artifact/`),
 * decoding per-segment percent-encoding. Returns the input unchanged when it's
 * already a key (no marker), so callers can pass either a URL or a raw key.
 */
export function artifactKeyFromUrl(urlOrKey: string): string {
  const marker = '/api/artifact/';
  const i = urlOrKey.indexOf(marker);
  const raw = i >= 0 ? urlOrKey.slice(i + marker.length) : urlOrKey;
  return raw
    .split('/')
    .map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } })
    .join('/');
}

/** List the caller's own artifacts (server returns them most-recent first). */
export async function listArtifacts(opts: ArtifactManageOptions): Promise<ArtifactListItem[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.s3ApiBaseUrl.replace(/\/$/, '');
  const bearer = await resolveGatewayToken(opts.token, { authBaseUrl: opts.authBaseUrl, fetchImpl });
  const res = await fetchImpl(`${base}/api/artifact/mine`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`could not list artifacts: HTTP ${res.status}`);
  const body = (await res.json()) as { artifacts?: ArtifactListItem[] };
  return body.artifacts ?? [];
}

/** Delete one artifact by its share URL or object key (owner-scoped server-side). */
export async function deleteArtifact(opts: ArtifactManageOptions & { keyOrUrl: string }): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.s3ApiBaseUrl.replace(/\/$/, '');
  const key = artifactKeyFromUrl(opts.keyOrUrl);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  const bearer = await resolveGatewayToken(opts.token, { authBaseUrl: opts.authBaseUrl, fetchImpl });
  const res = await fetchImpl(`${base}/api/artifact/${encoded}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`no artifact found for "${opts.keyOrUrl}" (or it isn't yours)`);
    throw new Error(`could not delete artifact: HTTP ${res.status}`);
  }
}

/** Delete ALL of the caller's artifacts. Returns how many were removed. */
export async function clearArtifacts(opts: ArtifactManageOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.s3ApiBaseUrl.replace(/\/$/, '');
  const bearer = await resolveGatewayToken(opts.token, { authBaseUrl: opts.authBaseUrl, fetchImpl });
  const res = await fetchImpl(`${base}/api/artifact/mine`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`could not clear artifacts: HTTP ${res.status}`);
  const body = (await res.json()) as { deleted?: number };
  return body.deleted ?? 0;
}
