/**
 * @-mentions — detect `@path/to/file` patterns in user input and inline the
 * file contents into the prompt so the model sees them in the first turn.
 *
 * user> explain @src/auth.ts
 * → prompt becomes: "explain @src/auth.ts\n\n[File: src/auth.ts]\n<content>"
 *
 * Images (png/jpg/etc.) are NOT inlined as text — doing so dumps raw binary
 * bytes decoded as UTF-8 into the prompt, and the model interprets the
 * resulting gibberish as corrupt data. Instead, image mentions are
 * collected into `images[]` as base64 data URLs so the caller can
 * forward them on the provider's `images` field (Ollama vision models
 * accept this; Bandit cloud forwards through to the gateway).
 */

import * as fs from 'fs';
import * as path from 'path';
import { redactSecretsString } from '@burtson-labs/agent-core';

const MENTION_REGEX = /(?:^|\s)@([^\s@]+)/g;

/**
 * redact secrets from @-mentioned file content with the
 * same opt-out as the rest of the redactor (`BANDIT_NO_SECRET_REDACTION=1`).
 * Pulled into a helper so the env check happens once per mention pass.
 */
function applyMentionSecretRedaction(text: string): string {
  if (/^(1|true)$/i.test(process.env.BANDIT_NO_SECRET_REDACTION ?? '')) {
    return text;
  }
  if (!text || text.length === 0) return text;
  return redactSecretsString(text);
}
const MAX_FILE_BYTES = 64 * 1024; // 64 KB per mention
const MAX_MENTIONS = 8;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|heic|bmp)$/i;

export interface ExpandedPrompt {
  prompt: string;
  mentions: { path: string; bytes: number; ok: boolean; kind?: 'text' | 'image' }[];
  /**
   * Base64-encoded payloads for any image mentions in the prompt, in the
   * order they appeared. Empty when no images were attached. Caller is
   * responsible for forwarding these to the provider — the prompt text
   * only contains a `[Image: path]` placeholder so the model has a label
   * to anchor references to.
   */
  images: string[];
}

export async function expandMentions(input: string, cwd: string): Promise<ExpandedPrompt> {
  const matches = [...input.matchAll(MENTION_REGEX)].slice(0, MAX_MENTIONS);
  if (matches.length === 0) return { prompt: input, mentions: [], images: [] };

  const seen = new Set<string>();
  const sections: string[] = [];
  const mentions: ExpandedPrompt['mentions'] = [];
  const images: string[] = [];

  for (const m of matches) {
    const rel = m[1];
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    // Guard: don't read outside the workspace.
    if (!abs.startsWith(path.resolve(cwd))) {
      mentions.push({ path: rel, bytes: 0, ok: false });
      continue;
    }

    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) {
        mentions.push({ path: rel, bytes: 0, ok: false });
        continue;
      }
      const raw = await fs.promises.readFile(abs);
      // Image branch: encode + register as attachment, emit a short
      // placeholder so the prompt doesn't contain binary gibberish.
      if (IMAGE_EXT.test(rel)) {
        images.push(raw.toString('base64'));
        sections.push(`[Image attached: ${rel} — ${raw.byteLength} bytes]`);
        mentions.push({ path: rel, bytes: raw.byteLength, ok: true, kind: 'image' });
        continue;
      }
      const truncated = raw.byteLength > MAX_FILE_BYTES;
      const rawContent = raw.subarray(0, MAX_FILE_BYTES).toString('utf-8');
      // redact secrets from @-mentioned file content before
      // it lands in the user message. @-mentions inline file content
      // into the prompt body verbatim; without this pass, dropping
      // `@.env` or `@~/.aws/credentials` into the composer would ship
      // every key in there to the model context and the session log.
      // Same redactor that runs on tool-result output, applied here
      // for parity. Opt-out via BANDIT_NO_SECRET_REDACTION env.
      const content = applyMentionSecretRedaction(rawContent);
      const suffix = truncated ? `\n… (truncated, full file is ${raw.byteLength} bytes)` : '';
      sections.push(`[File: ${rel}]\n\`\`\`\n${content}${suffix}\n\`\`\``);
      mentions.push({ path: rel, bytes: raw.byteLength, ok: true, kind: 'text' });
    } catch {
      mentions.push({ path: rel, bytes: 0, ok: false });
    }
  }

  const body = sections.length > 0 ? `${input}\n\n${sections.join('\n\n')}` : input;
  return { prompt: body, mentions, images };
}
