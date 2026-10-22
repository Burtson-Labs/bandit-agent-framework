/**
 * The message queue end to end inside <App/>: typing while a turn runs
 * queues (with an approval card open too, without answering it), Stop puts
 * the queued text back in the composer unsent, and a failed turn does not
 * send the next queued message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BanditProvider } from '@burtson-labs/agent-ui';
import { App } from '../src/App';
import { buildPermissionPayload, mockPostMessage, mockReceiveMessage, type PostMessageRecorder } from './_helpers';

let recorder: PostMessageRecorder;

/** A signed-in Bandit-cloud state, as the host sends it (Acme sample data). */
const banditState = (isBusy: boolean) => ({
  messages: [],
  hasApiKey: true,
  hasStoredApiKey: true,
  requiresApiKey: false,
  isBusy,
  provider: 'bandit',
  model: 'bandit-core-1',
  mode: 'agent',
  history: [],
  hasArchivedConversations: false,
  showHistory: false,
  allowImageUploads: true,
  showIntentChips: false,
  feedbackEnabled: false,
  contextUsage: null,
  accountProfile: { valid: true, firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@acme.example' }
});

const textarea = () => document.querySelector('textarea.composer-textarea') as HTMLTextAreaElement;
const sentPrompts = () =>
  recorder.calls.filter((m) => (m as { type?: string }).type === 'sendPrompt') as Array<{ text: string; turnId: string }>;

function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter' });
}

beforeEach(() => {
  recorder = mockPostMessage();
  render(
    <BanditProvider context="vscode">
      <App />
    </BanditProvider>
  );
  mockReceiveMessage({ type: 'state', state: banditState(false) });
});

afterEach(() => {
  cleanup();
});

describe('message queue in the chat', () => {
  it('keeps the composer up while an approval card is open, and queues without answering it', async () => {
    type('add a test');
    await waitFor(() => expect(sentPrompts()).toHaveLength(1));
    mockReceiveMessage({ type: 'state', state: banditState(true) });
    mockReceiveMessage(buildPermissionPayload({ id: 'perm-1', description: 'acme-approval-marker' }));
    await waitFor(() => expect(screen.getByText('acme-approval-marker')).toBeTruthy());
    expect(textarea()).toBeTruthy();

    type('then run it');
    await waitFor(() => expect(screen.getByText('then run it')).toBeTruthy());
    expect(sentPrompts()).toHaveLength(1);
    expect(recorder.calls.some((m) => (m as { type?: string }).type === 'permissionResponse')).toBe(false);
    expect(screen.getByText('acme-approval-marker')).toBeTruthy();
  });

  it('Stop puts the queued messages back in the composer, unsent', async () => {
    type('add a test');
    await waitFor(() => expect(sentPrompts()).toHaveLength(1));
    mockReceiveMessage({ type: 'state', state: banditState(true) });
    type('then run it');
    type('and commit');
    await waitFor(() => expect(screen.getByText('and commit')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(recorder.calls).toContainEqual({ type: 'cancelResponse' });
    await waitFor(() => expect(textarea().value).toBe('then run it\n\nand commit'));

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'promptSettled', turnId: sentPrompts()[0].turnId, outcome: 'cancelled' }
      }));
    });
    mockReceiveMessage({ type: 'state', state: banditState(false) });
    expect(sentPrompts()).toHaveLength(1);
  });

  it('a failed turn stops the queue and hands the message back', async () => {
    type('add a test');
    await waitFor(() => expect(sentPrompts()).toHaveLength(1));
    mockReceiveMessage({ type: 'state', state: banditState(true) });
    type('then run it');
    await waitFor(() => expect(screen.getByText('then run it')).toBeTruthy());

    mockReceiveMessage({ type: 'error', message: 'Bandit tool agent error: upstream 500' });
    mockReceiveMessage({ type: 'state', state: banditState(false) });
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'promptSettled', turnId: sentPrompts()[0].turnId, outcome: 'failed' }
      }));
    });
    await waitFor(() => expect(textarea().value).toBe('then run it'));
    expect(sentPrompts()).toHaveLength(1);
  });

  it('edit takes a queued message back into the composer', async () => {
    type('add a test');
    await waitFor(() => expect(sentPrompts()).toHaveLength(1));
    mockReceiveMessage({ type: 'state', state: banditState(true) });
    type('then run it');
    await waitFor(() => expect(screen.getByText('then run it')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit this queued message' }));
    await waitFor(() => expect(textarea().value).toBe('then run it'));
    expect(screen.queryByRole('button', { name: 'Edit this queued message' })).toBeNull();
  });

  it('Stop with an approval card open denies it and takes the card down', async () => {
    type('add a test');
    await waitFor(() => expect(sentPrompts()).toHaveLength(1));
    mockReceiveMessage({ type: 'state', state: banditState(true) });
    mockReceiveMessage(buildPermissionPayload({ id: 'perm-stop', description: 'acme-stop-marker' }));
    await waitFor(() => expect(screen.getByText('acme-stop-marker')).toBeTruthy());
    type('queued behind the card');
    await waitFor(() => expect(screen.getByText('queued behind the card')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(recorder.calls).toContainEqual({ type: 'cancelResponse' });
    expect(recorder.calls).toContainEqual(expect.objectContaining({ type: 'permissionResponse', id: 'perm-stop', choice: 'deny' }));
    await waitFor(() => expect(screen.queryByText('acme-stop-marker')).toBeNull());
    await waitFor(() => expect(textarea().value).toBe('queued behind the card'));
  });
});

