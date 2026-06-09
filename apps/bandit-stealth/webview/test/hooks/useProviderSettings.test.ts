/**
 * Arc W6.1 — contract tests for useProviderSettings.
 *
 * Pins:
 * - the same-provider no-op (so a click on the active toggle doesn't
 *   re-post setProvider)
 * - the model-label retracking when the provider switches (composer
 *   chip needs to show the new provider's model name)
 * - the wire-format for each outbound action
 * - the applyStateSnapshot fan-out from a WebviewState boot message
 *   (the slice that handleStateMessage in App.tsx used to do inline)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useProviderSettings } from '../../src/hooks/useProviderSettings';
import type { WebviewState } from '../../src/types/webview';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
});

describe('useProviderSettings', () => {
  it('initial defaults: ollama provider, gemma4:12b model, empty drafts', () => {
    const { result } = renderHook(() => useProviderSettings());
    expect(result.current.providerKind).toBe('ollama');
    expect(result.current.providerLabel).toBe('Ollama');
    expect(result.current.banditModelName).toBe('bandit-core-1');
    expect(result.current.ollamaModelName).toBe('gemma4:12b');
    expect(result.current.modelLabel).toBe('gemma4:12b');
    expect(result.current.ollamaBaseUrlDraft).toBe('');
    expect(result.current.ollamaAuthDraft).toBe('');
    expect(result.current.hasOllamaAuthToken).toBe(false);
    expect(result.current.ollamaStatus).toBe('unknown');
    expect(result.current.ollamaModelMissing).toBeUndefined();
  });

  it('handleSelectProvider posts setProvider AND retracks modelLabel to the new provider', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.handleSelectProvider('bandit'));
    expect(result.current.providerKind).toBe('bandit');
    expect(result.current.providerLabel).toBe('Bandit AI');
    expect(result.current.modelLabel).toBe('bandit-core-1');
    expect(recorder.calls).toEqual([{ type: 'setProvider', value: 'bandit' }]);
  });

  it('handleSelectProvider for the same provider is a no-op (no wire post)', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.handleSelectProvider('ollama'));
    expect(recorder.calls).toEqual([]);
  });

  it('handleSelectProvider("openai-compatible") flips state but does NOT change modelLabel (model comes from workspace config)', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.handleSelectProvider('openai-compatible'));
    expect(result.current.providerKind).toBe('openai-compatible');
    expect(result.current.providerLabel).toBe('OpenAI-compatible');
    // modelLabel stays at the previous provider's value — the next
    // syncState message updates it.
    expect(result.current.modelLabel).toBe('gemma4:12b');
  });

  it('handleEditModel + handleEditOllamaUrl post the right wire messages', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.handleEditModel());
    act(() => result.current.handleEditOllamaUrl());
    expect(recorder.calls).toEqual([
      { type: 'editModel' },
      { type: 'editOllamaUrl' }
    ]);
  });

  it('handleSaveOllamaBaseUrl trims whitespace before posting', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.setOllamaBaseUrlDraft('   http://ollama.local:11434   '));
    act(() => result.current.handleSaveOllamaBaseUrl());
    expect(recorder.calls).toEqual([
      { type: 'setOllamaBaseUrl', value: 'http://ollama.local:11434' }
    ]);
  });

  it('handleResetOllamaBaseUrl restores localhost AND posts it', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.setOllamaBaseUrlDraft('http://other.example'));
    act(() => result.current.handleResetOllamaBaseUrl());
    expect(result.current.ollamaBaseUrlDraft).toBe('http://localhost:11434');
    expect(recorder.calls.at(-1)).toEqual({
      type: 'setOllamaBaseUrl',
      value: 'http://localhost:11434'
    });
  });

  it('handleSaveOllamaAuth posts when non-empty AND clears the draft', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.setOllamaAuthDraft('  abc123  '));
    act(() => result.current.handleSaveOllamaAuth());
    expect(result.current.ollamaAuthDraft).toBe('');
    expect(recorder.calls).toEqual([
      { type: 'setOllamaAuthToken', value: 'abc123' }
    ]);
  });

  it('handleSaveOllamaAuth with empty/whitespace-only draft is a no-op (does not post)', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.setOllamaAuthDraft('   '));
    act(() => result.current.handleSaveOllamaAuth());
    expect(recorder.calls).toEqual([]);
  });

  it('handleClearOllamaAuth posts clearOllamaAuthToken AND clears the draft', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() => result.current.setOllamaAuthDraft('keep-me'));
    act(() => result.current.handleClearOllamaAuth());
    expect(result.current.ollamaAuthDraft).toBe('');
    expect(recorder.calls).toEqual([{ type: 'clearOllamaAuthToken' }]);
  });

  it('applyStateSnapshot fans out a WebviewState into every provider slot in one call', () => {
    const { result } = renderHook(() => useProviderSettings());
    const state = {
      provider: 'bandit',
      model: 'custom-bandit-model',
      ollamaModel: 'qwen-25b',
      ollamaUrl: '   http://192.168.1.50:11434  ',
      ollamaStatus: 'ready',
      ollamaModelMissing: undefined,
      hasOllamaAuthToken: true
    } as unknown as WebviewState;
    act(() => result.current.applyStateSnapshot(state));
    expect(result.current.providerKind).toBe('bandit');
    expect(result.current.providerLabel).toBe('Bandit AI');
    expect(result.current.banditModelName).toBe('custom-bandit-model');
    expect(result.current.ollamaModelName).toBe('qwen-25b');
    expect(result.current.modelLabel).toBe('custom-bandit-model');
    expect(result.current.ollamaBaseUrlDraft).toBe('http://192.168.1.50:11434');
    expect(result.current.hasOllamaAuthToken).toBe(true);
    expect(result.current.ollamaStatus).toBe('ready');
  });

  it('applyStateSnapshot defaults provider to "bandit" when the field is unrecognized', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() =>
      result.current.applyStateSnapshot({
        provider: 'weird-future-provider'
      } as unknown as WebviewState)
    );
    expect(result.current.providerKind).toBe('bandit');
    expect(result.current.providerLabel).toBe('Bandit AI');
  });

  it('applyStateSnapshot sets modelLabel to the OLLAMA model when provider is ollama', () => {
    const { result } = renderHook(() => useProviderSettings());
    act(() =>
      result.current.applyStateSnapshot({
        provider: 'ollama',
        model: 'should-not-show',
        ollamaModel: 'should-show:13b'
      } as unknown as WebviewState)
    );
    expect(result.current.modelLabel).toBe('should-show:13b');
  });
});
