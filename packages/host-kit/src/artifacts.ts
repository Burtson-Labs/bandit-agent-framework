/**
 * Bandit Artifacts (cloud) — publish a shareable artifact to S3Api and get back
 * a URL anyone with the link can open.
 *
 * Cloud users' Burtson JWT authenticates to every Burtson API (confirmed), so
 * this talks to S3Api directly — no gateway proxy, no service credential. The
 * upload is per-user scoped and quota-bounded server-side (see S3Api's
 * ArtifactController); this client just posts the bytes with the caller's token
 * and returns the shareable URL S3Api mints.
 *
 * Host-agnostic (fetch + FormData/Blob, standard in the Node the CLI and
 * extension run on), so both hosts share one implementation. Local-only users
 * never call this — it requires a cloud token, keeping the offline path offline.
 */

export interface PublishArtifactOptions {
  /** S3Api base URL, e.g. https://s3.burtson.ai (no trailing slash needed). */
  s3ApiBaseUrl: string;
  /** The user's Bandit cloud token (same JWT used for every Burtson API). */
  token: string;
  /** Artifact bytes (a report, a file) or text. */
  content: Uint8Array | string;
  /** File name — its extension drives how the artifact renders when shared. */
  filename: string;
  /** MIME type; defaults by extension, else application/octet-stream. */
  contentType?: string;
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

  const form = new FormData();
  // Field name must match S3Api's UploadRequest.File. Don't set a
  // Content-Type header ourselves — fetch derives the multipart boundary.
  // Cast: Uint8Array is a valid BlobPart at runtime; the cast only sidesteps
  // TS 5.7's ArrayBufferLike/SharedArrayBuffer generic strictness.
  form.append('File', new Blob([bytes as unknown as BlobPart], { type: contentType }), opts.filename);

  const res = await fetchImpl(`${base}/api/artifact`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token}` },
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
