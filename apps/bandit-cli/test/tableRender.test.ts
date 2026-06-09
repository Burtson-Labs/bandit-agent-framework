import { describe, it, expect } from 'vitest';
import {
  parseTableSeparator,
  splitTableRow,
  visibleLength,
  padCell,
  renderTable,
  renderTableAsDefinitionList,
  consumeTablesInChunk,
  flushTableState,
  type ParsedTable
} from '../src/terminal/tableRender';
import { createStreamStrippingState } from '../src/streaming/streamStripping';

describe('parseTableSeparator', () => {
  it('returns alignment array for a 2-col left/right separator', () => {
    expect(parseTableSeparator('| --- | ---: |')).toEqual(['left', 'right']);
  });

  it('detects center alignment from :---:', () => {
    expect(parseTableSeparator('| :---: | :---: |')).toEqual(['center', 'center']);
  });

  it('returns null for a non-separator line', () => {
    expect(parseTableSeparator('| col1 | col2 |')).toBeNull();
    expect(parseTableSeparator('plain text')).toBeNull();
  });
});

describe('splitTableRow', () => {
  it('splits a pipe-bounded row into trimmed cells', () => {
    expect(splitTableRow('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('handles rows without bounding pipes', () => {
    expect(splitTableRow('a | b | c')).toEqual(['a', 'b', 'c']);
  });
});

describe('visibleLength', () => {
  it('strips ANSI CSI sequences when measuring width', () => {
    // The regex strips bracketed-CSI-like sequences (`[31m`, `[0m`),
    // matching what the rest of the pipeline emits after the ESC byte
    // has been consumed upstream.
    expect(visibleLength('[31mred[0m')).toBe(3);
  });

  it('strips inline markdown markup before measuring (backticks, bold)', () => {
    expect(visibleLength('`code`')).toBe(4);
    expect(visibleLength('**bold**')).toBe(4);
  });

  it('counts wide chars (CJK / fullwidth) as 2 columns', () => {
    expect(visibleLength('漢字')).toBe(4);
  });

  it('skips variation selector U+FE0F when counting', () => {
    // ⭐ (U+2B50) followed by FE0F is one star emoji. The base is in the
    // misc-symbols range we treat as width 2; the selector adds 0.
    expect(visibleLength('⭐️')).toBe(2);
  });
});

describe('padCell', () => {
  it('left-aligns by default (text + padding)', () => {
    expect(padCell('hi', 5, 'left')).toBe('hi   ');
  });

  it('right-aligns (padding + text)', () => {
    expect(padCell('hi', 5, 'right')).toBe('   hi');
  });

  it('center-aligns with leftover on the right', () => {
    expect(padCell('hi', 5, 'center')).toBe(' hi  ');
  });
});

describe('renderTable — box-drawing path', () => {
  it('renders a basic 2-col table with header bold and box-drawing borders', () => {
    const parsed: ParsedTable = {
      align: ['left', 'left'],
      rows: [
        ['Col1', 'Col2'],
        ['a', 'b']
      ]
    };
    const out = renderTable(parsed);
    // box-drawing chars present
    expect(out).toContain('┌');
    expect(out).toContain('┬');
    expect(out).toContain('┐');
    expect(out).toContain('├');
    expect(out).toContain('┼');
    expect(out).toContain('┤');
    expect(out).toContain('└');
    expect(out).toContain('┴');
    expect(out).toContain('┘');
    // body row content present
    expect(out).toContain('a');
    expect(out).toContain('b');
    // header still present
    expect(out).toContain('Col1');
    expect(out).toContain('Col2');
  });

  it('falls back to definition-list when total width would exceed the terminal', () => {
    // Width-gate clamps the terminal floor to 40, so the table must
    // exceed 40 visible columns (cells + overhead) to trigger the
    // definition-list fallback regardless of the actual terminal.
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 20, configurable: true });
    try {
      const longA = 'A'.repeat(30);
      const longB = 'B'.repeat(30);
      const parsed: ParsedTable = {
        align: ['left', 'left'],
        rows: [
          [longA, longB],
          ['body1', 'body2']
        ]
      };
      const out = renderTable(parsed);
      // definition-list output uses a colon separator, no box drawing.
      expect(out).not.toContain('┌');
      expect(out).toContain(':');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: original, configurable: true });
    }
  });
});

describe('renderTableAsDefinitionList', () => {
  it('emits one bold label + value per cell for each body row', () => {
    const out = renderTableAsDefinitionList(
      [
        ['Name', 'Age'],
        ['Alice', '30'],
        ['Bob', '25']
      ],
      2
    );
    expect(out).toContain('Name');
    expect(out).toContain('Alice');
    expect(out).toContain('Bob');
    expect(out).toContain('30');
    expect(out).toContain('25');
  });

  it('emits only the header (joined by ·) when there are no body rows', () => {
    const out = renderTableAsDefinitionList([['A', 'B']], 2);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('·');
  });
});

describe('consumeTablesInChunk — streaming detection', () => {
  it('renders a table once header + separator + body arrive in one chunk', () => {
    const state = createStreamStrippingState();
    const out = consumeTablesInChunk(
      state,
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n'
    );
    expect(out).toContain('┌');
    expect(out).toContain('1');
    expect(out).toContain('2');
  });

  it('defers a header row whose separator has not arrived yet', () => {
    const state = createStreamStrippingState();
    const out1 = consumeTablesInChunk(state, '| A | B |\n');
    // No table emitted yet — the header is in the buffer waiting for
    // the separator confirmation on the next chunk.
    expect(out1).toBe('');
    const out2 = consumeTablesInChunk(state, '| --- | --- |\n| 1 | 2 |\n\n');
    expect(out2).toContain('┌');
  });

  it('passes plain prose through without buffering', () => {
    const state = createStreamStrippingState();
    const out = consumeTablesInChunk(state, 'plain prose line\n');
    expect(out).toBe('plain prose line\n');
  });

  it('does not box markdown source inside a ```markdown code fence', () => {
    const state = createStreamStrippingState();
    const out = consumeTablesInChunk(
      state,
      '```markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n'
    );
    // Inside the fence, pipe-rows are passed through verbatim — no box.
    expect(out).not.toContain('┌');
    expect(out).toContain('| A | B |');
  });
});

describe('flushTableState — end of stream', () => {
  it('drains an in-flight table when the stream closes without a closing line', () => {
    const state = createStreamStrippingState();
    consumeTablesInChunk(state, '| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    const tail = flushTableState(state);
    // Final row was the last line of the stream; flush emits the
    // rendered table from the stashed lines.
    expect(tail).toContain('┌');
    expect(tail).toContain('1');
  });
});
