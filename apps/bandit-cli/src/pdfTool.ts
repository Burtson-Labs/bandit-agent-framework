/**
 * PDF text extraction tool for the CLI host.
 *
 * Uses `pdf-parse` (which wraps Mozilla's pdfjs-dist) so it works without
 * external binaries on macOS, Linux, and Windows. The extension can wire
 * its own PDF reader later — keeping this in the CLI package means
 * agent-core stays host-agnostic and doesn't gain a pdf-parse dep.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool, ToolExecutionContext, ToolResult } from '@burtson-labs/agent-core';

const MAX_OUTPUT_CHARS = 32 * 1024;  // 32 KB of extracted text
const MAX_PDF_BYTES = 20 * 1024 * 1024;  // 20 MB cap so huge scans don't OOM

export const pdfReadTool: AgentTool = {
  name: 'read_pdf',
  description: 'Extract the readable text content of a PDF file. Returns the text with page breaks. Works with text-based PDFs; scanned/image-only PDFs will return little or no text (OCR not performed).',
  parameters: [
    { name: 'path', description: 'Path to the PDF file. Accepts absolute paths, tilde-prefixed paths (~/Desktop/foo.pdf), or paths relative to the workspace root.', required: true }
  ],
  async execute(params: Record<string, string>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = params.path?.trim();
    if (!raw) return { output: 'Error: path parameter is required', isError: true };

    const expanded = raw.startsWith('~')
      ? raw.replace(/^~/, process.env.HOME ?? '')
      : raw;
    const absPath = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(ctx.workspaceRoot, expanded);

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
        return { output: `Extracted 0 characters from ${raw} (${pageCount} pages). This is likely an image-only / scanned PDF — OCR is not performed.`, isError: true };
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
