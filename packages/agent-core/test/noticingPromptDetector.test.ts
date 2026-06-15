/**
 * Detector contract: isNoticingPrompt + the runtime emit.
 *
 * Noticing prompts are user messages that point at a possible gap from
 * a prior turn ("are we using these?", "did you remember X?", "where's
 * the import?") rather than requesting new work. The detector trips
 * a one-time synthetic user-role hint into the loop's message stream
 * so the model addresses the gap before continuing the prior plan.
 *
 * Captured 2026-05-25 on a local React refactor where the model
 * read the user's question as a generic "keep going" prompt and wrote
 * 5 more new files without ever wiring App.jsx to consume them.
 */
import { describe, expect, it } from 'vitest';
import { isNoticingPrompt, ToolRegistry, ToolUseLoop } from '../src/index';
import { testCtx, buildMockChat, buildEmitRecorder } from './_helpers';

describe('isNoticingPrompt classifier', () => {
  it('matches "are we using these?"', () => {
    expect(isNoticingPrompt("I dont think we actually are using these new files are we?")).toBe(true);
  });

  it('matches "did you remember to update App.jsx?"', () => {
    expect(isNoticingPrompt('did you remember to update App.jsx?')).toBe(true);
  });

  it('matches "isn\'t this missing the import?"', () => {
    expect(isNoticingPrompt("isn't this missing the import?")).toBe(true);
  });

  it('matches "shouldn\'t we wire it up?"', () => {
    expect(isNoticingPrompt("shouldn't we wire it up to the parent?")).toBe(true);
  });

  it('matches "where\'s the integration step?"', () => {
    expect(isNoticingPrompt("where's the integration step?")).toBe(true);
  });

  it('matches "what about App.jsx?"', () => {
    expect(isNoticingPrompt('what about App.jsx?')).toBe(true);
  });

  it('matches "wait — what about the data wiring?"', () => {
    expect(isNoticingPrompt('wait — what about the data wiring?')).toBe(true);
  });

  it('matches "this doesn\'t look right" (concern modal, no question mark)', () => {
    expect(isNoticingPrompt("this doesn't look right — App.jsx is missing the imports")).toBe(true);
  });

  it('does NOT match a fresh feature request ("add a new component")', () => {
    expect(isNoticingPrompt('add a new component for the Hero section')).toBe(false);
  });

  it('does NOT match a continuation prompt ("keep going")', () => {
    expect(isNoticingPrompt('keep going')).toBe(false);
  });

  it('does NOT match an empty prompt', () => {
    expect(isNoticingPrompt('')).toBe(false);
    expect(isNoticingPrompt('   ')).toBe(false);
  });

  it('does NOT match long prompts (>220 chars) — those are real requests, not noticing questions', () => {
    const long = 'are we ' + 'x'.repeat(300) + '?';
    expect(isNoticingPrompt(long)).toBe(false);
  });

  it('does NOT match an "are we" in the middle of a sentence', () => {
    expect(isNoticingPrompt('I want to know whether are we still on track')).toBe(false);
  });

  it('does NOT match without a question mark OR concern modal', () => {
    // Stem matches but no '?' and no concern verb → not a noticing prompt
    expect(isNoticingPrompt('are we proceeding')).toBe(false);
  });
});

describe('loop emits tool_loop:noticing_prompt_hint on a noticing prompt', () => {
  it('emits + injects the synthetic hint into messages', async () => {
    const registry = new ToolRegistry();
    const { chat, recorder } = buildMockChat(() => 'Final answer: yes, App.jsx imports them.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 2 });

    await loop.run('I dont think we actually are using these new files are we?', chat);

    const fires = events.filter((e) => e.type === 'tool_loop:noticing_prompt_hint');
    expect(fires.length).toBe(1);

    // The first chat call's messages should include the synthetic hint
    // right after the user's original prompt.
    const firstCallMessages = recorder.calls[0].messages;
    const userMessages = firstCallMessages.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    const hint = userMessages[userMessages.length - 1].content;
    expect(hint).toMatch(/noticing|clarifying|identify what gap/i);
  });

  it('does NOT emit on a normal feature-request prompt', async () => {
    const registry = new ToolRegistry();
    const { chat } = buildMockChat(() => 'Done.');
    const { events, emit } = buildEmitRecorder();
    const loop = new ToolUseLoop(registry, testCtx, { emitEvent: emit, maxIterations: 2 });

    await loop.run('add a new Hero component to the site', chat);

    const fires = events.filter((e) => e.type === 'tool_loop:noticing_prompt_hint');
    expect(fires.length).toBe(0);
  });
});
