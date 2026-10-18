import { describe, expect, it, vi } from 'vitest';
import { dispatchViewMessage } from '../../src/messageDispatch/viewMessages';
import type { WebviewMessage } from '../../src/types/webviewMessage';

describe('dispatchViewMessage', () => {
  it('routes a valid viewAction', () => {
    const runViewAction = vi.fn();
    expect(dispatchViewMessage({ type: 'viewAction', action: 'toggleHistory' }, { runViewAction })).toBe(true);
    expect(runViewAction).toHaveBeenCalledWith('toggleHistory');
  });

  it('claims but ignores an unknown action', () => {
    const runViewAction = vi.fn();
    expect(dispatchViewMessage({ type: 'viewAction', action: 'rm -rf' }, { runViewAction })).toBe(true);
    expect(runViewAction).not.toHaveBeenCalled();
  });

  it('treats the host openSettings push as openSettings', () => {
    const runViewAction = vi.fn();
    expect(dispatchViewMessage({ type: 'openSettings' }, { runViewAction })).toBe(true);
    expect(runViewAction).toHaveBeenCalledWith('openSettings');
  });

  it('leaves other messages to the other dispatchers', () => {
    const runViewAction = vi.fn();
    expect(dispatchViewMessage({ type: 'notification', message: 'hi' } as WebviewMessage, { runViewAction })).toBe(false);
    expect(runViewAction).not.toHaveBeenCalled();
  });
});
