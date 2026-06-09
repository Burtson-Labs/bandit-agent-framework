/**
 * Regression: code EXAMPLES the model demonstrates must not be parsed as tool
 * calls. The weak fallbacks (bare-JSON, pythonic) used to fire on fenced code —
 * a Python `print("…")` became a phantom `print` tool call and the loop errored
 * on an unknown tool. The fix masks fenced code before the fallbacks run.
 *
 * The canonical forms (`<tool_call>`, ```tool_call) and out-of-fence recovery
 * must still work, so those are pinned here too.
 */
import { describe, expect, it } from 'vitest';
import { parseToolCalls, hasToolCalls } from '../src/tools/tool-use-parser';

describe('tool-call parsing vs. fenced code examples', () => {
  it('does NOT treat print() inside a python fence as a tool call', () => {
    const text = [
      'Here is a quick Python example:',
      '',
      '```python',
      'def main():',
      '    print("Task List")',
      '    foo(["a", "b"])',
      'main()',
      '```',
      '',
      'That prints a list.'
    ].join('\n');
    expect(parseToolCalls(text)).toEqual([]);
    expect(hasToolCalls(text)).toBe(false);
  });

  it('does NOT treat a JSON snippet inside a fence as a tool call', () => {
    const text = '```json\n{"name":"alice","arguments":{"role":"admin"}}\n```';
    expect(parseToolCalls(text)).toEqual([]);
    expect(hasToolCalls(text)).toBe(false);
  });

  it('still parses a canonical <tool_call> even when prose has code fences', () => {
    const text = [
      'Sure, here is how `print` works:',
      '```python',
      'print("hi")',
      '```',
      'Now reading the file:',
      '<tool_call>{"name":"read_file","params":{"path":"src/x.ts"}}</tool_call>'
    ].join('\n');
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].params.path).toBe('src/x.ts');
  });

  it('still recovers a pythonic tool call that is NOT inside a fence', () => {
    // key=value form (the parenless pythonic shape the parser supports).
    const calls = parseToolCalls('read_file path="src/x.ts"');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].params.path).toBe('src/x.ts');
  });
});
