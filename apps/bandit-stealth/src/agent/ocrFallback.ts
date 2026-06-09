/**
 * OCR fallback for image-bearing prompts on non-vision models.
 *
 * When the user attaches an image but the active model can't see images,
 * we try local OCR (Apple Vision on macOS, tesseract elsewhere) to
 * extract text and inline it into the prompt. Keeps the user on their
 * chosen model (e.g. bandit-logic for code work) and avoids the
 * cost/latency of a model swap for the most common case — screenshot
 * of code / stack trace / dialog text. If OCR yields nothing useful,
 * returns an empty extracted-text string and the caller falls through
 * to the existing vision-model gate.
 *
 * Input image shapes (mirroring the webview's attach paths):
 *  - `data:image/...;base64,…` — Ctrl+V paste from the composer. Decoded
 *    to a tempfile, passed to the OCR engine, tempfile removed.
 *  - `http(s)://…` — remote URL. Skipped (a fetch round-trip would
 *    defeat the purpose of "fast local fallback").
 *  - Anything else — treated as a workspace path, resolved against
 *    `workspaceRoot`.
 *
 * Returns the concatenated OCR text (one `[Image text (OCR via engine):
 * label]` block per image that produced useful text) and the last
 * engine that ran. Empty text + null engine means OCR produced nothing
 * usable — the caller should fall through to the model-swap prompt.
 *
 * `banditStealth.ocrFallback === 'off'` disables this path entirely
 * (early return with empty results).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { extractImageText, ocrYieldedUsefulText } from '@burtson-labs/agent-core';

export interface OcrFallbackResult {
  text: string;
  engine: string | null;
}

export async function runOcrFallback(
  requestedImages: string[],
  configuration: vscode.WorkspaceConfiguration,
  workspaceRoot: string
): Promise<OcrFallbackResult> {
  const ocrMode = configuration.get<string>('ocrFallback', 'ocr-first');
  if (ocrMode === 'off') {return { text: '', engine: null };}

  let extracted = '';
  let lastEngine: string | null = null;
  const tempPaths: string[] = [];

  for (let idx = 0; idx < requestedImages.length; idx++) {
    const raw = requestedImages[idx];
    let resolvedPath = '';
    let displayLabel = '';
    try {
      if (/^data:image\//i.test(raw)) {
        const commaIdx = raw.indexOf(',');
        const b64 = commaIdx >= 0 ? raw.slice(commaIdx + 1) : '';
        const mimeMatch = /^data:(image\/[\w+.-]+)/i.exec(raw);
        const ext = mimeMatch ? mimeMatch[1].split('/')[1].split('+')[0] : 'png';
        const tmpPath = path.join(os.tmpdir(), `bandit-ocr-${Date.now()}-${idx}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64'));
        tempPaths.push(tmpPath);
        resolvedPath = tmpPath;
        displayLabel = `pasted.${ext}`;
      } else if (/^https?:/i.test(raw)) {
        continue;
      } else {
        resolvedPath = path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
        displayLabel = path.basename(raw);
      }
      const result = await extractImageText(resolvedPath);
      if (ocrYieldedUsefulText(result.text)) {
        extracted += (extracted ? '\n\n' : '')
          + `[Image text (OCR via ${result.engine}): ${displayLabel}]\n${result.text}`;
        lastEngine = result.engine;
      }
    } catch {
      // Silent skip — fall through to the existing vision-model notification path.
    }
  }

  for (const tmp of tempPaths) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }

  return { text: extracted, engine: lastEngine };
}
