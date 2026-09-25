import { describe, expect, it } from 'vitest';

import {
  PermissionCard,
  type BanditPermissionPayload,
  type PermissionCardStatus,
  type PermissionChoice
} from '../src/components/PermissionCard';
import { buttonNamed, click, key, mount, rerender } from './_dom';

const payload = (id = 'perm-1'): BanditPermissionPayload => ({
  type: 'bandit:permission',
  id,
  tool: 'run_command',
  primary: 'npm test',
  description: 'Run the tests',
  command: 'npm test',
  risk: 'Runs a shell command'
});

type Call = [string, PermissionChoice, string | undefined];

describe('PermissionCard (uncontrolled)', () => {
  it('reports a choice once, even on a double click', () => {
    const calls: Call[] = [];
    const el = mount(<PermissionCard payload={payload()} onChoice={(...a) => calls.push(a)} />);
    const once = buttonNamed(el, 'Allow once');
    click(once);
    click(once);
    expect(calls).toEqual([['perm-1', 'once', undefined]]);
    expect(el.textContent).toContain('Allowed once');
  });

  it('a key shortcut then Escape in the same burst sends one decision', () => {
    const calls: Call[] = [];
    const el = mount(<PermissionCard payload={payload()} onChoice={(...a) => calls.push(a)} />);
    const card = el.querySelector('.permission-card')!;
    key(card, '2');
    key(card, 'Escape');
    expect(calls).toEqual([['perm-1', 'session', undefined]]);
  });

  it('uses buttons, not radios, for choices that act immediately', () => {
    const el = mount(<PermissionCard payload={payload()} onChoice={() => {}} />);
    expect(el.querySelector('[role="radio"]')).toBeNull();
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();
    expect(el.querySelector('textarea')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('a new request resets the card', () => {
    const calls: Call[] = [];
    const onChoice = (...a: Call): void => { calls.push(a); };
    const el = mount(<PermissionCard payload={payload('a')} onChoice={onChoice} />);
    click(buttonNamed(el, 'Allow once'));
    rerender(<PermissionCard payload={payload('b')} onChoice={onChoice} />);
    click(buttonNamed(el, 'Deny'));
    expect(calls.map((c) => c[0] + ':' + c[1])).toEqual(['a:once', 'b:deny']);
  });
});

describe('PermissionCard (host-controlled)', () => {
  const render = (status: PermissionCardStatus, calls: Call[]): HTMLElement =>
    mount(<PermissionCard payload={payload()} status={status} onChoice={(...a) => calls.push(a)} />);

  it('stays pending until the host moves it, and never fires twice', () => {
    const calls: Call[] = [];
    const el = render({ state: 'pending' }, calls);
    click(buttonNamed(el, 'Always allow'));
    click(buttonNamed(el, 'Allow once'));
    expect(calls).toEqual([['perm-1', 'save', undefined]]);
    // The card does not claim anything was saved on its own.
    expect(el.textContent).not.toContain('saved');
  });

  it('shows submitting as busy with choices disabled', () => {
    const el = render({ state: 'submitting', choice: 'once' }, []);
    expect(el.querySelector('.permission-card')?.getAttribute('aria-busy')).toBe('true');
    expect(buttonNamed(el, 'Allow session').disabled).toBe(true);
    expect(el.textContent).toContain('Sending approval');
  });

  it('only names a saved location the host confirmed', () => {
    const el = render({ state: 'resolved', choice: 'save', savedTo: '.bandit/settings.json' }, []);
    expect(el.textContent).toContain('saved to .bandit/settings.json');
    rerender(<PermissionCard payload={payload()} status={{ state: 'resolved', choice: 'save' }} onChoice={() => {}} />);
    expect(el.textContent).toContain('Always allowed');
    expect(el.textContent).not.toContain('saved to');
  });

  it('an error lets the user retry once', () => {
    const calls: Call[] = [];
    const onChoice = (...a: Call): void => { calls.push(a); };
    const el = mount(<PermissionCard payload={payload()} status={{ state: 'pending' }} onChoice={onChoice} />);
    click(buttonNamed(el, 'Allow once'));
    rerender(<PermissionCard payload={payload()} status={{ state: 'error', message: 'Connection lost.' }} onChoice={onChoice} />);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Connection lost.');
    click(buttonNamed(el, 'Allow once'));
    click(buttonNamed(el, 'Allow once'));
    expect(calls).toHaveLength(2);
  });

  it('an expired request cannot be decided', () => {
    const calls: Call[] = [];
    const el = render({ state: 'expired' }, calls);
    click(buttonNamed(el, 'Allow once'));
    key(el.querySelector('.permission-card')!, '1');
    expect(calls).toEqual([]);
    expect(el.textContent).toContain('no longer waiting');
    expect(el.querySelector('textarea')).toBeNull();
  });
});
