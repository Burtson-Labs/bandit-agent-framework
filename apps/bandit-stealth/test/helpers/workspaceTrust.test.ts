/**
 * The notice for a folder whose .bandit settings host-kit partly ignored:
 * what it says, that it shows once per folder per window, that "Trust this
 * folder" goes through the trust command and nothing else trusts, and that
 * VS Code's Restricted Mode removes the offer.
 */
import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import {
  NOT_NOW_ACTION,
  TRUST_ACTION,
  buildUntrustedSettingsNotice,
  createUntrustedSettingsNotifier,
  describeIgnored
} from '../../src/helpers/workspaceTrust';

const root = path.resolve('/work/acme-app');
const settingsFile = path.join(root, '.bandit', 'settings.json');
const localFile = path.join(root, '.bandit', 'settings.local.json');

describe('buildUntrustedSettingsNotice', () => {
  it('is silent when nothing was ignored', () => {
    expect(buildUntrustedSettingsNotice(root, {})).toBeNull();
    expect(buildUntrustedSettingsNotice(root, { ignoredUntrusted: [] })).toBeNull();
    expect(buildUntrustedSettingsNotice(root, { ignoredUntrusted: [{ file: settingsFile, keys: [] }] })).toBeNull();
  });

  it('names the file and what was ignored', () => {
    const notice = buildUntrustedSettingsNotice(root, {
      ignoredUntrusted: [{ file: settingsFile, keys: ['hooks', 'permissions.mode'], hookCount: 3 }]
    });
    expect(notice?.files).toEqual([settingsFile]);
    expect(notice?.message).toBe(
      'Bandit ignored part of .bandit/settings.json in "acme-app": 3 hooks, permissions.mode. ' +
      'Until you trust this folder, its .bandit settings can only narrow what Bandit does.'
    );
  });

  it('lists both files when settings.json and settings.local.json were trimmed', () => {
    const notice = buildUntrustedSettingsNotice(root, {
      ignoredUntrusted: [
        { file: settingsFile, keys: ['hooks'], hookCount: 1 },
        { file: localFile, keys: ['permissions.allow', 'security.guard.enabled'] }
      ]
    });
    expect(notice?.message).toContain(
      '.bandit/settings.json (1 hook) and .bandit/settings.local.json (permissions.allow, security.guard.enabled) in "acme-app".'
    );
  });

  it('describes hooks without a count when host-kit gave none', () => {
    expect(describeIgnored({ file: settingsFile, keys: ['hooks', 'permissions.allow'] })).toBe('hooks, permissions.allow');
  });
});

describe('createUntrustedSettingsNotifier', () => {
  const ignored = { ignoredUntrusted: [{ file: settingsFile, keys: ['hooks'], hookCount: 2 }] };

  function make(opts: { choice?: string; editorTrusted?: boolean } = {}) {
    const show = vi.fn(async (_message: string, ..._actions: string[]) => opts.choice);
    const trust = vi.fn(async () => undefined);
    const notifier = createUntrustedSettingsNotifier({
      editorTrusted: () => opts.editorTrusted ?? true,
      show,
      trust
    });
    return { notifier, show, trust };
  }

  it('shows nothing when nothing was ignored', async () => {
    const { notifier, show } = make();
    expect(await notifier.maybeNotify(root, { ignoredUntrusted: [] })).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('offers Trust this folder and Not now, and does not trust on Not now', async () => {
    const { notifier, show, trust } = make({ choice: NOT_NOW_ACTION });
    expect(await notifier.maybeNotify(root, ignored)).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.stringContaining('2 hooks'), TRUST_ACTION, NOT_NOW_ACTION);
    expect(trust).not.toHaveBeenCalled();
  });

  it('does not trust when the notice is dismissed', async () => {
    const { notifier, trust } = make({ choice: undefined });
    await notifier.maybeNotify(root, ignored);
    expect(trust).not.toHaveBeenCalled();
  });

  it('runs the trust command only when Trust this folder is chosen', async () => {
    const { notifier, trust } = make({ choice: TRUST_ACTION });
    await notifier.maybeNotify(root, ignored);
    expect(trust).toHaveBeenCalledTimes(1);
  });

  it('mentions a folder once per window, however many turns run', async () => {
    const { notifier, show } = make({ choice: NOT_NOW_ACTION });
    expect(await notifier.maybeNotify(root, ignored)).toBe(true);
    expect(await notifier.maybeNotify(root, ignored)).toBe(false);
    expect(await notifier.maybeNotify(`${root}${path.sep}`, ignored)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    // A different folder gets its own notice.
    expect(await notifier.maybeNotify(path.resolve('/work/other'), ignored)).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('does not offer to trust while VS Code has the workspace in Restricted Mode', async () => {
    const { notifier, show, trust } = make({ choice: TRUST_ACTION, editorTrusted: false });
    expect(await notifier.maybeNotify(root, ignored)).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0].slice(1)).toEqual([]);
    expect(show.mock.calls[0][0]).toContain('Restricted Mode');
    expect(trust).not.toHaveBeenCalled();
  });
});
