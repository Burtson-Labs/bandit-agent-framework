/**
 * Arc W4-S1 — contract tests for the Session 1 topic dispatchers.
 *
 * Each dispatcher is a pure function with the shape
 * `(message, deps): boolean`. Tests cover:
 * - the return-value contract (true when handled, false when not — so
 *   the routing chain in App.tsx can fall through cleanly)
 * - the wire-message → deps-call mapping (the bits Arc W3's hook
 *   surface depends on; if a dispatcher's mapping drifts, the live
 *   webview silently stops reacting to that message type)
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebviewMessage } from '../../src/types/webviewMessage';
import { dispatchAccountMessage } from '../../src/messageDispatch/accountMessages';
import { dispatchBackgroundTaskMessage } from '../../src/messageDispatch/backgroundTaskMessages';
import { dispatchCoreLifecycleMessage } from '../../src/messageDispatch/coreLifecycle';
import { dispatchTraceMessage } from '../../src/messageDispatch/traceMessages';
import { dispatchVoiceMessage } from '../../src/messageDispatch/voiceMessages';
import { dispatchWorkspaceMessage } from '../../src/messageDispatch/workspaceMessages';

const stubAgentEvent = { type: 'telemetry', timestamp: 0, payload: {} } as const;

// ─── coreLifecycle ──────────────────────────────────────────────────
describe('dispatchCoreLifecycleMessage', () => {
  const mkDeps = () => ({
    handleStateMessage: vi.fn(),
    updateToast: vi.fn(),
    setRequireKey: vi.fn(),
    resolveSkillListPromise: vi.fn()
  });

  it('handles state → calls handleStateMessage(state) and returns true', () => {
    const deps = mkDeps();
    const handled = dispatchCoreLifecycleMessage(
      { type: 'state', state: { foo: 1 } as never } as WebviewMessage,
      deps
    );
    expect(handled).toBe(true);
    expect(deps.handleStateMessage).toHaveBeenCalledWith({ foo: 1 });
  });

  it('handles notification + error via updateToast', () => {
    const deps = mkDeps();
    dispatchCoreLifecycleMessage(
      { type: 'notification', message: 'hi' } as WebviewMessage,
      deps
    );
    dispatchCoreLifecycleMessage(
      { type: 'error', message: 'oops' } as WebviewMessage,
      deps
    );
    expect(deps.updateToast).toHaveBeenCalledTimes(2);
    expect(deps.updateToast).toHaveBeenNthCalledWith(1, 'hi');
    expect(deps.updateToast).toHaveBeenNthCalledWith(2, 'oops');
  });

  it('requireApiKey calls setRequireKey(true)', () => {
    const deps = mkDeps();
    dispatchCoreLifecycleMessage({ type: 'requireApiKey' } as WebviewMessage, deps);
    expect(deps.setRequireKey).toHaveBeenCalledWith(true);
  });

  it('skillList resolves the pending promise with the (possibly empty) skills array', () => {
    const deps = mkDeps();
    dispatchCoreLifecycleMessage(
      { type: 'skillList', skills: 'not-an-array' } as never,
      deps
    );
    expect(deps.resolveSkillListPromise).toHaveBeenCalledWith([]);
  });

  it('returns false for an unrelated message type (falls through to the next dispatcher)', () => {
    const deps = mkDeps();
    const handled = dispatchCoreLifecycleMessage(
      { type: 'playAudio' } as never,
      deps
    );
    expect(handled).toBe(false);
  });
});

// ─── accountMessages ────────────────────────────────────────────────
describe('dispatchAccountMessage', () => {
  const mkDeps = () => ({
    setUsageSnapshot: vi.fn(),
    setUsageStatus: vi.fn(),
    setUsageError: vi.fn(),
    setRateLimitToast: vi.fn(),
    requestAccountUsage: vi.fn(),
    appendContextInjectionSkippedEvent: vi.fn(() => stubAgentEvent),
    appendEvents: vi.fn()
  });

  it('accountUsage success: snapshot + status ready, error cleared', () => {
    const deps = mkDeps();
    dispatchAccountMessage(
      { type: 'accountUsage', data: { plan: 'pro' } as never } as never,
      deps
    );
    expect(deps.setUsageSnapshot).toHaveBeenCalledWith({ plan: 'pro' });
    expect(deps.setUsageError).toHaveBeenCalledWith(null);
    expect(deps.setUsageStatus).toHaveBeenCalledWith('ready');
  });

  it('accountUsage error: status error, snapshot left alone', () => {
    const deps = mkDeps();
    dispatchAccountMessage(
      { type: 'accountUsage', error: 'gateway down', data: null } as never,
      deps
    );
    expect(deps.setUsageError).toHaveBeenCalledWith('gateway down');
    expect(deps.setUsageStatus).toHaveBeenCalledWith('error');
    expect(deps.setUsageSnapshot).not.toHaveBeenCalled();
  });

  it('rateLimited fires the toast AND prefetches account usage', () => {
    const deps = mkDeps();
    dispatchAccountMessage(
      { type: 'rateLimited', window: 'weekly', message: 'slow down' } as never,
      deps
    );
    expect(deps.setRateLimitToast).toHaveBeenCalledWith({
      window: 'weekly',
      resetsAtUnix: undefined,
      message: 'slow down'
    });
    expect(deps.requestAccountUsage).toHaveBeenCalled();
  });

  it('contextInjectionSkipped routes through appendContextInjectionSkippedEvent → appendEvents', () => {
    const deps = mkDeps();
    dispatchAccountMessage(
      { type: 'contextInjectionSkipped', reason: 'budget', prompt: 'p' } as never,
      deps
    );
    expect(deps.appendContextInjectionSkippedEvent).toHaveBeenCalledWith('budget', 'p');
    expect(deps.appendEvents).toHaveBeenCalledWith(stubAgentEvent);
  });

  it('returns false for unrelated message types', () => {
    expect(
      dispatchAccountMessage({ type: 'playAudio' } as never, mkDeps())
    ).toBe(false);
  });
});

// ─── voiceMessages ──────────────────────────────────────────────────
describe('dispatchVoiceMessage', () => {
  const mkDeps = () => ({
    handleVoiceTranscription: vi.fn(),
    handleExtensionMicAvailability: vi.fn(),
    handleExtensionMicError: vi.fn()
  });

  it('voiceTranscription → handleVoiceTranscription(text)', () => {
    const deps = mkDeps();
    dispatchVoiceMessage({ type: 'voiceTranscription', text: 'hi' } as never, deps);
    expect(deps.handleVoiceTranscription).toHaveBeenCalledWith('hi');
  });

  it('extensionMicAvailability → forwards full payload', () => {
    const deps = mkDeps();
    const msg = {
      type: 'extensionMicAvailability',
      available: true,
      kind: 'ffmpeg',
      message: 'ok',
      canAutoInstall: true,
      installerName: 'brew'
    };
    dispatchVoiceMessage(msg as never, deps);
    expect(deps.handleExtensionMicAvailability).toHaveBeenCalledWith(msg);
  });

  it('extensionMicError → forwards { message }', () => {
    const deps = mkDeps();
    dispatchVoiceMessage(
      { type: 'extensionMicError', message: 'no device' } as never,
      deps
    );
    expect(deps.handleExtensionMicError).toHaveBeenCalledWith({
      type: 'extensionMicError',
      message: 'no device'
    });
  });

  it('returns false for unrelated message types', () => {
    expect(dispatchVoiceMessage({ type: 'state' } as never, mkDeps())).toBe(false);
  });
});

// ─── workspaceMessages ──────────────────────────────────────────────
describe('dispatchWorkspaceMessage', () => {
  it('workspaceFileSuggestions → handleWorkspaceFileSuggestions(entries)', () => {
    const handle = vi.fn();
    const entries = [{ path: 'src/foo', isDir: false }];
    const handled = dispatchWorkspaceMessage(
      { type: 'workspaceFileSuggestions', entries } as never,
      { handleWorkspaceFileSuggestions: handle }
    );
    expect(handled).toBe(true);
    expect(handle).toHaveBeenCalledWith(entries);
  });

  it('returns false for unrelated message types', () => {
    expect(
      dispatchWorkspaceMessage(
        { type: 'state' } as never,
        { handleWorkspaceFileSuggestions: vi.fn() }
      )
    ).toBe(false);
  });
});

// ─── backgroundTaskMessages ─────────────────────────────────────────
describe('dispatchBackgroundTaskMessage', () => {
  const mkDeps = () => ({
    setBackgroundTasksList: vi.fn(),
    applyBackgroundTaskUpdate: vi.fn()
  });

  it('backgroundTaskList → setBackgroundTasksList(tasks ?? [])', () => {
    const deps = mkDeps();
    dispatchBackgroundTaskMessage(
      { type: 'backgroundTaskList', tasks: [{ id: 'a' }] } as never,
      deps
    );
    expect(deps.setBackgroundTasksList).toHaveBeenCalledWith([{ id: 'a' }]);
  });

  it('backgroundTaskList with no tasks key seeds an empty list', () => {
    const deps = mkDeps();
    dispatchBackgroundTaskMessage(
      { type: 'backgroundTaskList' } as never,
      deps
    );
    expect(deps.setBackgroundTasksList).toHaveBeenCalledWith([]);
  });

  it('backgroundTaskUpdate → applyBackgroundTaskUpdate(task)', () => {
    const deps = mkDeps();
    const task = { id: 'a', status: 'completed' };
    dispatchBackgroundTaskMessage(
      { type: 'backgroundTaskUpdate', task } as never,
      deps
    );
    expect(deps.applyBackgroundTaskUpdate).toHaveBeenCalledWith(task);
  });

  it('returns false for unrelated message types', () => {
    expect(
      dispatchBackgroundTaskMessage({ type: 'state' } as never, mkDeps())
    ).toBe(false);
  });
});

// ─── traceMessages ──────────────────────────────────────────────────
describe('dispatchTraceMessage', () => {
  const mkDeps = () => ({
    setTracePanelOpen: vi.fn(),
    setTraceViewMode: vi.fn(),
    setTraceList: vi.fn(),
    setTraceLoading: vi.fn(),
    setTraceError: vi.fn(),
    setTraceDetail: vi.fn(),
    requestTraceDetail: vi.fn()
  });

  it('traceList with traces auto-requests detail for the selectedId (or first trace)', () => {
    const deps = mkDeps();
    dispatchTraceMessage(
      {
        type: 'traceList',
        traces: [{ id: 't1' }, { id: 't2' }],
        mode: 'all',
        selectedId: 't2'
      } as never,
      deps
    );
    expect(deps.setTracePanelOpen).toHaveBeenCalledWith(true);
    expect(deps.setTraceViewMode).toHaveBeenCalledWith('all');
    expect(deps.setTraceList).toHaveBeenCalledWith([{ id: 't1' }, { id: 't2' }]);
    expect(deps.setTraceLoading).toHaveBeenLastCalledWith(true);
    expect(deps.requestTraceDetail).toHaveBeenCalledWith('t2');
  });

  it('traceList with no selectedId picks the first trace', () => {
    const deps = mkDeps();
    dispatchTraceMessage(
      { type: 'traceList', traces: [{ id: 'first' }], mode: 'all' } as never,
      deps
    );
    expect(deps.requestTraceDetail).toHaveBeenCalledWith('first');
  });

  it('traceList with empty list clears detail and does not auto-request', () => {
    const deps = mkDeps();
    dispatchTraceMessage(
      { type: 'traceList', traces: [], mode: 'all' } as never,
      deps
    );
    expect(deps.setTraceDetail).toHaveBeenCalledWith(null);
    expect(deps.requestTraceDetail).not.toHaveBeenCalled();
  });

  it('traceDetail → setTraceDetail + clears loading/error', () => {
    const deps = mkDeps();
    const trace = { summary: { id: 't1' } } as never;
    dispatchTraceMessage(
      { type: 'traceDetail', trace } as never,
      deps
    );
    expect(deps.setTraceDetail).toHaveBeenCalledWith(trace);
    expect(deps.setTraceLoading).toHaveBeenCalledWith(false);
    expect(deps.setTraceError).toHaveBeenCalledWith(null);
  });

  it('traceError → sets error + clears loading', () => {
    const deps = mkDeps();
    dispatchTraceMessage(
      { type: 'traceError', message: 'parse fail' } as never,
      deps
    );
    expect(deps.setTraceError).toHaveBeenCalledWith('parse fail');
    expect(deps.setTraceLoading).toHaveBeenCalledWith(false);
  });

  it('returns false for unrelated message types', () => {
    expect(dispatchTraceMessage({ type: 'state' } as never, mkDeps())).toBe(false);
  });
});
