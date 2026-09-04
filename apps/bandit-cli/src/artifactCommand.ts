/**
 * `bandit artifact <path>` — publish a local file as a shareable Bandit
 * Artifact and print the URL. Cloud-only (needs a Bandit cloud token, the same
 * JWT that authenticates every Burtson API); local-only users get a clear
 * message instead of a broken call, keeping the offline path offline.
 *
 * Thin wrapper over host-kit's publishArtifact (which posts straight to S3Api).
 */
import * as fs from 'fs';
import * as path from 'path';
import { publishArtifact, guessContentType } from '@burtson-labs/host-kit';
import { c, glyph } from './ansi';
import { loadConfigFiles, resolveConfig } from './config';

/** S3Api base — config `s3.baseUrl`, else BANDIT_S3_URL, else the prod host. */
function resolveS3ApiBaseUrl(fileConfig: { s3?: { baseUrl?: string } }): string {
  return (fileConfig.s3?.baseUrl ?? process.env.BANDIT_S3_URL ?? 'https://s3.burtson.ai').replace(/\/$/, '');
}

export async function runArtifactCommand(argv: string[], cwd: string): Promise<void> {
  const target = argv.find((a) => !a.startsWith('-'));
  if (!target) {
    process.stdout.write('usage: bandit artifact <path>   (publish a file as a shareable link)\n');
    return;
  }

  const fileConfig = await loadConfigFiles(cwd);
  const resolved = resolveConfig(fileConfig, {});
  if (!resolved.apiKey) {
    process.stdout.write(
      c.yellow(`  ${glyph.warn} Artifacts are a Bandit cloud feature — no API key found.\n`) +
      c.dim('     Sign in / set your key, then retry. (Local-only stays fully offline.)\n')
    );
    return;
  }

  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(abs);
  } catch {
    process.stdout.write(c.red(`  ${glyph.cross} can't read ${target}\n`));
    return;
  }
  const filename = path.basename(abs);

  process.stdout.write(c.dim(`  ${glyph.spark} publishing ${filename} (${(bytes.byteLength / 1024).toFixed(0)} KB)…\n`));
  try {
    const artifact = await publishArtifact({
      s3ApiBaseUrl: resolveS3ApiBaseUrl(fileConfig as { s3?: { baseUrl?: string } }),
      token: resolved.apiKey,
      content: new Uint8Array(bytes),
      filename,
      contentType: guessContentType(filename),
    });
    process.stdout.write(
      c.green(`  ${glyph.check} published — shareable link:\n`) +
      `  ${c.cyan(artifact.url)}\n`
    );
  } catch (err) {
    process.stdout.write(c.red(`  ${glyph.cross} ${err instanceof Error ? err.message : String(err)}\n`));
  }
}
