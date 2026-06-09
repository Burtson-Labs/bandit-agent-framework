/**
 * Tests for the live plan dock's checklist renderer — the styled tree
 * the spinner paints above its status line during a turn (v1.7.341).
 *
 * Only the pure row-builder is unit-tested here; the multi-line in-place
 * repaint + cursor math needs a real TTY and is verified by hand. We
 * pin: one row per item, the collapse summary past the visible cap, and
 * width truncation (so the dock never wraps and desyncs the row count).
 */
import { describe, expect, it } from 'vitest';
import { renderTodoTree, type DockTodo } from '../src/spinner';

// Strip SGR color codes so assertions read against the visible text.
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderTodoTree', () => {
  it('returns no rows for an empty plan', () => {
    expect(renderTodoTree([], 80)).toEqual([]);
  });

  it('renders one row per item with status glyphs', () => {
    const items: DockTodo[] = [
      { status: 'done', content: 'first' },
      { status: 'in_progress', content: 'second' },
      { status: 'pending', content: 'third' }
    ];
    const rows = renderTodoTree(items, 80).map(plain);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('✓');
    expect(rows[0]).toContain('first');
    expect(rows[1]).toContain('▪');
    expect(rows[1]).toContain('second');
    expect(rows[2]).toContain('☐');
    expect(rows[2]).toContain('third');
  });

  it('collapses items past the visible cap into a summary line', () => {
    const items: DockTodo[] = Array.from({ length: 9 }, (_, i) => ({
      status: i === 0 ? 'done' : 'pending',
      content: `item ${i + 1}`
    }));
    const rows = renderTodoTree(items, 80).map(plain);
    // 6 shown + 1 collapse line.
    expect(rows).toHaveLength(7);
    // The 3 hidden items (indices 6,7,8) are all pending.
    expect(rows[6]).toContain('… +3 pending');
  });

  it('truncates each row to the terminal width so it cannot wrap', () => {
    const long = 'x'.repeat(500);
    const rows = renderTodoTree([{ status: 'pending', content: long }], 40);
    expect(plain(rows[0]).length).toBeLessThanOrEqual(40);
    expect(plain(rows[0])).toContain('…');
  });
});
