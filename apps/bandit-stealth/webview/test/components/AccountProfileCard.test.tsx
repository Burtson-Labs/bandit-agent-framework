import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountProfileCard, accountInitials } from '../../src/components/AccountProfileCard';

afterEach(() => cleanup());

const profile = {
  valid: true,
  firstName: 'Alex',
  lastName: 'Rivera',
  email: 'alex.rivera@acme.example',
  plan: 'Pro',
  credits: 1200,
  maskedKey: 'bai_****acme01',
  isAdmin: true
};

describe('AccountProfileCard', () => {
  it('renders the account as a compact row with badges and the masked key', () => {
    render(<AccountProfileCard profile={profile} status="idle" error={null} onRefresh={() => undefined} />);
    expect(screen.getByText('Alex Rivera')).toBeTruthy();
    expect(screen.getByText('alex.rivera@acme.example')).toBeTruthy();
    expect(screen.getByText('Pro')).toBeTruthy();
    expect(screen.getByText('Admin key')).toBeTruthy();
    expect(screen.getByText('Credits 1,200')).toBeTruthy();
    expect(screen.getByText('bai_****acme01')).toBeTruthy();
  });

  it('never renders a key beyond the masked form it was given', () => {
    const { container } = render(
      <AccountProfileCard profile={profile} status="idle" error={null} onRefresh={() => undefined} />
    );
    expect(container.textContent).not.toMatch(/bai_[A-Za-z0-9]{8,}/);
  });

  it('has a labelled refresh icon button', () => {
    const onRefresh = vi.fn();
    render(<AccountProfileCard profile={profile} status="idle" error={null} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh account' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('builds initials from the name, or the email', () => {
    expect(accountInitials({ firstName: 'Alex', lastName: 'Rivera' })).toBe('AR');
    expect(accountInitials({ email: 'ops@acme.example' })).toBe('O');
    expect(accountInitials({})).toBe('?');
  });
});
