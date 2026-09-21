import { describe, expect, it } from 'vitest';
import { isBinaryArtifact } from '../src/tools/getArtifactTool';

// The RWT session (2026-09-19): get_artifact on a PDF told the model to
// "revise it with TARGETED edits" — advice that cannot apply to bytes — and
// the model rebuilt the document from plain text, losing the design.
describe('isBinaryArtifact', () => {
  it('treats PDFs and images as bytes, by type or by name', () => {
    expect(isBinaryArtifact('application/pdf', 'x')).toBe(true);
    expect(isBinaryArtifact('application/octet-stream', 'RWT-Proposal-Draft-2026-09-19.pdf')).toBe(true);
    expect(isBinaryArtifact(undefined, 'cover.png')).toBe(true);
    expect(isBinaryArtifact('image/svg+xml', 'diagram.svg')).toBe(true);
  });

  it('keeps HTML, markdown and JSON as documents', () => {
    expect(isBinaryArtifact('text/html; charset=utf-8', 'briefing.html')).toBe(false);
    expect(isBinaryArtifact('text/markdown', 'notes.md')).toBe(false);
    expect(isBinaryArtifact('application/json', 'data.json')).toBe(false);
  });
});
