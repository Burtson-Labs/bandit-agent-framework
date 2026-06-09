/**
 * Local OCR — extract printed text from an image file without an LLM.
 *
 * Dispatcher picks the best available engine for the platform:
 *   macOS   → Apple Vision via `swift` running a VNRecognizeTextRequest
 *             script. ~100-300ms per image, excellent on rendered text
 *             (code, logs, stack traces, dialogs).
 *   Linux   → tesseract CLI (`apt install tesseract-ocr`). ~500ms-2s.
 *   Windows → tesseract CLI (PowerShell.Windows.Media.Ocr could be
 *             added later; tesseract covers the common case today).
 *
 * Used by the extension/CLI on bandit-logic turns where a user paste
 * an image. When OCR yields usable text, we inline it into the prompt
 * as an `[Image text (OCR): …]` block and skip the model swap. When
 * OCR returns nothing (diagrams, photos, blurry), we fall back to a
 * vision-capable model for that turn.
 *
 * Binary OCR engines themselves are not bundled — we shell out to what
 * the user's OS already ships. Linux/Windows users see a one-time
 * install hint when tesseract is missing.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OcrResult {
  /** Extracted text. May be empty if OCR produced no confident output. */
  text: string;
  /** Engine that produced the text. Useful for telemetry. */
  engine: 'apple-vision' | 'tesseract' | 'windows-ocr' | 'none';
  /** Wall-clock time the OCR call took. */
  durationMs: number;
}

export interface OcrOptions {
  /** Abort the OCR run after this many ms. Defaults to 8s — catches
   *  a Vision hang without starving a long but legitimate recognition. */
  timeoutMs?: number;
}

/**
 * Detect available OCR engines without actually running one. Used by the
 * UI to decide whether to offer the "OCR-first" toggle. Results are
 * cached for the process lifetime because `which` is a filesystem
 * lookup we don't need to repeat on every image.
 */
let cachedAvailability: { apple: boolean; tesseract: boolean } | null = null;
export function detectOcrAvailability(): { apple: boolean; tesseract: boolean } {
  if (cachedAvailability) {return cachedAvailability;}
  const apple = process.platform === 'darwin' && hasBinary('swift');
  const tesseract = hasBinary('tesseract');
  cachedAvailability = { apple, tesseract };
  return cachedAvailability;
}

function hasBinary(name: string): boolean {
  try {
    const result = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Extract text from an image at `imagePath`. Returns an OcrResult with
 * empty `.text` on failure rather than throwing — callers treat "empty
 * text" as the signal to fall back to an LLM-vision path.
 */
export async function extractImageText(imagePath: string, options?: OcrOptions): Promise<OcrResult> {
  const startedAt = Date.now();
  const timeout = options?.timeoutMs ?? 8000;

  if (!fs.existsSync(imagePath)) {
    return { text: '', engine: 'none', durationMs: 0 };
  }

  const availability = detectOcrAvailability();

  if (process.platform === 'darwin' && availability.apple) {
    const text = await runAppleVision(imagePath, timeout);
    if (text.length > 0) {
      return { text, engine: 'apple-vision', durationMs: Date.now() - startedAt };
    }
  }

  if (availability.tesseract) {
    const text = await runTesseract(imagePath, timeout);
    if (text.length > 0) {
      return { text, engine: 'tesseract', durationMs: Date.now() - startedAt };
    }
  }

  return { text: '', engine: 'none', durationMs: Date.now() - startedAt };
}

/**
 * Inline Swift script that drives Apple's Vision framework. Using
 * `swift -e` avoids shipping a compiled binary — Xcode CLT's `swift`
 * is present on any Mac with dev tools. The script accepts the image
 * path as argv[1] and prints extracted strings (one per line) to
 * stdout. Any error goes to stderr with a non-zero exit so the caller
 * can distinguish "empty image" from "tool failure".
 */
const APPLE_VISION_SCRIPT = `
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
  FileHandle.standardError.write("usage: ocr <image-path>\\n".data(using: .utf8)!)
  exit(2)
}
let path = CommandLine.arguments[1]
guard let nsimage = NSImage(contentsOfFile: path), let tiff = nsimage.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff), let cg = rep.cgImage else {
  FileHandle.standardError.write("failed to load image\\n".data(using: .utf8)!)
  exit(3)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
  let observations = request.results ?? []
  var lines: [String] = []
  for obs in observations {
    if let top = obs.topCandidates(1).first {
      lines.append(top.string)
    }
  }
  print(lines.joined(separator: "\\n"))
} catch {
  FileHandle.standardError.write("vision error: \\(error.localizedDescription)\\n".data(using: .utf8)!)
  exit(4)
}
`;

function runAppleVision(imagePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    // Cache the script on disk so repeat invocations don't re-write it
    // every call. `swift` interprets it with its line-by-line mode
    // each time — the script itself is free, the Swift runtime cold
    // start costs ~80-120ms.
    const cachedScriptPath = path.join(os.tmpdir(), 'bandit-ocr-apple-vision.swift');
    try {
      if (!fs.existsSync(cachedScriptPath)) {
        fs.writeFileSync(cachedScriptPath, APPLE_VISION_SCRIPT, 'utf-8');
      }
    } catch {
      resolve('');
      return;
    }
    const child = cp.spawn('swift', [cachedScriptPath, imagePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', () => { /* discard stderr */ });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

/**
 * Tesseract CLI invocation. `--psm 6` (uniform block of text) gives the
 * best results on screenshots of code/logs; `--psm 3` (default) splits
 * columns which hurts accuracy when the model then reads the result.
 * `-l eng` is the safe default; users can override via a setting later.
 */
function runTesseract(imagePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = cp.spawn('tesseract', [imagePath, '-', '-l', 'eng', '--psm', '6'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

/**
 * Heuristic for "the OCR captured enough to be useful". Used by the
 * image-handling path to decide between "inline OCR text + stay on
 * current model" vs "fall back to a vision-capable model". Very cheap;
 * runs once per image.
 */
export function ocrYieldedUsefulText(text: string): boolean {
  if (!text) {return false;}
  const trimmed = text.trim();
  if (trimmed.length < 30) {return false;}
  // Printable-ratio sanity check — if the "text" is mostly gibberish
  // tokens (photo, diagram, blurry UI) the ratio of word chars to
  // length drops below ~50%. Cheap and effective.
  const alphaNum = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
  return alphaNum / trimmed.length > 0.45;
}
