import { describe, expect, it } from 'vitest';
import { sanitizeModelOutput, stripBase64Blobs } from '../src/sanitize';

describe('stripBase64Blobs', () => {
  it('replaces a long base64 blob with a marker', () => {
    const blob = 'data:image/png;base64,' + 'A'.repeat(200);
    const out = stripBase64Blobs(`here is an image: ${blob} and more text`);
    expect(out).toContain('[base64 stripped:');
    expect(out).not.toContain('data:image/png;base64,');
  });

  it('leaves short base64-like strings alone', () => {
    const short = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; // 64 chars
    expect(stripBase64Blobs(short)).toBe(short);
  });
});

describe('sanitizeModelOutput', () => {
  it('returns empty string for null/undefined/empty input', () => {
    expect(sanitizeModelOutput(null)).toBe('');
    expect(sanitizeModelOutput(undefined)).toBe('');
    expect(sanitizeModelOutput('')).toBe('');
  });

  it('strips control tokens', () => {
    const input = '<|im_start|>userhello<|start_of_turn|>assistant<|end_of_turn|>';
    expect(sanitizeModelOutput(input)).toBe('userhelloassistant');
  });

  it('converts inline HTML to markdown', () => {
    const input = '<p>Hello <code>world</code></p><p><strong>bold</strong> and <em>italic</em></p>';
    const out = sanitizeModelOutput(input);
    expect(out).toContain('`world`');
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
  });

  it('strips tool_call blocks entirely', () => {
    const input = 'before<tool_call>{"name":"apply_edit"}</tool_call>after';
    expect(sanitizeModelOutput(input)).toBe('beforeafter');
  });

  it('strips trailing partial tag starters', () => {
    expect(sanitizeModelOutput('hello<tool_ca')).toBe('hello');
  });

  it('removes Gemma leading angle artifact while preserving blockquotes', () => {
    expect(sanitizeModelOutput('>Okay sure')).toBe('Okay sure');
    expect(sanitizeModelOutput('> quoted text')).toBe('> quoted text');
  });

  it('removes role prefixes', () => {
    expect(sanitizeModelOutput('user: hello')).toBe('hello');
    expect(sanitizeModelOutput('assistant: world')).toBe('world');
  });
});
