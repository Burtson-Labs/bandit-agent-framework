/**
 * PDF tools for the CLI host.
 *
 * - `read_pdf` — text extraction via pdf-parse
 * - `preview_pdf` — rasterize pages to PNGs (Chrome/Chromium) so vision
 *   models can visual-QA layouts before publish
 * - `render_pdf` — HTML → PDF via Chrome headless with headers/footers off
 *   (stops the agent installing weasyprint/playwright per turn)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import type { AgentTool, ToolExecutionContext, ToolResult } from '@burtson-labs/agent-core';

const MAX_OUTPUT_CHARS = 32 * 1024;  // 32 KB of extracted text
const MAX_PDF_BYTES = 20 * 1024 * 1024;  // 20 MB cap so huge scans don't OOM
const MAX_PREVIEW_PAGES = 4;

function expandPath(raw: string, workspaceRoot: string): string {
  const expanded = raw.startsWith('~')
    ? raw.replace(/^~/, process.env.HOME ?? '')
    : raw;
  return path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot, expanded);
}

function resolveChromium(): string | null {
  const env = process.env.BANDIT_CHROMIUM_PATH?.trim();
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function runChromium(chrome: string, args: string[], timeoutMs = 60_000): { code: number | null; stderr: string } {
  const result = cp.spawnSync(chrome, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    code: result.status,
    stderr: String(result.stderr ?? '').slice(0, 800),
  };
}

export const pdfReadTool: AgentTool = {
  name: 'read_pdf',
  description: 'Extract the readable text content of a PDF file. Returns the text with page breaks. Works with text-based PDFs; scanned/image-only PDFs will return little or no text (OCR not performed).',
  parameters: [
    { name: 'path', description: 'Path to the PDF file. Accepts absolute paths, tilde-prefixed paths (~/Desktop/foo.pdf), or paths relative to the workspace root.', required: true }
  ],
  async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = params.path?.trim();
    if (!raw) return { output: 'Error: path parameter is required', isError: true };

    const absPath = expandPath(raw, ctx.workspaceRoot);

    let buf: Buffer;
    try {
      const stat = await fs.promises.stat(absPath);
      if (!stat.isFile()) return { output: `Not a file: ${raw}`, isError: true };
      if (stat.size > MAX_PDF_BYTES) {
        return { output: `PDF too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > 20 MB cap). Use a smaller file or ask the user for a specific page range.`, isError: true };
      }
      buf = await fs.promises.readFile(absPath);
    } catch (err) {
      return { output: `Could not read ${raw}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    // pdf-parse v2 exposes a class-based API: new PDFParse({data}).getText().
    // Load lazily so the ~1 MB import cost doesn't hit every bandit launch.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFParse } = require('pdf-parse') as {
      PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string; pages: unknown[]; total: number }>; destroy(): void }
    };

    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      const text = (result.text ?? '').trim();
      const pageCount = result.total ?? result.pages?.length ?? 0;
      if (!text) {
        return { output: `Extracted 0 characters from ${raw} (${pageCount} pages). This is likely an image-only / scanned PDF — OCR is not performed. Use preview_pdf to see page images instead.`, isError: true };
      }
      const truncated = text.length > MAX_OUTPUT_CHARS;
      const body = truncated ? text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[truncated — full text is ${text.length} chars across ${pageCount} pages]` : text;
      return { output: `PDF: ${raw} (${pageCount} pages)\n\n${body}`, isError: false };
    } catch (err) {
      return { output: `Failed to parse PDF "${raw}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      try { parser.destroy(); } catch { /* ignore cleanup errors */ }
    }
  }
};

/**
 * Rasterize PDF pages to PNG via Chrome headless so the agent (with vision)
 * can catch blank pages / layout bugs before publish_artifact.
 */
export const pdfPreviewTool: AgentTool = {
  name: 'preview_pdf',
  description: 'Render the first pages of a PDF to PNG images for visual QA. Returns image file paths. Prefer this after render_pdf / before publish_artifact — catches blank pages and header/footer chrome that text extraction misses.',
  parameters: [
    { name: 'path', description: 'Path to the PDF file.', required: true },
    { name: 'pages', description: `How many leading pages to render (1–${MAX_PREVIEW_PAGES}). Default 2.`, required: false },
    { name: 'out_dir', description: 'Directory for PNG outputs. Defaults to a temp folder.', required: false },
  ],
  async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = params.path?.trim();
    if (!raw) return { output: 'Error: path parameter is required', isError: true };
    const absPath = expandPath(raw, ctx.workspaceRoot);
    if (!fs.existsSync(absPath)) return { output: `PDF not found: ${raw}`, isError: true };

    const chrome = resolveChromium();
    if (!chrome) {
      return {
        output: 'No Chrome/Chromium found for PDF preview. Install Google Chrome or set BANDIT_CHROMIUM_PATH.',
        isError: true,
      };
    }

    const pageCount = Math.min(
      MAX_PREVIEW_PAGES,
      Math.max(1, parseInt(params.pages || '2', 10) || 2)
    );
    const outDir = params.out_dir?.trim()
      ? expandPath(params.out_dir.trim(), ctx.workspaceRoot)
      : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bandit-pdf-preview-'));
    await fs.promises.mkdir(outDir, { recursive: true });

    const written: string[] = [];
    // Chrome can screenshot a PDF URL; we open file:// and capture the
    // viewport. Multi-page: scroll via --virtual-time-budget isn't reliable,
    // so we render page 1 as a full screenshot and note remaining pages for
    // the agent to open manually if needed. For a stronger multi-page path
    // later, wire pdf.js — this catches the blank-page class of bugs.
    const pngPath = path.join(outDir, 'page-1.png');
    const fileUrl = `file://${absPath}`;
    const { code, stderr } = runChromium(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--screenshot=${pngPath}`,
      '--window-size=1024,1400',
      fileUrl,
    ]);
    if (code !== 0 || !fs.existsSync(pngPath)) {
      return {
        output: `Chrome PDF preview failed (exit ${code}): ${stderr || 'no output file'}`,
        isError: true,
      };
    }
    written.push(pngPath);

    // Best-effort: also dump a quick text summary so non-vision turns still
    // get a signal about emptiness.
    let textHint = '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PDFParse } = require('pdf-parse') as {
        PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string; total: number }>; destroy(): void }
      };
      const parser = new PDFParse({ data: await fs.promises.readFile(absPath) });
      try {
        const result = await parser.getText();
        const chars = (result.text ?? '').trim().length;
        textHint = `\nText extractable: ${chars} chars across ~${result.total ?? '?'} pages.`
          + (chars < 40 ? ' WARNING: nearly empty text — page may be blank or image-only.' : '');
      } finally {
        try { parser.destroy(); } catch { /* ignore */ }
      }
    } catch {
      /* preview images are the deliverable */
    }

    return {
      output: [
        `Previewed ${raw} → ${written.join(', ')}`,
        `(requested up to ${pageCount} pages; page-1 screenshot written)`,
        textHint.trim(),
        'If the active model supports vision, open/attach these PNGs to verify layout before publishing.',
      ].filter(Boolean).join('\n'),
      isError: false,
    };
  }
};

/**
 * Render HTML (file path or inline content) to a PDF with Chrome headless.
 * Prefer this over inventing weasyprint/playwright venvs.
 */
export const pdfRenderTool: AgentTool = {
  name: 'render_pdf',
  description: 'Render HTML to a PDF using Chrome/Chromium headless (no browser date/URL headers). Pass html_path OR html content. Prefer writing a .html file then calling this — do NOT pip-install weasyprint/playwright for PDF creation.',
  parameters: [
    { name: 'html_path', description: 'Path to an HTML file to print.', required: false },
    { name: 'html', description: 'Inline HTML content (alternative to html_path).', required: false },
    { name: 'out', description: 'Output PDF path. Defaults to <html_path>.pdf or ~/Desktop/bandit-render.pdf.', required: false },
  ],
  async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const chrome = resolveChromium();
    if (!chrome) {
      return {
        output: 'No Chrome/Chromium found. Install Google Chrome or set BANDIT_CHROMIUM_PATH. (Cloud/web agents should use create_file format=pdf via the gateway instead.)',
        isError: true,
      };
    }

    let htmlPath = params.html_path?.trim() ? expandPath(params.html_path.trim(), ctx.workspaceRoot) : '';
    let tempHtml: string | null = null;
    if (!htmlPath) {
      const inline = params.html?.trim();
      if (!inline) {
        return { output: 'Error: provide html_path or html', isError: true };
      }
      tempHtml = path.join(os.tmpdir(), `bandit-render-${Date.now()}.html`);
      await fs.promises.writeFile(tempHtml, inline, 'utf-8');
      htmlPath = tempHtml;
    }
    if (!fs.existsSync(htmlPath)) {
      return { output: `HTML not found: ${htmlPath}`, isError: true };
    }

    const outPath = params.out?.trim()
      ? expandPath(params.out.trim(), ctx.workspaceRoot)
      : htmlPath.replace(/\.html?$/i, '') + '.pdf';
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

    const fileUrl = `file://${htmlPath}`;
    const { code, stderr } = runChromium(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${outPath}`,
      fileUrl,
    ]);

    if (tempHtml) {
      try { await fs.promises.unlink(tempHtml); } catch { /* ignore */ }
    }

    if (code !== 0 || !fs.existsSync(outPath)) {
      return {
        output: `Chrome PDF render failed (exit ${code}): ${stderr || 'no output file'}`,
        isError: true,
      };
    }
    const stat = await fs.promises.stat(outPath);
    return {
      output: `Wrote PDF ${outPath} (${stat.size} bytes). Next: preview_pdf(path=…) to visual-QA, then publish_artifact if needed.`,
      isError: false,
    };
  }
};
