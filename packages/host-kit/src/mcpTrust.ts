/**
 * MCP trust store — remembers which server-config fingerprints the user
 * has approved across Bandit sessions. Spawning an MCP server is a
 * code-execution boundary; the first time we encounter a config we
 * haven't seen, the host asks the user. The answer (allow once / allow
 * always / deny) is the host's responsibility to surface; this module
 * is the persistence layer for "allow always".
 *
 * Stored at `~/.bandit/mcp-trust.json` as a flat array of fingerprints
 * — file is written 0600 since it represents a security decision the
 * user shouldn't have casually edited by another process.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TRUST_FILE = path.join(os.homedir(), '.bandit', 'mcp-trust.json');

interface TrustFile {
  /** Approved server-config fingerprints (see fingerprintServerConfig
   *  in agent-core/mcp). One entry per "always allow" decision. */
  approved: string[];
}

async function readTrustFile(): Promise<TrustFile> {
  try {
    const raw = await fs.promises.readFile(TRUST_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TrustFile>;
    if (Array.isArray(parsed.approved)) {
      return { approved: parsed.approved.filter((s) => typeof s === 'string') };
    }
  } catch {
    // Missing or malformed — return empty. Trust is opt-in; absence
    // of the file means no fingerprints have been approved yet.
  }
  return { approved: [] };
}

async function writeTrustFile(file: TrustFile): Promise<void> {
  const dir = path.dirname(TRUST_FILE);
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  await fs.promises.writeFile(
    TRUST_FILE,
    JSON.stringify(file, null, 2),
    { encoding: 'utf-8', mode: 0o600 }
  );
}

/** Read the set of fingerprints the user has previously approved. */
export async function loadApprovedMcpFingerprints(): Promise<Set<string>> {
  const file = await readTrustFile();
  return new Set(file.approved);
}

/** Persist a fingerprint as "always allowed". Idempotent — duplicates are dropped. */
export async function approveMcpFingerprint(fingerprint: string): Promise<void> {
  const file = await readTrustFile();
  if (!file.approved.includes(fingerprint)) {
    file.approved.push(fingerprint);
    await writeTrustFile(file);
  }
}

/** Remove a fingerprint from the approved list (used by a future revoke flow). */
export async function revokeMcpFingerprint(fingerprint: string): Promise<void> {
  const file = await readTrustFile();
  const next = file.approved.filter((f) => f !== fingerprint);
  if (next.length !== file.approved.length) {
    await writeTrustFile({ approved: next });
  }
}

/** Path to the trust file — exposed so error messages and CLI helpers
 *  can echo the location for the user. */
export function mcpTrustPath(): string {
  return TRUST_FILE;
}
