/**
 * Arc W4-S2 — contract tests for the Session 2 topic dispatchers
 * (planMessages, diffMessages, permissionMessages, audioMessages,
 * composerAttachmentMessages).
 *
 * Same pattern as W4-S1: pure `(message, deps): boolean`, tests pin
 * wire-message → deps-call mapping + the false-return fall-through.
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatchAudioMessage } from '../../src/messageDispatch/audioMessages';
import { dispatchComposerAttachmentMessage } from '../../src/messageDispatch/composerAttachmentMessages';
import { dispatchDiffMessage } from '../../src/messageDispatch/diffMessages';
import { dispatchPermissionMessage } from '../../src/messageDispatch/permissionMessages';
import { dispatchPlanMessage } from '../../src/messageDispatch/planMessages';

const stubEvent = { type: 'telemetry', timestamp: 0, payload: {} } as const;

// ─── planMessages ──────────────────────────────────────────────────
describe('dispatchPlanMessage', () => {
  const mkDeps = () => ({
    handleAgentPlan: vi.fn(),
    handleAgentPlanUpdate: vi.fn(),
    handleAgentPlanHistory: vi.fn(),
    resetForFreshPlan: vi.fn(),
    setGoalFileHints: vi.fn(),
    buildAndAppendTelemetryEvent: vi.fn(() => stubEvent),
    appendEvents: vi.fn()
  });

  it('agentPlan triggers resetForFreshPlan BEFORE handleAgentPlan (ticker/events clear first)', () => {
    const deps = mkDeps();
    let resetTime = 0;
    let handleTime = 0;
    let counter = 0;
    deps.resetForFreshPlan.mockImplementation(() => {
      resetTime = ++counter;
    });
    deps.handleAgentPlan.mockImplementation(() => {
      handleTime = ++counter;
    });
    dispatchPlanMessage({ type: 'agentPlan', plan: null } as never, deps);
    expect(resetTime).toBeLessThan(handleTime);
  });

  it('agentPlanUpdate → handleAgentPlanUpdate(message)', () => {
    const deps = mkDeps();
    const msg = { type: 'agentPlanUpdate', stepId: 's1' };
    dispatchPlanMessage(msg as never, deps);
    expect(deps.handleAgentPlanUpdate).toHaveBeenCalledWith(msg);
  });

  it('agentPlanHistory → handleAgentPlanHistory(message)', () => {
    const deps = mkDeps();
    const msg = { type: 'agentPlanHistory', history: [{ id: 'r1' }] };
    dispatchPlanMessage(msg as never, deps);
    expect(deps.handleAgentPlanHistory).toHaveBeenCalledWith(msg);
  });

  it('agentTelemetry (non-goal-inference) appends a telemetry event without touching goalFileHints', () => {
    const deps = mkDeps();
    dispatchPlanMessage(
      { type: 'agentTelemetry', telemetry: { kind: 'metrics' } } as never,
      deps
    );
    expect(deps.setGoalFileHints).not.toHaveBeenCalled();
    expect(deps.appendEvents).toHaveBeenCalledWith(stubEvent);
  });

  it('agentTelemetry (goal-inference) with files sets a hints record', () => {
    const deps = mkDeps();
    dispatchPlanMessage(
      {
        type: 'agentTelemetry',
        telemetry: { kind: 'goal-inference', goal: { files: ['a', 'b'], intent: 'fix' } }
      } as never,
      deps
    );
    expect(deps.setGoalFileHints).toHaveBeenCalledWith({ files: ['a', 'b'], intent: 'fix' });
  });

  it('agentTelemetry (goal-inference) with intent but no files sets hints to { files: [], intent }', () => {
    const deps = mkDeps();
    dispatchPlanMessage(
      {
        type: 'agentTelemetry',
        telemetry: { kind: 'goal-inference', goal: { intent: 'analyze' } }
      } as never,
      deps
    );
    expect(deps.setGoalFileHints).toHaveBeenCalledWith({ files: [], intent: 'analyze' });
  });

  it('agentTelemetry (goal-inference) with neither files nor intent clears hints to null', () => {
    const deps = mkDeps();
    dispatchPlanMessage(
      { type: 'agentTelemetry', telemetry: { kind: 'goal-inference', goal: {} } } as never,
      deps
    );
    expect(deps.setGoalFileHints).toHaveBeenCalledWith(null);
  });

  it('returns false for an unrelated type', () => {
    expect(dispatchPlanMessage({ type: 'state' } as never, mkDeps())).toBe(false);
  });
});

// ─── diffMessages ──────────────────────────────────────────────────
describe('dispatchDiffMessage', () => {
  const mkDeps = () => ({
    handleDiffSnapshot: vi.fn(),
    handleDiffPreviewCard: vi.fn(),
    handleDiffPreviewResult: vi.fn(),
    handleDiffPreviewClear: vi.fn(),
    buildDiffSnapshotEvent: vi.fn(() => stubEvent),
    appendEvents: vi.fn(),
    setDiffStreamStatus: vi.fn()
  });

  it('agent:diffSnapshot appends a snapshot event AND forwards to handleDiffSnapshot', () => {
    const deps = mkDeps();
    dispatchDiffMessage(
      { type: 'agent:diffSnapshot', path: 'src/foo.ts', diff: '@@' } as never,
      deps
    );
    expect(deps.appendEvents).toHaveBeenCalledWith(stubEvent);
    expect(deps.handleDiffSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/foo.ts', diff: '@@' })
    );
  });

  it('agent:diffStream start: setDiffStreamStatus({ path, chars: 0 })', () => {
    const deps = mkDeps();
    dispatchDiffMessage(
      { type: 'agent:diffStream', kind: 'start', path: 'src/foo.ts' } as never,
      deps
    );
    expect(deps.setDiffStreamStatus).toHaveBeenCalledWith({
      path: 'src/foo.ts',
      chars: 0
    });
  });

  it('agent:diffStream progress: accumulates chars via the updater closure', () => {
    const deps = mkDeps();
    dispatchDiffMessage(
      {
        type: 'agent:diffStream',
        kind: 'progress',
        path: 'src/foo.ts',
        content: 'hello'
      } as never,
      deps
    );
    const updater = (deps.setDiffStreamStatus.mock.calls[0][0] as Function);
    expect(updater({ path: 'src/foo.ts', chars: 10 })).toEqual({
      path: 'src/foo.ts',
      chars: 15
    });
    expect(updater(null)).toEqual({ path: 'src/foo.ts', chars: 5 });
  });

  it('agent:diffStream complete clears the indicator', () => {
    const deps = mkDeps();
    dispatchDiffMessage(
      { type: 'agent:diffStream', kind: 'complete', path: 'src/foo.ts' } as never,
      deps
    );
    expect(deps.setDiffStreamStatus).toHaveBeenCalledWith(null);
  });

  it('diffPreviewCard / diffPreviewResult / diffPreviewClear delegate to the matching hook actions', () => {
    const deps = mkDeps();
    dispatchDiffMessage(
      { type: 'diffPreviewCard', preview: { path: 'src/foo.ts' } } as never,
      deps
    );
    dispatchDiffMessage(
      { type: 'diffPreviewResult', path: 'src/foo.ts', status: 'apply' } as never,
      deps
    );
    dispatchDiffMessage({ type: 'diffPreviewClear' } as never, deps);
    expect(deps.handleDiffPreviewCard).toHaveBeenCalledWith({ path: 'src/foo.ts' });
    expect(deps.handleDiffPreviewResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'apply' })
    );
    expect(deps.handleDiffPreviewClear).toHaveBeenCalled();
  });

  it('returns false for an unrelated type', () => {
    expect(dispatchDiffMessage({ type: 'state' } as never, mkDeps())).toBe(false);
  });
});

// ─── permissionMessages ────────────────────────────────────────────
describe('dispatchPermissionMessage', () => {
  const mkDeps = () => ({
    enqueueApproval: vi.fn(),
    resolveApproval: vi.fn(),
    requestAskUser: vi.fn()
  });

  it('permissionRequest → enqueueApproval(message)', () => {
    const deps = mkDeps();
    const msg = { type: 'permissionRequest', id: 'p1', tool: 'read_file', primary: '', description: '' };
    dispatchPermissionMessage(msg as never, deps);
    expect(deps.enqueueApproval).toHaveBeenCalledWith(msg);
  });

  it('permissionResolved → resolveApproval(id)', () => {
    const deps = mkDeps();
    dispatchPermissionMessage(
      { type: 'permissionResolved', id: 'p1' } as never,
      deps
    );
    expect(deps.resolveApproval).toHaveBeenCalledWith('p1');
  });

  it('userInputRequest → requestAskUser(id, questions)', () => {
    const deps = mkDeps();
    dispatchPermissionMessage(
      { type: 'userInputRequest', id: 'q1', questions: [{ id: 'a', question: 'why' }] } as never,
      deps
    );
    expect(deps.requestAskUser).toHaveBeenCalledWith('q1', [{ id: 'a', question: 'why' }]);
  });

  it('returns false for unrelated types', () => {
    expect(dispatchPermissionMessage({ type: 'state' } as never, mkDeps())).toBe(false);
  });
});

// ─── audioMessages ─────────────────────────────────────────────────
describe('dispatchAudioMessage', () => {
  const mkDeps = () => ({
    handlePlayAudio: vi.fn(),
    handleAudioError: vi.fn()
  });

  it('playAudio → handlePlayAudio(message)', () => {
    const deps = mkDeps();
    const msg = { type: 'playAudio', entryId: 'm1', mimeType: 'audio/mpeg', audioBase64: 'abc' };
    dispatchAudioMessage(msg as never, deps);
    expect(deps.handlePlayAudio).toHaveBeenCalledWith(msg);
  });

  it('audioError → handleAudioError(message)', () => {
    const deps = mkDeps();
    dispatchAudioMessage(
      { type: 'audioError', entryId: 'm1', message: 'cant decode' } as never,
      mkDeps()
    );
    // Call again with the captured deps so we can assert:
    dispatchAudioMessage(
      { type: 'audioError', entryId: 'm1', message: 'cant decode' } as never,
      deps
    );
    expect(deps.handleAudioError).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'm1', message: 'cant decode' })
    );
  });

  it('returns false for unrelated types', () => {
    expect(dispatchAudioMessage({ type: 'state' } as never, mkDeps())).toBe(false);
  });
});

// ─── composerAttachmentMessages ────────────────────────────────────
describe('dispatchComposerAttachmentMessage', () => {
  const mkDeps = () => ({
    setContextFiles: vi.fn(),
    setImageAttachments: vi.fn(),
    updateToast: vi.fn(),
    contextFileLimit: 5,
    maxImageAttachments: 4
  });

  it('contextFilesAdded: dedup-by-path append, surfaces a limit toast at the cap', () => {
    const deps = mkDeps();
    dispatchComposerAttachmentMessage(
      {
        type: 'contextFilesAdded',
        files: [
          { path: 'a' },
          { path: 'b' },
          { path: 'a' }, // dup
          { path: 'c' },
          { path: 'd' },
          { path: 'e' },
          { path: 'f' } // over the 5-cap
        ]
      } as never,
      deps
    );
    const updater = deps.setContextFiles.mock.calls[0][0] as Function;
    const next = updater([]);
    expect(next.map((f: { path: string }) => f.path)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(deps.updateToast).toHaveBeenCalledWith('You can attach up to 5 files.');
  });

  it('contextFilesAdded with an empty array is accepted (returns true) but does not call setContextFiles', () => {
    const deps = mkDeps();
    const handled = dispatchComposerAttachmentMessage(
      { type: 'contextFilesAdded', files: [] } as never,
      deps
    );
    expect(handled).toBe(true);
    expect(deps.setContextFiles).not.toHaveBeenCalled();
  });

  it('imageAttachmentsAdded trims + dedups whitespace-only entries and surfaces the limit toast at the cap', () => {
    const deps = mkDeps();
    dispatchComposerAttachmentMessage(
      {
        type: 'imageAttachmentsAdded',
        images: ['data:a', '   ', 'data:b', '', 'data:c', 'data:d', 'data:e']
      } as never,
      deps
    );
    const updater = deps.setImageAttachments.mock.calls[0][0] as Function;
    const next = updater([]);
    expect(next).toEqual(['data:a', 'data:b', 'data:c', 'data:d']);
    expect(deps.updateToast).toHaveBeenCalledWith('You can attach up to 4 images.');
  });

  it('returns false for unrelated types', () => {
    expect(
      dispatchComposerAttachmentMessage({ type: 'state' } as never, mkDeps())
    ).toBe(false);
  });
});
