/**
 * Contract tests for `applyCompactionIfNeeded` — the per-iteration
 * compaction trigger extracted from ToolUseLoop.runWithMessages (Arc 3
 * Session 2).
 *
 * Tests pin: budget guard short-circuits, the >=25% drop OR >=10k
 * absolute aggressive thresholds, in-place mutation, and the
 * `tool_loop:compacted` event payload shape. A break here means the
 * goal-anchor block downstream will get the wrong `aggressive` signal
 * and either miss a needed re-anchor or fire unnecessary ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyCompactionIfNeeded } from '../src/tools/loop/compactionTrigger';
import * as compactModule from '../src/tools/compactMessages';
import type { ToolLoopMessage } from '../src/index';
import { buildEmitRecorder } from './_helpers';

function u(content: string): ToolLoopMessage { return { role: 'user', content }; }
function a(content: string): ToolLoopMessage { return { role: 'assistant', content }; }

describe('applyCompactionIfNeeded — budget guards', () => {
  it('returns aggressive=false and runs no work when tokenBudget is undefined', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages');
    const { emit, events } = buildEmitRecorder();
    const messages = [u('hi'), a('hello')];
    const before = [...messages];
    const result = applyCompactionIfNeeded({ messages, tokenBudget: undefined, emit, iteration: 0 });
    expect(result.aggressive).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(messages).toEqual(before);
    expect(events).toEqual([]);
    spy.mockRestore();
  });

  it('returns aggressive=false when tokenBudget is 0', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages');
    const { emit } = buildEmitRecorder();
    const result = applyCompactionIfNeeded({ messages: [u('x')], tokenBudget: 0, emit, iteration: 0 });
    expect(result.aggressive).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns aggressive=false when tokenBudget is Infinity (disable signal)', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages');
    const { emit } = buildEmitRecorder();
    const result = applyCompactionIfNeeded({ messages: [u('x')], tokenBudget: Infinity, emit, iteration: 0 });
    expect(result.aggressive).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('applyCompactionIfNeeded — no-op when nothing to compact', () => {
  it('returns aggressive=false and emits no event when the report shows zero compacted', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages').mockReturnValue({
      compacted: [u('unchanged')],
      messagesCompacted: 0,
      beforeTokens: 100,
      afterTokens: 100
    });
    const { emit, events } = buildEmitRecorder();
    const messages = [u('unchanged')];
    const result = applyCompactionIfNeeded({ messages, tokenBudget: 12000, emit, iteration: 4 });
    expect(result.aggressive).toBe(false);
    expect(events).toEqual([]);
    expect(messages).toEqual([u('unchanged')]);
    spy.mockRestore();
  });
});

describe('applyCompactionIfNeeded — aggressive thresholds', () => {
  it('aggressive=true when drop ratio meets the 25% threshold', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages').mockReturnValue({
      compacted: [u('small')],
      messagesCompacted: 3,
      beforeTokens: 10_000,
      afterTokens: 7_500 // exactly 25% drop
    });
    const { emit } = buildEmitRecorder();
    const result = applyCompactionIfNeeded({ messages: [u('big')], tokenBudget: 5_000, emit, iteration: 2 });
    expect(result.aggressive).toBe(true);
    spy.mockRestore();
  });

  it('aggressive=false when drop ratio is below 25% AND drop absolute is below 10k', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages').mockReturnValue({
      compacted: [u('small')],
      messagesCompacted: 1,
      beforeTokens: 10_000,
      afterTokens: 8_000 // 20% drop, 2000 absolute — both under thresholds
    });
    const { emit } = buildEmitRecorder();
    const result = applyCompactionIfNeeded({ messages: [u('big')], tokenBudget: 5_000, emit, iteration: 0 });
    expect(result.aggressive).toBe(false);
    spy.mockRestore();
  });

  it('aggressive=true when drop absolute meets the 10k threshold (even at low ratio)', () => {
    // The 81k→71k case (7% ratio but 10k absolute) — exactly the failure
    // mode the absolute threshold was lowered to catch.
    const spy = vi.spyOn(compactModule, 'compactToolMessages').mockReturnValue({
      compacted: [u('small')],
      messagesCompacted: 5,
      beforeTokens: 81_000,
      afterTokens: 71_000 // 12.3% drop, 10k absolute
    });
    const { emit } = buildEmitRecorder();
    const result = applyCompactionIfNeeded({ messages: [u('big')], tokenBudget: 70_000, emit, iteration: 0 });
    expect(result.aggressive).toBe(true);
    spy.mockRestore();
  });
});

describe('applyCompactionIfNeeded — emit + in-place mutation', () => {
  it('emits tool_loop:compacted with the report fields and the iteration tag', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages').mockReturnValue({
      compacted: [u('compacted-one'), u('compacted-two')],
      messagesCompacted: 2,
      beforeTokens: 5000,
      afterTokens: 1000
    });
    const { emit, events } = buildEmitRecorder();
    applyCompactionIfNeeded({ messages: [u('orig')], tokenBudget: 1000, emit, iteration: 7 });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool_loop:compacted',
      payload: {
        iteration: 7,
        messagesCompacted: 2,
        beforeTokens: 5000,
        afterTokens: 1000
      }
    });
    spy.mockRestore();
  });

  it('replaces messages in place (same array identity, new contents)', () => {
    const spy = vi.spyOn(compactModule, 'compactToolMessages').mockReturnValue({
      compacted: [u('compacted-only')],
      messagesCompacted: 1,
      beforeTokens: 5000,
      afterTokens: 100
    });
    const { emit } = buildEmitRecorder();
    const messages = [u('orig-one'), a('orig-two'), u('orig-three')];
    const originalRef = messages;
    applyCompactionIfNeeded({ messages, tokenBudget: 1000, emit, iteration: 0 });
    expect(messages).toBe(originalRef); // same array identity preserved
    expect(messages).toEqual([u('compacted-only')]); // but contents swapped
    spy.mockRestore();
  });
});
